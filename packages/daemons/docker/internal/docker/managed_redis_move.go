package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"hash/fnv"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	mobyclient "github.com/moby/moby/client"
)

// Moving a key-value store from Redis to Valkey.
//
// Valkey cannot load the files Redis 8 writes (RDB format 12+ and Redis-only
// encodings), so the keys are copied logically: with client writes paused on
// the running Redis (reads keep working), every key is read with type-aware
// commands and written as the commands that rebuild it into a dump file on
// the store's disk. Redis is then stopped and kept aside, unchanged, with its
// data in redis-data; a Valkey container is created on an empty valkey-data,
// the dump is replayed into it and the key counts are compared. Any failure
// before Redis stops changes nothing ("was not moved to Valkey", the
// controller keeps the store ready); any failure after it removes the Valkey
// container and starts the same Redis container again on its untouched data.
// Only a verified move removes the Redis container and its data.
//
// Copied: strings, lists, sets, sorted sets, hashes (with field expirations),
// streams (entries, last ID, consumer groups with their last delivered ID;
// pending entries and consumers are not kept), JSON documents, key
// expirations, every logical database, Redis Functions libraries and the ACL
// users. Refused before anything changes: Bloom and cuckoo filters, time
// series, vector sets, search indexes and any other module type, whose
// formats Valkey does not share.

const (
	// redisMovePauseMillis bounds the write pause should the daemon stop
	// during a move: Redis resumes writes on its own afterwards.
	redisMovePauseMillis = 30 * 60 * 1000
	redisMoveDumpName    = "valkey-move.resp"
	redisMoveScanCount   = "1000"
	redisMoveChunk       = 1000
)

// redisMoveCopyableTypes are the TYPE answers the copy rebuilds.
var redisMoveCopyableTypes = map[string]bool{
	"string": true, "list": true, "set": true, "zset": true, "hash": true, "stream": true, "ReJSON-RL": true,
}

// redisMoveTypeNames names the module types a move refuses.
var redisMoveTypeNames = map[string]string{
	"MBbloom--": "Bloom filters",
	"MBbloomCF": "cuckoo filters",
	"TSDB-TYPE": "time series",
	"vectorset": "vector sets",
	"TopK-TYPE": "top-k sketches",
	"CMSk-TYPE": "count-min sketches",
	"TDIS-TYPE": "t-digests",
}

func redisMoveNotMoved(err error) error {
	return fmt.Errorf("the key-value store was not moved to Valkey: %w", err)
}

// moveRedisToValkey replaces the Redis container of a key-value store with a
// Valkey container holding the same keys (see the comment at the top).
func (m *managedDatabaseManager) moveRedisToValkey(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	if err := m.recoverInterruptedValkeyMove(ctx, record, input); err != nil {
		return redisMoveNotMoved(err)
	}
	// The Valkey image is on the node before anything pauses.
	if _, err := m.client.EnsureThirdPartyImage(ctx, input.Image); err != nil {
		return redisMoveNotMoved(err)
	}
	address, err := m.managedContainerAddress(ctx, record.ContainerID, record.NetworkName)
	if err != nil {
		return redisMoveNotMoved(fmt.Errorf("the store must be running: %w", err))
	}
	source, err := dialRedisMove(ctx, address, input.OwnerPassword)
	if err != nil {
		return redisMoveNotMoved(fmt.Errorf("connect to Redis: %w", err))
	}
	defer source.close()
	databases, err := source.keyspaceDatabases(ctx)
	if err != nil {
		return redisMoveNotMoved(err)
	}
	inventory, err := source.inventory(ctx, databases)
	if err != nil {
		return redisMoveNotMoved(err)
	}
	if err := inventory.refuseMove(input.AcceptPendingStreamLoss); err != nil {
		return redisMoveNotMoved(err)
	}
	dumpPath := filepath.Join(record.MountPath, redisMoveDumpName)
	// Writes pause here; reads, the write-free SAVE and the copy go on.
	if _, err := source.do(ctx, "CLIENT", "PAUSE", strconv.Itoa(redisMovePauseMillis), "WRITE"); err != nil {
		return redisMoveNotMoved(fmt.Errorf("pause writes: %w", err))
	}
	unpause := func() {
		unpauseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := source.do(unpauseCtx, "CLIENT", "UNPAUSE"); err != nil {
			m.logger.Warn("resume writes on Redis after a move that did not happen", "id", record.ID, "error", err)
		}
	}
	started := time.Now()
	dump, err := writeRedisMoveDump(ctx, source, dumpPath, databases)
	if err == nil {
		// The ACL users go with the store; SAVE leaves Redis' own files
		// current, so the Redis store kept aside starts with every key.
		err = m.runManagedDatabaseExec(ctx, record.ContainerID, []string{"sh", "-ec", redisACLFileSnapshotCommand()}, "", []string{"REDISCLI_AUTH=" + input.OwnerPassword})
		if err != nil {
			err = fmt.Errorf("save the ACL users: %w", err)
		}
	}
	if err == nil {
		if _, err = source.do(ctx, "SAVE"); err != nil {
			err = fmt.Errorf("save the Redis data: %w", err)
		}
	}
	if err == nil && time.Since(started) > time.Duration(redisMovePauseMillis)*time.Millisecond*9/10 {
		err = errors.New("copying the keys took longer than the write pause")
	}
	if err != nil {
		unpause()
		_ = os.Remove(dumpPath)
		return redisMoveNotMoved(err)
	}
	m.logger.Info("copied the keys of a Redis key-value store for its move to Valkey", "id", record.ID, "keys", dump.totalKeys(), "duration", time.Since(started).Round(time.Millisecond).String())
	return m.switchRedisToValkey(ctx, record, input, dump, unpause)
}

// switchRedisToValkey stops Redis (kept aside), starts Valkey on its own data
// directory, replays the dump and verifies it; on failure Redis comes back.
func (m *managedDatabaseManager) switchRedisToValkey(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand, dump *redisMoveDump, unpause func()) error {
	previous := *record
	rollbackName := previous.ContainerName + "-rollback"
	defer func() { _ = os.Remove(dump.path) }()
	if err := m.stopContainer(ctx, previous.ContainerID); err != nil {
		unpause()
		return redisMoveNotMoved(err)
	}
	if err := m.client.RenameContainer(ctx, previous.ContainerID, rollbackName); err != nil {
		if startErr := m.startContainer(ctx, previous.ContainerID); startErr != nil {
			return fmt.Errorf("moving the key-value store to Valkey failed and Redis could not be started again: %v (%w)", startErr, err)
		}
		return redisMoveNotMoved(fmt.Errorf("set the Redis container aside: %w", err))
	}
	valkeyData := managedRedisDataPath(*record, input.Image)
	rollback := func(cause error) error {
		*record = previous
		rollbackCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout+managedDatabaseReadinessTimeout)
		defer cancel()
		if current, err := m.client.cli.ContainerInspect(rollbackCtx, previous.ContainerName, mobyclient.ContainerInspectOptions{}); err == nil && current.Container.ID != previous.ContainerID {
			if err := m.client.RemoveContainer(rollbackCtx, current.Container.ID, true); err != nil && !cerrdefs.IsNotFound(err) {
				return fmt.Errorf("moving the key-value store to Valkey failed (%v) and its Valkey container could not be removed: %w", cause, err)
			}
		}
		if err := os.RemoveAll(valkeyData); err != nil {
			m.logger.Warn("remove the Valkey data of a move that did not happen", "id", previous.ID, "error", err)
		}
		if err := m.client.RenameContainer(rollbackCtx, previous.ContainerID, previous.ContainerName); err != nil {
			return fmt.Errorf("moving the key-value store to Valkey failed (%v) and the Redis container could not be renamed back: %w", cause, err)
		}
		if err := m.startContainer(rollbackCtx, previous.ContainerID); err != nil {
			return fmt.Errorf("moving the key-value store to Valkey failed (%v) and Redis could not be started again: %w", cause, err)
		}
		if err := m.waitForDatabaseReady(rollbackCtx, previous.ContainerID, input); err != nil {
			return fmt.Errorf("moving the key-value store to Valkey failed (%v) and Redis did not become ready again: %w", cause, err)
		}
		return fmt.Errorf("the key-value store was not moved to Valkey and runs Redis again: %w", cause)
	}
	if err := os.RemoveAll(valkeyData); err != nil {
		return rollback(fmt.Errorf("clear the Valkey data directory: %w", err))
	}
	if err := copyRedisMoveACL(managedRedisDataPath(previous, ""), valkeyData); err != nil {
		return rollback(err)
	}
	record.ContainerID = ""
	record.PublishedPort = input.PublishedPort
	record.PublishedNativePort = input.PublishedNativePort
	record.TLSEnabled = input.TLSEnabled
	record.TLSCertificateID = input.TLSCertificateID
	record.RedisConfigHash = managedRedisConfigHash(input)
	containerID, err := m.createContainer(ctx, record, input)
	if err != nil {
		return rollback(fmt.Errorf("start Valkey: %w", err))
	}
	record.ContainerID = containerID
	record.DesiredRunning = true
	if err := m.replayRedisMoveDump(ctx, *record, input, dump); err != nil {
		return rollback(err)
	}
	// Verified: the Redis container and its data go.
	if err := m.client.RemoveContainer(ctx, previous.ContainerID, true); err != nil && !cerrdefs.IsNotFound(err) {
		m.logger.Warn("remove the Redis container of a key-value store moved to Valkey", "id", previous.ID, "error", err)
	}
	if err := os.RemoveAll(managedRedisDataPath(previous, "")); err != nil {
		m.logger.Warn("remove the Redis data of a key-value store moved to Valkey", "id", previous.ID, "error", err)
	}
	if previous.RedisConfigHash != "" && previous.RedisConfigHash != record.RedisConfigHash {
		if err := os.Remove(filepath.Join(record.MountPath, legacycompat.RedisConfigPrefix+previous.RedisConfigHash+".conf")); err != nil && !errors.Is(err, os.ErrNotExist) {
			m.logger.Warn("remove superseded managed Redis config", "id", previous.ID, "error", err)
		}
	}
	m.logger.Info("moved a key-value store from Redis to Valkey", "id", record.ID, "keys", dump.totalKeys())
	return nil
}

// recoverInterruptedValkeyMove undoes a move the daemon stopped in the middle
// of: a Valkey container under the store's name that is not its recorded
// container is removed with its data, and the recorded Redis container gets
// its name back and runs again.
func (m *managedDatabaseManager) recoverInterruptedValkeyMove(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	_ = os.Remove(filepath.Join(record.MountPath, redisMoveDumpName))
	if current, err := m.client.cli.ContainerInspect(ctx, record.ContainerName, mobyclient.ContainerInspectOptions{}); err == nil && current.Container.ID != record.ContainerID {
		if current.Container.Config == nil || current.Container.Config.Labels[managedDatabaseLabel] != record.ID {
			return errors.New("another container uses the store's container name")
		}
		m.logger.Warn("removing the Valkey container of an interrupted move to Valkey", "id", record.ID)
		if err := m.client.RemoveContainer(ctx, current.Container.ID, true); err != nil && !cerrdefs.IsNotFound(err) {
			return fmt.Errorf("remove the container of an interrupted move: %w", err)
		}
	} else if err != nil && !isNotFoundErr(err) {
		return err
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect the Redis container: %w", err)
	}
	if strings.TrimPrefix(inspect.Container.Name, "/") != record.ContainerName {
		if err := m.client.RenameContainer(ctx, record.ContainerID, record.ContainerName); err != nil {
			return fmt.Errorf("rename the Redis container back: %w", err)
		}
	}
	if err := os.RemoveAll(managedRedisDataPath(*record, input.Image)); err != nil {
		return fmt.Errorf("remove the Valkey data of an interrupted move: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return err
		}
		if err := m.waitForDatabaseReady(ctx, record.ContainerID, input); err != nil {
			return err
		}
	}
	return nil
}

func copyRedisMoveACL(fromDir, toDir string) error {
	acl, err := os.ReadFile(filepath.Join(fromDir, "users.acl"))
	if err != nil {
		return fmt.Errorf("read the Redis ACL users: %w", err)
	}
	if err := os.MkdirAll(toDir, 0750); err != nil {
		return fmt.Errorf("create the Valkey data directory: %w", err)
	}
	uid, gid, err := managedDatabaseTLSOwner("redis")
	if err != nil {
		return err
	}
	if err := managedDatabaseChown(toDir, uid, gid); err != nil {
		return fmt.Errorf("set Valkey data directory ownership: %w", err)
	}
	path := filepath.Join(toDir, "users.acl")
	if err := os.WriteFile(path, acl, 0600); err != nil {
		return fmt.Errorf("write the Valkey ACL users: %w", err)
	}
	if err := managedDatabaseChown(path, uid, gid); err != nil {
		return fmt.Errorf("set Valkey ACL file ownership: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) managedContainerAddress(ctx context.Context, containerID, networkName string) (string, error) {
	inspect, err := m.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", err
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running || inspect.Container.NetworkSettings == nil {
		return "", errors.New("the container is not running")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[networkName]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return "", errors.New("the container has no private address")
	}
	return net.JoinHostPort(endpoint.IPAddress.String(), "6379"), nil
}

// replayRedisMoveDump writes the dump into the new Valkey container and
// compares the key count of every logical database with the copy.
func (m *managedDatabaseManager) replayRedisMoveDump(ctx context.Context, record managedDatabaseRecord, input managedDatabaseCommand, dump *redisMoveDump) error {
	address, err := m.managedContainerAddress(ctx, record.ContainerID, record.NetworkName)
	if err != nil {
		return fmt.Errorf("reach Valkey: %w", err)
	}
	target, err := dialRedisMove(ctx, address, input.OwnerPassword)
	if err != nil {
		return fmt.Errorf("connect to Valkey: %w", err)
	}
	defer target.close()
	if err := target.replay(ctx, dump.path, dump.commands); err != nil {
		return fmt.Errorf("write the keys into Valkey: %w", err)
	}
	return target.verify(ctx, dump)
}

// redisMoveDump is the copy of a store's keys: a file of commands that
// rebuild them, with the number of keys of each logical database and the
// expirations of the copied keys (a key may expire before it is counted).
type redisMoveDump struct {
	path     string
	commands int64
	keys     map[int]int64
	expiries map[int][]int64
}

func (d *redisMoveDump) totalKeys() int64 {
	var total int64
	for _, count := range d.keys {
		total += count
	}
	return total
}

type redisMoveWriter struct {
	w        *bufio.Writer
	commands int64
}

func (w *redisMoveWriter) emit(args ...string) error {
	w.commands++
	return writeRespCommand(w.w, args)
}

func writeRedisMoveDump(ctx context.Context, source *redisMoveConn, path string, databases []int) (*redisMoveDump, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return nil, fmt.Errorf("create the key copy: %w", err)
	}
	defer file.Close()
	writer := &redisMoveWriter{w: bufio.NewWriterSize(file, 256<<10)}
	dump := &redisMoveDump{path: path, keys: map[int]int64{}, expiries: map[int][]int64{}}
	if err := source.copyFunctions(ctx, writer); err != nil {
		return nil, err
	}
	copier := &redisMoveKeyCopier{source: source, out: writer, hashFieldTTL: true}
	for _, database := range databases {
		db := strconv.Itoa(database)
		if _, err := source.do(ctx, "SELECT", db); err != nil {
			return nil, err
		}
		if err := writer.emit("SELECT", db); err != nil {
			return nil, err
		}
		seen := map[uint64]struct{}{}
		cursor := "0"
		for {
			reply, err := source.do(ctx, "SCAN", cursor, "COUNT", redisMoveScanCount)
			if err != nil {
				return nil, err
			}
			if len(reply.items) != 2 {
				return nil, errors.New("unexpected SCAN answer")
			}
			cursor = reply.items[0].text
			for _, item := range reply.items[1].items {
				key := item.text
				digest := fnv.New64a()
				_, _ = digest.Write([]byte(key))
				sum := digest.Sum64()
				if _, ok := seen[sum]; ok {
					continue // SCAN may return a key twice
				}
				seen[sum] = struct{}{}
				copied, expireAt, err := copier.copy(ctx, key)
				if err != nil {
					return nil, fmt.Errorf("copy a key of database %d: %w", database, err)
				}
				if copied {
					dump.keys[database]++
					if expireAt > 0 {
						dump.expiries[database] = append(dump.expiries[database], expireAt)
					}
				}
			}
			if cursor == "0" {
				break
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
	}
	if err := writer.w.Flush(); err != nil {
		return nil, fmt.Errorf("write the key copy: %w", err)
	}
	if err := file.Sync(); err != nil {
		return nil, fmt.Errorf("write the key copy: %w", err)
	}
	dump.commands = writer.commands
	return dump, nil
}

type redisMoveKeyCopier struct {
	source       *redisMoveConn
	out          *redisMoveWriter
	hashFieldTTL bool
}

// copy writes the commands that rebuild one key. A key that is gone or about
// to expire is skipped.
func (c *redisMoveKeyCopier) copy(ctx context.Context, key string) (bool, int64, error) {
	kind, err := c.source.do(ctx, "TYPE", key)
	if err != nil {
		return false, 0, err
	}
	ttl, err := c.source.do(ctx, "PTTL", key)
	if err != nil {
		return false, 0, err
	}
	if kind.text == "none" || ttl.integer == -2 || ttl.integer == 0 {
		return false, 0, nil
	}
	expireAt := int64(0)
	if ttl.integer > 0 {
		expireAt = time.Now().UnixMilli() + ttl.integer
	}
	switch kind.text {
	case "string":
		value, err := c.source.do(ctx, "GET", key)
		if err != nil {
			return false, 0, err
		}
		if value.null {
			return false, 0, nil
		}
		err = c.out.emit("SET", key, value.text)
		if err != nil {
			return false, 0, err
		}
	case "list":
		length, err := c.source.do(ctx, "LLEN", key)
		if err != nil {
			return false, 0, err
		}
		for start := int64(0); start < length.integer; start += redisMoveChunk {
			items, err := c.source.do(ctx, "LRANGE", key, strconv.FormatInt(start, 10), strconv.FormatInt(start+redisMoveChunk-1, 10))
			if err != nil {
				return false, 0, err
			}
			if len(items.items) == 0 {
				break
			}
			if err := c.out.emit(append([]string{"RPUSH", key}, items.strings()...)...); err != nil {
				return false, 0, err
			}
		}
	case "set":
		if err := c.scanMembers(ctx, "SSCAN", key, func(items []string) error {
			return c.out.emit(append([]string{"SADD", key}, items...)...)
		}); err != nil {
			return false, 0, err
		}
	case "zset":
		if err := c.scanMembers(ctx, "ZSCAN", key, func(items []string) error {
			args := []string{"ZADD", key}
			for i := 0; i+1 < len(items); i += 2 {
				args = append(args, items[i+1], items[i])
			}
			return c.out.emit(args...)
		}); err != nil {
			return false, 0, err
		}
	case "hash":
		if err := c.scanMembers(ctx, "HSCAN", key, func(items []string) error {
			if err := c.out.emit(append([]string{"HSET", key}, items...)...); err != nil {
				return err
			}
			return c.copyHashFieldTTLs(ctx, key, items)
		}); err != nil {
			return false, 0, err
		}
	case "stream":
		if err := c.copyStream(ctx, key); err != nil {
			return false, 0, err
		}
	case "ReJSON-RL":
		value, err := c.source.do(ctx, "JSON.GET", key, ".")
		if err != nil {
			return false, 0, err
		}
		if value.null {
			return false, 0, nil
		}
		if err := c.out.emit("JSON.SET", key, ".", value.text); err != nil {
			return false, 0, err
		}
	default:
		return false, 0, fmt.Errorf("Valkey cannot take over keys of type %s", kind.text)
	}
	if expireAt > 0 {
		if err := c.out.emit("PEXPIREAT", key, strconv.FormatInt(expireAt, 10)); err != nil {
			return false, 0, err
		}
	}
	return true, expireAt, nil
}

func (c *redisMoveKeyCopier) scanMembers(ctx context.Context, command, key string, write func([]string) error) error {
	cursor := "0"
	for {
		reply, err := c.source.do(ctx, command, key, cursor, "COUNT", redisMoveScanCount)
		if err != nil {
			return err
		}
		if len(reply.items) != 2 {
			return fmt.Errorf("unexpected %s answer", command)
		}
		cursor = reply.items[0].text
		if items := reply.items[1].strings(); len(items) > 0 {
			if err := write(items); err != nil {
				return err
			}
		}
		if cursor == "0" {
			return nil
		}
	}
}

// copyHashFieldTTLs keeps the field expirations of a hash (Redis 7.4 and
// newer; older releases have none).
func (c *redisMoveKeyCopier) copyHashFieldTTLs(ctx context.Context, key string, fieldValues []string) error {
	if !c.hashFieldTTL {
		return nil
	}
	fields := make([]string, 0, len(fieldValues)/2)
	for i := 0; i+1 < len(fieldValues); i += 2 {
		fields = append(fields, fieldValues[i])
	}
	args := append([]string{"HPEXPIRETIME", key, "FIELDS", strconv.Itoa(len(fields))}, fields...)
	reply, err := c.source.do(ctx, args...)
	if err != nil {
		if isRedisUnknownCommand(err) {
			c.hashFieldTTL = false
			return nil
		}
		return err
	}
	for i, item := range reply.items {
		if i < len(fields) && item.integer > 0 {
			if err := c.out.emit("HPEXPIREAT", key, strconv.FormatInt(item.integer, 10), "FIELDS", "1", fields[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *redisMoveKeyCopier) copyStream(ctx context.Context, key string) error {
	info, err := c.source.do(ctx, "XINFO", "STREAM", key)
	if err != nil {
		return err
	}
	fields := info.fieldMap()
	start := "-"
	entries := 0
	for {
		reply, err := c.source.do(ctx, "XRANGE", key, start, "+", "COUNT", redisMoveScanCount)
		if err != nil {
			return err
		}
		for _, entry := range reply.items {
			if len(entry.items) != 2 {
				return errors.New("unexpected XRANGE answer")
			}
			id := entry.items[0].text
			if err := c.out.emit(append([]string{"XADD", key, id}, entry.items[1].strings()...)...); err != nil {
				return err
			}
			start = "(" + id
			entries++
		}
		if len(reply.items) < redisMoveChunk {
			break
		}
	}
	if entries == 0 {
		// An empty stream exists only through a consumer group.
		if err := c.out.emit("XGROUP", "CREATE", key, legacycompat.RedisMoveGroup, "$", "MKSTREAM"); err != nil {
			return err
		}
		if err := c.out.emit("XGROUP", "DESTROY", key, legacycompat.RedisMoveGroup); err != nil {
			return err
		}
	}
	if last := fields["last-generated-id"].text; last != "" && last != "0-0" {
		args := []string{"XSETID", key, last}
		if added, deleted := fields["entries-added"], fields["max-deleted-entry-id"]; added.kind == ':' && deleted.text != "" {
			args = append(args, "ENTRIESADDED", strconv.FormatInt(added.integer, 10), "MAXDELETEDID", deleted.text)
		}
		if err := c.out.emit(args...); err != nil {
			return err
		}
	}
	groups, err := c.source.do(ctx, "XINFO", "GROUPS", key)
	if err != nil {
		return err
	}
	for _, group := range groups.items {
		values := group.fieldMap()
		args := []string{"XGROUP", "CREATE", key, values["name"].text, values["last-delivered-id"].text}
		if read := values["entries-read"]; read.kind == ':' {
			args = append(args, "ENTRIESREAD", strconv.FormatInt(read.integer, 10))
		}
		if err := c.out.emit(args...); err != nil {
			return err
		}
	}
	return nil
}

// --- the Redis protocol, as much as the move needs ---

type respValue struct {
	kind    byte // '+', '-', ':', '$', '*'
	text    string
	integer int64
	items   []respValue
	null    bool
}

func (v respValue) strings() []string {
	values := make([]string, 0, len(v.items))
	for _, item := range v.items {
		values = append(values, item.text)
	}
	return values
}

// fieldMap reads a RESP2 flat list of field names and values.
func (v respValue) fieldMap() map[string]respValue {
	values := map[string]respValue{}
	for i := 0; i+1 < len(v.items); i += 2 {
		values[v.items[i].text] = v.items[i+1]
	}
	return values
}

type respError string

func (e respError) Error() string { return string(e) }

func isRedisUnknownCommand(err error) bool {
	var reply respError
	return errors.As(err, &reply) && strings.Contains(strings.ToLower(string(reply)), "unknown command")
}

func writeRespCommand(w io.Writer, args []string) error {
	if _, err := fmt.Fprintf(w, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, arg := range args {
		if _, err := fmt.Fprintf(w, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
			return err
		}
	}
	return nil
}

// respMaxBulk bounds one value read from the engine (its own limit is 512 MB).
const respMaxBulk = 512 << 20

func readResp(r *bufio.Reader) (respValue, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return respValue{}, err
	}
	if len(line) < 3 || !strings.HasSuffix(line, "\r\n") {
		return respValue{}, errors.New("malformed reply")
	}
	kind, body := line[0], line[1:len(line)-2]
	switch kind {
	case '+':
		return respValue{kind: kind, text: body}, nil
	case '-':
		return respValue{kind: kind, text: body}, nil
	case ':':
		n, err := strconv.ParseInt(body, 10, 64)
		if err != nil {
			return respValue{}, errors.New("malformed integer reply")
		}
		return respValue{kind: kind, integer: n}, nil
	case '$':
		n, err := strconv.Atoi(body)
		if err != nil || n > respMaxBulk {
			return respValue{}, errors.New("malformed bulk reply")
		}
		if n < 0 {
			return respValue{kind: kind, null: true}, nil
		}
		buffer := make([]byte, n+2)
		if _, err := io.ReadFull(r, buffer); err != nil {
			return respValue{}, err
		}
		return respValue{kind: kind, text: string(buffer[:n])}, nil
	case '*':
		n, err := strconv.Atoi(body)
		if err != nil {
			return respValue{}, errors.New("malformed array reply")
		}
		if n < 0 {
			return respValue{kind: kind, null: true}, nil
		}
		items := make([]respValue, 0, min(n, 4096))
		for i := 0; i < n; i++ {
			item, err := readResp(r)
			if err != nil {
				return respValue{}, err
			}
			items = append(items, item)
		}
		return respValue{kind: kind, items: items}, nil
	default:
		return respValue{}, fmt.Errorf("unexpected reply type %q", kind)
	}
}

type redisMoveConn struct {
	conn net.Conn
	r    *bufio.Reader
	w    *bufio.Writer
}

func dialRedisMove(ctx context.Context, address, password string) (*redisMoveConn, error) {
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	c := &redisMoveConn{conn: conn, r: bufio.NewReaderSize(conn, 256<<10), w: bufio.NewWriterSize(conn, 256<<10)}
	if _, err := c.do(ctx, "AUTH", "default", password); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return c, nil
}

func (c *redisMoveConn) close() { _ = c.conn.Close() }

func (c *redisMoveConn) deadline(ctx context.Context, idle time.Duration) {
	deadline := time.Now().Add(idle)
	if limit, ok := ctx.Deadline(); ok && limit.Before(deadline) {
		deadline = limit
	}
	_ = c.conn.SetDeadline(deadline)
}

func (c *redisMoveConn) do(ctx context.Context, args ...string) (respValue, error) {
	c.deadline(ctx, 2*time.Minute)
	if err := writeRespCommand(c.w, args); err != nil {
		return respValue{}, err
	}
	if err := c.w.Flush(); err != nil {
		return respValue{}, err
	}
	reply, err := readResp(c.r)
	if err != nil {
		return respValue{}, err
	}
	if reply.kind == '-' {
		return reply, respError(reply.text)
	}
	return reply, nil
}

var redisKeyspaceLine = regexp.MustCompile(`^db(\d+):keys=(\d+)`)

// keyspaceDatabases lists the logical databases that hold keys.
func (c *redisMoveConn) keyspaceDatabases(ctx context.Context) ([]int, error) {
	info, err := c.do(ctx, "INFO", "keyspace")
	if err != nil {
		return nil, err
	}
	var databases []int
	for _, line := range strings.Split(info.text, "\n") {
		match := redisKeyspaceLine.FindStringSubmatch(strings.TrimSpace(line))
		if match == nil {
			continue
		}
		database, _ := strconv.Atoi(match[1])
		if keys, _ := strconv.ParseInt(match[2], 10, 64); keys > 0 {
			databases = append(databases, database)
		}
	}
	sort.Ints(databases)
	return databases, nil
}

// redisMoveInventory is what a move would copy and what stops it: the key
// count and dataset size, the pending entries of stream consumer groups (a
// move keeps the groups but not their pending entries) and the data Valkey
// cannot take over. EstimatedPauseSeconds is the expected time writes are
// unavailable, from the copy rate measured on a build host (about 5,000 small
// keys or 100 MB a second, read and written once each) plus the restart of the
// engine.
type redisMoveInventory struct {
	Keys                  int64    `json:"keys"`
	UsedMemoryBytes       int64    `json:"usedMemoryBytes"`
	PendingStreamEntries  int64    `json:"pendingStreamEntries"`
	Blockers              []string `json:"blockers"`
	EstimatedPauseSeconds int64    `json:"estimatedPauseSeconds"`
}

func redisMoveEstimatedPause(keys, bytes int64) int64 {
	seconds := 3 + 2*(float64(keys)/5000+float64(bytes)/(100<<20))
	return int64(seconds + 0.999)
}

// inventory scans every logical database (TYPE pipelined per SCAN page) and
// the consumer groups of every stream.
func (c *redisMoveConn) inventory(ctx context.Context, databases []int) (redisMoveInventory, error) {
	result := redisMoveInventory{Blockers: []string{}}
	found := map[string]int64{}
	if indexes, err := c.do(ctx, "FT._LIST"); err == nil && len(indexes.items) > 0 {
		found["search indexes"] = int64(len(indexes.items))
	} else if err != nil && !isRedisUnknownCommand(err) {
		return result, err
	}
	if memory, err := c.do(ctx, "INFO", "memory"); err == nil {
		for _, line := range strings.Split(memory.text, "\n") {
			if value, ok := strings.CutPrefix(strings.TrimSpace(line), "used_memory_dataset:"); ok {
				result.UsedMemoryBytes, _ = strconv.ParseInt(value, 10, 64)
			}
		}
	}
	for _, database := range databases {
		if _, err := c.do(ctx, "SELECT", strconv.Itoa(database)); err != nil {
			return result, err
		}
		var streams []string
		cursor := "0"
		for {
			reply, err := c.do(ctx, "SCAN", cursor, "COUNT", redisMoveScanCount)
			if err != nil {
				return result, err
			}
			if len(reply.items) != 2 {
				return result, errors.New("unexpected SCAN answer")
			}
			cursor = reply.items[0].text
			keys := reply.items[1].strings()
			c.deadline(ctx, 2*time.Minute)
			for _, key := range keys {
				if err := writeRespCommand(c.w, []string{"TYPE", key}); err != nil {
					return result, err
				}
			}
			if err := c.w.Flush(); err != nil {
				return result, err
			}
			for _, key := range keys {
				kind, err := readResp(c.r)
				if err != nil {
					return result, err
				}
				if kind.kind != '+' || kind.text == "none" {
					continue
				}
				result.Keys++
				if kind.text == "stream" {
					streams = append(streams, key)
				}
				if !redisMoveCopyableTypes[kind.text] {
					name := redisMoveTypeNames[kind.text]
					if name == "" {
						name = "keys of type " + kind.text
					}
					found[name]++
				}
			}
			if cursor == "0" {
				break
			}
			if err := ctx.Err(); err != nil {
				return result, err
			}
		}
		for _, stream := range streams {
			groups, err := c.do(ctx, "XINFO", "GROUPS", stream)
			if err != nil {
				return result, err
			}
			for _, group := range groups.items {
				result.PendingStreamEntries += group.fieldMap()["pending"].integer
			}
		}
	}
	if _, err := c.do(ctx, "SELECT", "0"); err != nil {
		return result, err
	}
	for name, count := range found {
		result.Blockers = append(result.Blockers, fmt.Sprintf("%s (%d)", name, count))
	}
	sort.Strings(result.Blockers)
	result.EstimatedPauseSeconds = redisMoveEstimatedPause(result.Keys, result.UsedMemoryBytes)
	return result, nil
}

// refuseMove names why a move cannot start: data Valkey cannot take over, or
// pending stream entries the caller did not accept to lose.
func (inventory redisMoveInventory) refuseMove(acceptPendingStreamLoss bool) error {
	if len(inventory.Blockers) > 0 {
		return fmt.Errorf("Valkey cannot take over %s; remove them and move again", strings.Join(inventory.Blockers, ", "))
	}
	if inventory.PendingStreamEntries > 0 && !acceptPendingStreamLoss {
		return fmt.Errorf("%d pending stream entries would not be moved and their consumers would not see them again; move again accepting their loss", inventory.PendingStreamEntries)
	}
	return nil
}

// moveToValkeyPreflight reports what moving a Redis key-value store to
// Valkey would copy and what would stop it. It only reads the store.
func (m *managedDatabaseManager) moveToValkeyPreflight(ctx context.Context, record managedDatabaseRecord, ownerPassword string) (string, error) {
	if record.Type != "redis" {
		return "", errors.New("only a key-value store can be moved to Valkey")
	}
	valkey, exists, err := m.managedRedisContainerRunsValkey(ctx, record.ContainerID)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", errors.New("the key-value store has no container")
	}
	if valkey {
		return "", errors.New("the key-value store already runs Valkey")
	}
	address, err := m.managedContainerAddress(ctx, record.ContainerID, record.NetworkName)
	if err != nil {
		return "", fmt.Errorf("the store must be running: %w", err)
	}
	source, err := dialRedisMove(ctx, address, ownerPassword)
	if err != nil {
		return "", fmt.Errorf("connect to Redis: %w", err)
	}
	defer source.close()
	databases, err := source.keyspaceDatabases(ctx)
	if err != nil {
		return "", err
	}
	inventory, err := source.inventory(ctx, databases)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(inventory)
	return string(data), err
}

// copyFunctions keeps the Redis Functions libraries (Redis 7 and newer).
func (c *redisMoveConn) copyFunctions(ctx context.Context, out *redisMoveWriter) error {
	reply, err := c.do(ctx, "FUNCTION", "LIST", "WITHCODE")
	if err != nil {
		if isRedisUnknownCommand(err) {
			return nil
		}
		return err
	}
	for _, library := range reply.items {
		code := library.fieldMap()["library_code"].text
		if code == "" {
			continue
		}
		if err := out.emit("FUNCTION", "LOAD", "REPLACE", code); err != nil {
			return err
		}
	}
	return nil
}

// replay streams the dump while reading the answers, and fails on the first
// command Valkey refused.
func (c *redisMoveConn) replay(ctx context.Context, path string, commands int64) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if limit, ok := ctx.Deadline(); ok {
		_ = c.conn.SetDeadline(limit)
	} else {
		_ = c.conn.SetDeadline(time.Time{})
	}
	answers := make(chan error, 1)
	go func() {
		var refused error
		for i := int64(0); i < commands; i++ {
			reply, err := readResp(c.r)
			if err != nil {
				answers <- err
				return
			}
			if reply.kind == '-' && refused == nil {
				refused = fmt.Errorf("Valkey refused a command: %s", reply.text)
			}
		}
		answers <- refused
	}()
	if _, err := io.Copy(c.conn, bufio.NewReaderSize(file, 256<<10)); err != nil {
		_ = c.conn.Close()
		<-answers
		return err
	}
	select {
	case err := <-answers:
		return err
	case <-ctx.Done():
		_ = c.conn.Close()
		<-answers
		return ctx.Err()
	}
}

// verify compares the key count of every copied database; keys that expired
// since they were copied may be missing.
func (c *redisMoveConn) verify(ctx context.Context, dump *redisMoveDump) error {
	for database, copied := range dump.keys {
		if _, err := c.do(ctx, "SELECT", strconv.Itoa(database)); err != nil {
			return err
		}
		size, err := c.do(ctx, "DBSIZE")
		if err != nil {
			return err
		}
		now := time.Now().UnixMilli()
		expired := int64(0)
		for _, expireAt := range dump.expiries[database] {
			if expireAt <= now {
				expired++
			}
		}
		if size.integer > copied || size.integer < copied-expired {
			return fmt.Errorf("database %d holds %d keys in Valkey, %d were copied", database, size.integer, copied)
		}
	}
	return nil
}
