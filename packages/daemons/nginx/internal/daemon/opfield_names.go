package daemon

// Moving an ingress node from the pre-Opfield names (/etc/nginx/gateway, /run/gateway-*, $gateway_* variables,
// 00-gateway-*.conf files, the gateway_combined log format) to the Opfield ones (internal/naming).
//
// A node installed before 2.12.1 keeps the pre-Opfield names until the start of this daemon is confirmed: the launcher
// committed the update, so it can no longer roll back to a daemon that knows only those names. Until then the daemon
// writes them, and Opfield renders the node's configs with them (the node does not report naming.Capability).
//
// The move then runs once, under the handler's mutation lock, so no command changes the configuration meanwhile:
//
//  1. Every Opfield directory must be possible: it exists, or the daemon may create it. A daemon running as its own
//     user cannot create directories in /run; the service manager creates them (the installer lists them), and until
//     it does the node keeps its names.
//  2. The files whose content carries pre-Opfield names are read: everything under the config directory (route
//     configs, Pages includes and previews, the daemon's own files), the files the installer keeps in
//     /etc/nginx/gateway, the installer's default HTTP server, and nginx.conf.
//  3. The directories move (hostrename.Move: the old name stays as a link to the new one, so configs that name it
//     keep working; both names are valid from here on, whatever happens next).
//  4. The daemon switches to the Opfield names and rewrites the files: names replaced (naming.Normalize), its own
//     files renamed and regenerated, nginx.conf's include lines, comments and log format replaced.
//  5. nginx -t, then a reload. If either fails, every file goes back to what step 2 read and the daemon returns to
//     the pre-Opfield names; nginx never loads a configuration that did not pass nginx -t, and keeps running the one
//     it had. The next start tries again.
//  6. A marker in the state directory records the move; the control session registers again with the new capability,
//     and Opfield renders the node's configs with the Opfield names from then on (the same content the rewrite
//     produced, so nothing reloads).
//
// Every step can run again after a crash: the directories finish moving, files already rewritten have nothing left to
// replace, and the marker is written last.

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/opfield/opfield/daemon-shared/hostrename"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// namesMarkerFile in the state directory records that the node runs with the Opfield names.
const namesMarkerFile = "opfield-names"

// nodeDirs and legacyEtcDir are the node directories the move handles (variables for tests).
var (
	nodeDirs     = naming.Dirs
	legacyEtcDir = naming.LegacyEtcDir
)

// daemonOwnedConfigFiles are the files the daemon keeps in the config directory, under their Opfield names.
var daemonOwnedConfigFiles = []string{
	"00-opfield-default-server.conf",
	"00-opfield-maintenance.conf",
	"00-opfield-ingress-generation.conf",
	"00-opfield-ingress-health.conf",
}

// resolveNames picks the names this start uses and puts the configured paths under them. It reports whether the node
// still has to move to the Opfield names. A node without anything under a pre-Opfield name (a new install) uses the
// Opfield names at once.
func resolveNames(cfg *config.Config, stateDir string, logger *slog.Logger) (migrationDue bool) {
	marker := filepath.Join(stateDir, namesMarkerFile)
	_, markerErr := os.Stat(marker)
	_, legacyErr := os.Lstat(legacyEtcDir)
	switch {
	case markerErr == nil:
		naming.SetLegacy(false)
	case errors.Is(legacyErr, os.ErrNotExist):
		naming.SetLegacy(false)
		if err := writeNamesMarker(stateDir); err != nil && logger != nil {
			logger.Warn("could not record the Opfield names of the node", "path", marker, "error", err)
		}
	default:
		naming.SetLegacy(true)
		migrationDue = true
	}
	// legacy-name: config files written before 2.12.1 name /etc/nginx/gateway paths — remove once every node reports none
	cfg.Nginx.ConfigDir = naming.Path(cfg.Nginx.ConfigDir)
	cfg.Nginx.HtpasswdDir = naming.Path(cfg.Nginx.HtpasswdDir)
	return migrationDue
}

func writeNamesMarker(stateDir string) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	return nginx.WriteAtomic(filepath.Join(stateDir, namesMarkerFile), []byte("opfield\n"))
}

// migrateNames moves the node to the Opfield names (see the file comment). It runs once per process.
func (p *NginxPlugin) migrateNames() {
	p.namesMigrationMu.Lock()
	defer p.namesMigrationMu.Unlock()
	if p.handler == nil || !p.namesMigrationDue {
		return
	}
	p.handler.mutationMu.Lock()
	defer p.handler.mutationMu.Unlock()
	p.namesMigrationDue = false
	logger := p.logger
	if err := p.moveToOpfieldNames(logger); err != nil {
		logger.Warn("nginx node keeps its pre-Opfield names; the next daemon start tries again", "error", err)
		return
	}
	logger.Info("moved the nginx node to its Opfield names", "config_dir", naming.EtcDir)
	p.refreshRegistration()
}

// namesFileChange is one file the move rewrites: its content before (nil: it did not exist) and after.
type namesFileChange struct {
	path     string
	original []byte
	next     []byte
}

func (p *NginxPlugin) moveToOpfieldNames(logger *slog.Logger) error {
	for _, dir := range nodeDirs() {
		if err := opfieldDirPossible(dir); err != nil {
			return err
		}
	}
	files, err := p.namedFiles()
	if err != nil {
		return err
	}
	original := map[string][]byte{}
	for _, path := range files {
		content, err := nginx.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		if content != nil {
			original[path] = content
		}
	}
	keepLegacyLogFormat := true
	if effective, err := p.mgr.EffectiveConfig(); err == nil {
		keepLegacyLogFormat = nginx.LegacyLogFormatInUse(string(effective))
	}

	undoChange, err := p.mgr.BeginChange()
	if err != nil {
		return err
	}
	for _, dir := range nodeDirs() {
		if err := moveNodeDir(dir); err != nil {
			undoChange()
			return fmt.Errorf("move %s to %s: %w", dir.Legacy, dir.Current, err)
		}
	}

	// The files are written under the paths this process started with: their old directory names link to the new ones.
	naming.SetLegacy(false)
	changes := opfieldFileChanges(original, p.cfg.Nginx.ConfigDir, p.cfg.Nginx.GlobalConfig, keepLegacyLogFormat)
	applied, err := applyNamesFileChanges(changes)
	rollback := func() {
		naming.SetLegacy(true)
		restoreNamesFileChanges(applied)
		_, _ = p.mgr.TestConfig()
	}
	if err != nil {
		rollback()
		undoChange()
		return err
	}
	// The daemon's own files get their current content (an older daemon may have written them).
	regenerated, err := p.regenerateOwnFiles(original)
	applied = append(applied, regenerated...)
	if err != nil {
		rollback()
		undoChange()
		return err
	}
	if valid, output := p.mgr.TestConfig(); !valid {
		rollback()
		undoChange()
		return fmt.Errorf("nginx rejects the configuration with the Opfield names: %s", strings.TrimSpace(output))
	}
	if err := p.mgr.Reload(); err != nil {
		// nginx keeps running the configuration it had, which the restored files describe again; the reload stays
		// pending, so the next change or start loads them.
		rollback()
		return fmt.Errorf("nginx reload with the Opfield names: %w", err)
	}
	if err := writeNamesMarker(p.baseCfg.StateDir); err != nil {
		// The node runs with the Opfield names; the next start finds nothing left to rewrite and records it then.
		logger.Warn("could not record the Opfield names of the node", "error", err)
	}
	if err := os.RemoveAll(nginx.LegacyIngressHealthCertDir(p.cfg.Nginx.CertsDir)); err != nil {
		logger.Warn("could not remove the pre-Opfield certificate of the reserved health server", "error", err)
	}
	return nil
}

// opfieldDirPossible reports an error when the Opfield name of dir cannot exist: it does not, and its parent cannot
// be written (a daemon running as its own user, in /run).
func opfieldDirPossible(dir naming.DirPair) error {
	if _, err := os.Lstat(dir.Current); err == nil {
		return nil
	}
	if err := unix.Access(filepath.Dir(dir.Current), unix.W_OK); err != nil {
		return fmt.Errorf("%s cannot be created (%v): the service manager must create it; run the node installer again", dir.Current, err)
	}
	return nil
}

// moveNodeDir moves one directory to its Opfield name and leaves the old name as a link to it. Two existing
// directories in a parent the daemon cannot write (/run for a daemon running as its own user) keep both names; their
// entries move one by one.
func moveNodeDir(dir naming.DirPair) error {
	pair := hostrename.Pair{Old: dir.Legacy, New: dir.Current}
	_, legacyErr := os.Lstat(dir.Legacy)
	currentInfo, currentErr := os.Lstat(dir.Current)
	if errors.Is(legacyErr, os.ErrNotExist) {
		if currentErr == nil {
			return nil
		}
		// Neither exists (no socket was ever made there): make the new one, the old name linking to it, since this
		// process keeps using the old path.
		_, err := hostrename.EnsureRunDir(pair, 0o755)
		return err
	}
	bothDirs := currentErr == nil && currentInfo.IsDir() && currentInfo.Mode()&os.ModeSymlink == 0
	if bothDirs && unix.Access(filepath.Dir(dir.Current), unix.W_OK) != nil {
		return naming.MoveEntries(dir.Legacy, dir.Current)
	}
	_, err := hostrename.Move(pair)
	if err != nil && errors.Is(err, hostrename.ErrConflict) && bothDirs {
		return naming.MoveEntries(dir.Legacy, dir.Current)
	}
	return err
}

// namedFiles are the files whose content may carry pre-Opfield names, under the paths this process started with.
func (p *NginxPlugin) namedFiles() ([]string, error) {
	var files []string
	err := filepath.WalkDir(p.cfg.Nginx.ConfigDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.Type().IsRegular() {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", p.cfg.Nginx.ConfigDir, err)
	}
	// The installer's files in the shared directory (sites.include.conf, stub_status.conf).
	if entries, err := os.ReadDir(legacyEtcDir); err == nil {
		for _, entry := range entries {
			path := filepath.Join(legacyEtcDir, entry.Name())
			if entry.Type().IsRegular() && !isUnder(path, p.cfg.Nginx.ConfigDir) {
				files = append(files, path)
			}
		}
	}
	files = append(files, nginx.InstallerDefaultHTTPServers(p.cfg.Nginx.GlobalConfig)...)
	if p.cfg.Nginx.GlobalConfig != "" {
		files = append(files, p.cfg.Nginx.GlobalConfig)
	}
	return files, nil
}

func isUnder(path, dir string) bool {
	return path == dir || strings.HasPrefix(path, strings.TrimSuffix(dir, "/")+"/")
}

// opfieldFileChanges computes the rewrite of every file read: names replaced, nginx.conf rewritten, and the daemon's
// own files under their Opfield file names.
func opfieldFileChanges(original map[string][]byte, configDir, globalConfig string, keepLegacyLogFormat bool) []namesFileChange {
	var changes []namesFileChange
	for path, content := range original {
		var next string
		if path == globalConfig {
			next = nginx.OpfieldGlobalConfig(string(content), keepLegacyLogFormat)
		} else {
			next = naming.Normalize(string(content))
		}
		target := path
		if filepath.Dir(path) == filepath.Clean(configDir) {
			for _, name := range daemonOwnedConfigFiles {
				if filepath.Base(path) == naming.LegacyFile(name) {
					target = filepath.Join(configDir, name)
				}
			}
		}
		if target != path {
			changes = append(changes, namesFileChange{path: target, next: []byte(next)}, namesFileChange{path: path, original: content})
			continue
		}
		if next != string(content) {
			changes = append(changes, namesFileChange{path: path, original: content, next: []byte(next)})
		}
	}
	return changes
}

// applyNamesFileChanges writes the changes in order and returns those applied, with what each path held before.
func applyNamesFileChanges(changes []namesFileChange) ([]namesFileChange, error) {
	applied := make([]namesFileChange, 0, len(changes))
	for _, change := range changes {
		before, err := nginx.ReadFile(change.path)
		if err != nil {
			return applied, err
		}
		if change.original != nil && !bytes.Equal(before, change.original) {
			return applied, fmt.Errorf("%s changed during the move to the Opfield names", change.path)
		}
		if change.next == nil {
			err = nginx.RemoveFile(change.path)
		} else {
			err = writeKeepingMode(change.path, change.next)
		}
		if err != nil {
			return applied, err
		}
		applied = append(applied, namesFileChange{path: change.path, original: before, next: change.next})
	}
	return applied, nil
}

// writeKeepingMode writes a file atomically with the permissions it had (the installer's files and nginx.conf are
// read by nginx workers; a new file gets 0644).
func writeKeepingMode(path string, content []byte) error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if err := nginx.WriteAtomic(path, content); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

// restoreNamesFileChanges puts back what every applied change replaced, last first.
func restoreNamesFileChanges(applied []namesFileChange) {
	for index := len(applied) - 1; index >= 0; index-- {
		change := applied[index]
		if change.original == nil {
			_ = nginx.RemoveFile(change.path)
		} else {
			_ = writeKeepingMode(change.path, change.original)
		}
	}
}

// regenerateOwnFiles writes the current content of the daemon's own files that the node had, under the Opfield
// names, and returns what it changed.
func (p *NginxPlugin) regenerateOwnFiles(original map[string][]byte) ([]namesFileChange, error) {
	configDir := p.cfg.Nginx.ConfigDir
	had := func(name string) bool {
		_, ok := original[filepath.Join(configDir, naming.LegacyFile(name))]
		if !ok {
			_, ok = original[filepath.Join(configDir, name)]
		}
		return ok
	}
	type regeneration struct {
		name  string
		write func() error
	}
	regenerations := []regeneration{
		{name: "00-opfield-default-server.conf", write: func() error { _, err := nginx.EnsureDefaultServer(configDir); return err }},
		{name: "00-opfield-maintenance.conf", write: func() error { _, _, err := nginx.EnsureMaintenanceGuardConfig(configDir); return err }},
		{name: "00-opfield-ingress-health.conf", write: func() error {
			if _, err := nginx.EnsureIngressHealthCertificate(p.cfg.Nginx.CertsDir, time.Now()); err != nil {
				return err
			}
			_, err := nginx.EnsureIngressHealthServer(configDir, p.cfg.Nginx.CertsDir)
			return err
		}},
	}
	var changed []namesFileChange
	for _, item := range regenerations {
		if !had(item.name) {
			continue
		}
		path := filepath.Join(configDir, item.name)
		before, err := nginx.ReadFile(path)
		if err != nil {
			return changed, err
		}
		if err := item.write(); err != nil {
			return changed, fmt.Errorf("write %s: %w", path, err)
		}
		changed = append(changed, namesFileChange{path: path, original: before})
	}
	// The installer's default HTTP server answers the Opfield health path too.
	if path, before, patched, ok := nginx.DefaultHTTPServerHealthPatch(p.cfg.Nginx.GlobalConfig); ok {
		if err := writeKeepingMode(path, patched); err != nil {
			return changed, err
		}
		changed = append(changed, namesFileChange{path: path, original: before})
	}
	return changed, nil
}
