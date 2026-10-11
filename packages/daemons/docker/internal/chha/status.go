package chha

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// statusQuery is one row of the member's state (TabSeparated).
const statusQuery = `SELECT
 (SELECT ifNull(toString(any(value)), '') FROM system.settings_profile_elements WHERE profile_name = '` + ClientProfile + `' AND setting_name = 'readonly') AS ro,
 (SELECT count() FROM system.replicas) AS tables,
 (SELECT countIf(is_readonly) FROM system.replicas) AS readonly_tables,
 (SELECT toUInt64(ifNull(max(absolute_delay), 0)) FROM system.replicas) AS delay,
 (SELECT toUInt64(ifNull(min(active_replicas), 0)) FROM system.replicas) AS min_active,
 (SELECT toUInt64(ifNull(sum(queue_size), 0)) FROM system.replicas) AS queue,
 (SELECT toString(value) FROM system.settings WHERE name = 'insert_quorum') AS quorum,
 (SELECT toUInt64(ifNull(any(free_space), 0)) FROM system.disks WHERE name = 'default') AS free,
 (SELECT toUInt64(ifNull(any(total_space), 0)) FROM system.disks WHERE name = 'default') AS total
FORMAT TabSeparated`

// engineRow is the parsed status row.
type engineRow struct {
	readonlyProfile string
	tables          int
	readonlyTables  int
	delay           time.Duration
	minActive       int
	queue           uint64
	quorum          int
	freeBytes       uint64
	totalBytes      uint64
}

func parseStatusRow(text string) (engineRow, error) {
	line := strings.TrimRight(strings.TrimSpace(text), "\r")
	fields := strings.Split(line, "\t")
	if len(fields) != 9 {
		return engineRow{}, fmt.Errorf("unexpected status row (%d fields)", len(fields))
	}
	numbers := make([]uint64, 0, 8)
	for _, index := range []int{1, 2, 3, 4, 5, 7, 8} {
		value, err := strconv.ParseUint(strings.TrimSpace(fields[index]), 10, 64)
		if err != nil {
			return engineRow{}, fmt.Errorf("status field %d: %w", index, err)
		}
		numbers = append(numbers, value)
	}
	quorum, _ := strconv.Atoi(strings.TrimSpace(fields[6]))
	return engineRow{
		readonlyProfile: strings.TrimSpace(fields[0]), tables: int(numbers[0]), readonlyTables: int(numbers[1]),
		delay: time.Duration(numbers[2]) * time.Second, minActive: int(numbers[3]), queue: numbers[4], quorum: quorum,
		freeBytes: numbers[5], totalBytes: numbers[6],
	}, nil
}

// writable: the client profile is not read-only.
func (r engineRow) writable() bool { return r.readonlyProfile == "0" }

// keeperModes the srvr answer names when the Keeper serves (has a quorum).
func keeperServing(mode string) bool {
	switch mode {
	case "leader", "follower", "standalone":
		return true
	}
	return false
}

// probeKeeper asks a Keeper's client port for its mode (srvr). A Keeper
// without quorum answers "This instance is not currently serving requests".
func probeKeeper(ctx context.Context, address string) (string, error) {
	answer, err := keeperFourLetter(ctx, address, "srvr")
	if err != nil {
		return "", err
	}
	return parseKeeperMode(answer)
}

// keeperFourLetter sends one four-letter command to a Keeper client port.
func keeperFourLetter(ctx context.Context, address, command string) (string, error) {
	var dialer net.Dialer
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return "", err
	}
	defer connection.Close()
	deadline := time.Now().Add(2 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = connection.SetDeadline(deadline)
	if _, err := connection.Write([]byte(command)); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(connection, 64<<10))
	if err != nil && len(data) == 0 {
		return "", err
	}
	return string(data), nil
}

func parseKeeperMode(answer string) (string, error) {
	scanner := bufio.NewScanner(strings.NewReader(answer))
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if ok && strings.TrimSpace(key) == "Mode" {
			return strings.TrimSpace(value), nil
		}
	}
	if strings.Contains(answer, "not currently serving") {
		return "not_serving", nil
	}
	return "", errors.New("the Keeper did not report its mode")
}

// toStatus maps a sample to the framework's engine status.
func toStatus(row engineRow, mode string, dbSyncing bool, voters string, extra map[string]string) memberha.EngineStatus {
	serving := keeperServing(mode)
	status := memberha.EngineStatus{
		Answering: true, Writable: row.writable(),
		Streaming:  !row.writable() && serving && row.readonlyTables == 0 && !dbSyncing,
		LagSeconds: row.delay.Seconds(), DiskFreeBytes: row.freeBytes,
		Position: map[string]string{
			posQuorum: strconv.Itoa(row.quorum), posMinActive: strconv.Itoa(row.minActive),
			posTables: strconv.Itoa(row.tables), posReadonly: strconv.Itoa(row.readonlyTables),
			posDelay: strconv.FormatInt(int64(row.delay/time.Second), 10), posKeeper: mode,
			posDatabasesLate: strconv.FormatBool(dbSyncing), "replicationQueue": strconv.FormatUint(row.queue, 10),
		},
	}
	if voters != "" {
		status.Position[posKeeperVoters] = voters
	}
	for key, value := range extra {
		status.Position[key] = value
	}
	if row.quorum >= 2 {
		status.SyncState = "sync"
	} else {
		status.SyncState = "async"
	}
	// A full disk alerts and is never a release reason (decision 17).
	if row.totalBytes > 0 && (row.freeBytes < 256<<20 || row.freeBytes*100 < row.totalBytes) {
		status.DiskFull = true
		status.Detail = "the ClickHouse data disk is almost full"
	}
	return status
}

// sampleOf reads the value logic's inputs back from a status (the lease
// callbacks get the status, never the engine).
func sampleOf(status memberha.EngineStatus) sample {
	atoi := func(key string) int {
		value, _ := strconv.Atoi(status.Position[key])
		return value
	}
	return sample{
		quorum: atoi(posQuorum), minActive: atoi(posMinActive), tables: atoi(posTables), readonly: atoi(posReadonly),
		delay: time.Duration(atoi(posDelay)) * time.Second, keeperQuorum: keeperServing(status.Position[posKeeper]),
		keeperMode: status.Position[posKeeper],
		dbSyncing:  status.Position[posDatabasesLate] == "true",
	}
}
