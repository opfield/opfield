package docker

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/docker-daemon/internal/pgha"
)

// Helper containers of the database image run pg_basebackup, pg_rewind,
// pg_controldata and pg_waldump against the member's data directory as the
// postgres user. Replication helpers join the set's private bridge and reach
// the primary through the member mesh (primary-pg-repl).

const pgHelperLabel = "net.opfield.availability.helper"

type pgHelperResult struct {
	exitCode int
	output   string
}

func (e *pgMember) image(ctx context.Context, record managedDatabaseRecord) (string, error) {
	inspect, err := e.m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect the member container: %w", err)
	}
	if inspect.Container.Config == nil || inspect.Container.Config.Image == "" {
		return "", errors.New("the member container has no image")
	}
	return inspect.Container.Config.Image, nil
}

// runHelper runs command in a helper container and returns its output.
func (e *pgMember) runHelper(ctx context.Context, record managedDatabaseRecord, replication bool, command ...string) (pgHelperResult, error) {
	image, err := e.image(ctx, record)
	if err != nil {
		return pgHelperResult{}, err
	}
	hostConfig := &container.HostConfig{
		Binds:       []string{record.MountPath + ":" + pgContainerDataDir, e.m.tlsDirectory(record) + ":" + pgContainerTLSDir + ":ro"},
		LogConfig:   container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "5m", "max-file": "1"}},
		NetworkMode: "none",
	}
	var networking *network.NetworkingConfig
	if replication {
		if e.mesh == nil {
			return pgHelperResult{}, errors.New("the member mesh is not available on this node")
		}
		networkName, err := e.mesh.Ensure(ctx, e.setID)
		if err != nil {
			return pgHelperResult{}, fmt.Errorf("the set's member mesh: %w", err)
		}
		hostConfig.NetworkMode = container.NetworkMode(networkName)
		hostConfig.ExtraHosts = e.mesh.ExtraHosts(e.setID)
		networking = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{networkName: {}}}
	}
	created, err := e.m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image: image, User: fmt.Sprintf("%d:%d", pgPostgresUID, pgPostgresGID),
			Entrypoint: []string{command[0]}, Cmd: command[1:],
			Labels: map[string]string{managedDatabaseLabel: record.ID, pgHelperLabel: "1"},
		},
		HostConfig: hostConfig, NetworkingConfig: networking,
	})
	if err != nil {
		return pgHelperResult{}, fmt.Errorf("create the %s helper: %w", command[0], err)
	}
	defer func() {
		// The image declares a data volume; its anonymous volume goes too.
		_, _ = e.m.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}()
	if _, err := e.m.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return pgHelperResult{}, fmt.Errorf("start the %s helper: %w", command[0], err)
	}
	wait := e.m.client.cli.ContainerWait(ctx, created.ID, mobyclient.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	var exitCode int
	select {
	case err := <-wait.Error:
		if err != nil {
			return pgHelperResult{}, fmt.Errorf("wait for the %s helper: %w", command[0], err)
		}
	case result := <-wait.Result:
		exitCode = int(result.StatusCode)
	case <-ctx.Done():
		return pgHelperResult{}, ctx.Err()
	}
	lines, _ := e.m.client.ContainerLogs(context.Background(), created.ID, 400, false, "", "")
	return pgHelperResult{exitCode: exitCode, output: strings.Join(lines, "\n")}, nil
}

var pgClusterStatePattern = regexp.MustCompile(`(?m)^Database cluster state:\s+(.+)$`)

func (e *pgMember) ShutdownState(ctx context.Context) (string, error) {
	record, err := e.record()
	if err != nil {
		return "", err
	}
	result, err := e.runHelper(ctx, record, false, "pg_controldata", pgContainerDataDir+"/"+pgdataDirName)
	if err != nil {
		return "", err
	}
	match := pgClusterStatePattern.FindStringSubmatch(result.output)
	if result.exitCode != 0 || match == nil {
		return "", fmt.Errorf("pg_controldata failed: %s", pgFirstLine(result.output))
	}
	return strings.TrimSpace(match[1]), nil
}

var (
	pgDivergedPattern = regexp.MustCompile(`servers diverged at WAL location ([0-9A-F]+/[0-9A-F]+) on timeline (\d+)`)
	pgLSNPattern      = regexp.MustCompile(`([0-9A-F]+/[0-9A-F]+)`)
	// pgRewindImpossible are pg_rewind failures a retry cannot fix.
	pgRewindImpossible = []string{
		"could not find previous WAL record", "could not find common ancestor", "could not open file",
		"could not read file", "is not a descendant", "needs to use either data checksums", "unexpected result while fetching",
		"could not find WAL", "requested WAL segment",
	}
)

// Rewind runs pg_rewind through the member mesh (M9): a dry run finds the
// divergence point, the diverged WAL is copied aside when the disk allows,
// then the real rewind.
func (e *pgMember) Rewind(ctx context.Context, config pgha.StandbyConfig) (pgha.RewindResult, error) {
	record, err := e.record()
	if err != nil {
		return pgha.RewindResult{}, err
	}
	rewindRole := ""
	if e.config != nil {
		rewindRole = e.config().Engine.RewindRole
	}
	rewind := func(dryRun bool) (pgHelperResult, error) {
		command := []string{"pg_rewind", "--target-pgdata=" + pgContainerDataDir + "/" + pgdataDirName,
			"--source-server=" + pgReplicationConnInfo(rewindRole, config.MemberID+"-rewind", "postgres")}
		if dryRun {
			command = append(command, "--dry-run")
		}
		return e.runHelper(ctx, record, true, command...)
	}
	result := pgha.RewindResult{}
	dry, err := rewind(true)
	if err != nil {
		return result, err
	}
	if outcome, done := classifyPGRewind(dry, &result); done {
		return result, outcome
	}
	pgdata := e.pgdata(record)
	result.TargetEnd = e.walEnd(ctx, record, result.DivergedAt)
	volume := pgVolumeBytes(record.MountPath)
	result.KeptAt = copyPGDivergedWAL(pgdata, pgDivergedDir(record), result.DivergedAt, volume, pgDiskReserveFor(volume))
	// From here on a failure leaves a directory that is part source, part
	// target: the engine rebuilds it and never starts it.
	result.Started = true
	real, err := rewind(false)
	if err != nil {
		return result, err
	}
	if outcome, done := classifyPGRewind(real, &result); done {
		return result, outcome
	}
	if real.exitCode != 0 {
		return result, fmt.Errorf("pg_rewind failed: %s", pgLastLine(real.output))
	}
	return result, nil
}

// classifyPGRewind reads a pg_rewind run; done is true when the caller stops.
func classifyPGRewind(run pgHelperResult, result *pgha.RewindResult) (error, bool) {
	if strings.Contains(run.output, "no rewind required") {
		result.NotNeeded = true
		return nil, true
	}
	if match := pgDivergedPattern.FindStringSubmatch(run.output); match != nil {
		result.DivergedAt, _ = pgha.ParseLSN(match[1])
		timeline, _ := strconv.ParseUint(match[2], 10, 32)
		result.Timeline = uint32(timeline)
	}
	if run.exitCode == 0 {
		return nil, false
	}
	for _, marker := range pgRewindImpossible {
		if strings.Contains(run.output, marker) {
			result.NeedsRebuild, result.Detail = true, pgLastLine(run.output)
			return nil, true
		}
	}
	return fmt.Errorf("pg_rewind failed: %s", pgLastLine(run.output)), true
}

// pgLastLine returns the end of a tool's output (the last few lines), bounded.
func pgLastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	line := strings.Join(lines, " | ")
	if len(line) > 600 {
		line = line[len(line)-600:]
	}
	return line
}

// walEnd finds the end of valid WAL after from on the target (pg_waldump
// stops with an error naming the first invalid position); the newest
// segment's end when that fails.
func (e *pgMember) walEnd(ctx context.Context, record managedDatabaseRecord, from pgha.LSN) pgha.LSN {
	pgwal := filepath.Join(e.pgdata(record), "pg_wal")
	fallback := newestPGSegmentEnd(pgwal, from)
	if from == 0 {
		return fallback
	}
	result, err := e.runHelper(ctx, record, false, "sh", "-c",
		fmt.Sprintf("pg_waldump --path=%s/%s/pg_wal --start=%s 2>&1 | tail -n 2", pgContainerDataDir, pgdataDirName, from))
	if err != nil {
		return fallback
	}
	matches := pgLSNPattern.FindAllString(result.output, -1)
	if len(matches) == 0 {
		return fallback
	}
	end, err := pgha.ParseLSN(matches[len(matches)-1])
	if err != nil || end < from {
		return fallback
	}
	return end
}

func newestPGSegmentEnd(pgwal string, from pgha.LSN) pgha.LSN {
	entries, err := os.ReadDir(pgwal)
	if err != nil {
		return from
	}
	end := from
	for _, entry := range entries {
		if _, start, ok := pgha.ParseWALSegmentName(entry.Name()); ok && start+16<<20 > end {
			end = start + 16<<20
		}
	}
	return end
}

func pgDivergedDir(record managedDatabaseRecord) string {
	return filepath.Join(record.MountPath, pgMemberDirName, pgDivergedDirName)
}

// copyPGDivergedWAL copies the WAL segments holding records after from into
// a fresh directory under dest when they fit within the copies' budget (5% of
// the volume) and leave minFree free; older copies are pruned to the budget.
// It returns the directory, or "" when nothing was kept.
func copyPGDivergedWAL(pgdata, dest string, from pgha.LSN, volumeBytes, minFree int64) string {
	defer prunePGDivergedCopies(dest, volumeBytes)
	prunePGDivergedCopies(dest, volumeBytes)
	pgwal := filepath.Join(pgdata, "pg_wal")
	entries, err := os.ReadDir(pgwal)
	if err != nil {
		return ""
	}
	var names []string
	var total int64
	for _, entry := range entries {
		_, start, ok := pgha.ParseWALSegmentName(entry.Name())
		if !ok || start+16<<20 <= from {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		names = append(names, entry.Name())
		total += info.Size()
	}
	if len(names) == 0 || (volumeBytes > 0 && total > pgDivergedBudget(volumeBytes)) || pgFreeBytes(pgdata)-total < minFree {
		return ""
	}
	sort.Strings(names)
	dir := filepath.Join(dest, time.Now().UTC().Format("20060102T150405Z"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(pgwal, name))
		if err != nil {
			return ""
		}
		if err := writeFileAtomically(filepath.Join(dir, name), data, 0o600, nil); err != nil {
			return ""
		}
	}
	_ = pgFsyncDir(dest)
	return dir
}

func pgDirBytes(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(_ string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if info, infoErr := entry.Info(); infoErr == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// Rebuild seeds a fresh data directory with pg_basebackup through the member
// mesh: the previous directory is kept until the new one works when the disk
// allows; otherwise its WAL tail is copied aside and it is removed first. The
// standby configuration is written last.
func (e *pgMember) Rebuild(ctx context.Context, config pgha.StandbyConfig) (pgha.RebuildResult, error) {
	record, err := e.record()
	if err != nil {
		return pgha.RebuildResult{}, err
	}
	if running, err := e.running(ctx, record); err != nil || running {
		if err == nil {
			err = errors.New("the member's container is running")
		}
		return pgha.RebuildResult{}, err
	}
	if err := e.m.ensureMounted(ctx, &record); err != nil {
		return pgha.RebuildResult{}, err
	}
	pgdata := e.pgdata(record)
	fresh := filepath.Join(record.MountPath, pgRebuildDirName)
	previous := filepath.Join(record.MountPath, pgPreviousDirName)
	result := pgha.RebuildResult{}
	if err := os.RemoveAll(fresh); err != nil {
		return result, err
	}
	_, statErr := os.Stat(filepath.Join(pgdata, "PG_VERSION"))
	hasData := statErr == nil
	if hasData {
		// A previous rebuild's kept directory goes first: this one replaces it.
		if err := os.RemoveAll(previous); err != nil {
			return result, err
		}
		size := pgDirBytes(pgdata)
		volume := pgVolumeBytes(record.MountPath)
		if pgFreeBytes(record.MountPath)-size-size/10 < pgDiskReserveFor(volume) {
			// The whole pg_wal is copied only when the volume keeps
			// max(5%, 1 GiB) free after it.
			result.DivergedWALKeptAt = copyPGDivergedWAL(pgdata, pgDivergedDir(record), 0, volume, max(volume/20, int64(pgFullCopyMinFree)))
			if err := os.RemoveAll(pgdata); err != nil {
				return result, err
			}
			hasData = false
			result.Detail = "the previous data directory did not fit next to the new one and was removed first"
		}
	}
	if err := os.Mkdir(fresh, 0o700); err != nil {
		return result, err
	}
	if err := managedDatabaseChown(fresh, pgPostgresUID, pgPostgresGID); err != nil {
		return result, err
	}
	run, err := e.runHelper(ctx, record, true, "pg_basebackup", "-d", pgReplicationConnInfo(config.ReplicationRole, config.MemberID+"-basebackup", ""),
		"-D", pgContainerDataDir+"/"+pgRebuildDirName, "-X", "stream", "-c", "fast", "--no-password", "-l", "opfield-rebuild")
	if err != nil {
		return result, err
	}
	if run.exitCode != 0 {
		_ = os.RemoveAll(fresh)
		return result, fmt.Errorf("pg_basebackup failed: %s", pgLastLine(run.output))
	}
	if hasData {
		if err := os.Rename(pgdata, previous); err != nil {
			return result, err
		}
		result.PreviousKept = true
	} else if err := os.RemoveAll(pgdata); err != nil {
		return result, err
	}
	if err := os.Rename(fresh, pgdata); err != nil {
		return result, err
	}
	if err := pgFsyncDir(record.MountPath); err != nil {
		return result, err
	}
	return result, writePGStandbyAtRest(pgdata, record.StorageSize, config)
}

func (e *pgMember) CommitRebuild(context.Context) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	// The previous directory is never dropped while it is the only cluster on
	// the volume.
	if _, err := os.Stat(filepath.Join(e.pgdata(record), "PG_VERSION")); err != nil {
		return fmt.Errorf("the previous data directory is kept: the data directory holds no cluster: %w", err)
	}
	if err := os.RemoveAll(filepath.Join(record.MountPath, pgPreviousDirName)); err != nil {
		return err
	}
	return pgFsyncDir(record.MountPath)
}
