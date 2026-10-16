package docker

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// Per-set files the member engines keep in the daemon's state directory: the
// Postgres engine's state (availability-postgres/<setId>.json) and a Valkey
// copy's ACL marker (availability-valkey/<setId>-<memberId>.acl-mirrored).
// They go when the node's member of the set goes (lift, removal, set deleted:
// the member runtime forgets it), and the daemon's start removes those of
// sets it no longer has a member of (older daemons never removed them).
// SeaweedFS and ClickHouse members keep their state with the member's data,
// which goes with it.
const (
	pgMemberStateDir = "availability-postgres"
	kvMemberStateDir = "availability-valkey"
)

// setMemberStateFiles lists the per-set state files under stateDir by set id.
func setMemberStateFiles(stateDir string) map[string][]string {
	out := map[string][]string{}
	add := func(dir, suffix string, setOf func(base string) string) {
		entries, err := os.ReadDir(filepath.Join(stateDir, dir))
		if err != nil {
			return
		}
		for _, entry := range entries {
			base, ok := strings.CutSuffix(entry.Name(), suffix)
			if !ok || entry.IsDir() {
				continue
			}
			if setID := setOf(base); uuidLike(setID) {
				out[setID] = append(out[setID], filepath.Join(stateDir, dir, entry.Name()))
			}
		}
	}
	add(pgMemberStateDir, ".json", func(base string) string { return base })
	add(kvMemberStateDir, ".acl-mirrored", func(base string) string {
		// <setId>-<memberId>
		if len(base) > 37 && base[36] == '-' {
			return base[:36]
		}
		return ""
	})
	return out
}

func removeSetMemberStateFiles(paths []string, setID string, logger *slog.Logger) {
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) && logger != nil {
			logger.Warn("could not remove the state file of an availability set member this node no longer has",
				"set_id", setID, "path", path, "error", err)
		}
	}
}

// forgetSetMemberState removes the per-set state files of a set whose member
// the runtime forgot. It never takes a manager's lock (Forget runs under
// them) and keeps the files of a set the node has a member of again.
func (p *DockerPlugin) forgetSetMemberState(setID string) {
	if p.cfg == nil || p.cfg.StateDir == "" || !uuidLike(setID) {
		return
	}
	if p.setMembers != nil {
		if _, ok := p.setMembers.Config(setID); ok {
			return
		}
	}
	removeSetMemberStateFiles(setMemberStateFiles(p.cfg.StateDir)[setID], setID, p.logger)
}

// sweepSetMemberStateOrphans removes, at the daemon's start, the per-set
// state files of sets this node has no member of and no record names (a set
// deleted while the daemon was down, or by an older daemon).
func (p *DockerPlugin) sweepSetMemberStateOrphans(members func() []string) {
	if p.cfg == nil || p.cfg.StateDir == "" {
		return
	}
	files := setMemberStateFiles(p.cfg.StateDir)
	if len(files) == 0 {
		return
	}
	keep := map[string]bool{}
	for _, id := range members() {
		keep[id] = true
	}
	inUse, known := p.availabilitySetsOfRecords()
	if !known {
		// Without the records it cannot tell which sets a member still needs.
		return
	}
	for _, id := range inUse {
		keep[id] = true
	}
	removed := 0
	for setID, paths := range files {
		if keep[setID] {
			continue
		}
		if p.setMembers != nil {
			if _, ok := p.setMembers.Config(setID); ok {
				continue
			}
		}
		removeSetMemberStateFiles(paths, setID, p.logger)
		removed += len(paths)
	}
	if removed > 0 && p.logger != nil {
		p.logger.Info("removed the state files of availability set members this node no longer has", "files", removed)
	}
}
