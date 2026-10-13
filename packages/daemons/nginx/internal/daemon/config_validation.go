package daemon

import (
	"context"
	"crypto/sha256"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

const (
	configValidationInterval = 5 * time.Minute
	configChangePollInterval = 10 * time.Second
	configChangeDebounce     = 2 * time.Second
)

type nginxConfigSnapshot struct {
	fingerprint string
}

func currentNginxConfigSnapshot(cfg config.NginxConfig) nginxConfigSnapshot {
	digest := sha256.New()
	roots := []struct {
		name string
		path string
	}{
		{name: "global", path: cfg.GlobalConfig},
		{name: "configs", path: cfg.ConfigDir},
		{name: "htpasswd", path: cfg.HtpasswdDir},
	}
	for _, root := range roots {
		writeConfigTreeFingerprint(digest, root.name, root.path)
	}
	writeActiveCertificatesFingerprint(digest, cfg.CertsDir)
	return nginxConfigSnapshot{fingerprint: fmt.Sprintf("%x", digest.Sum(nil))}
}

func writeConfigTreeFingerprint(digest hash.Hash, name, root string) {
	fmt.Fprintf(digest, "root\x00%s\x00%s\n", name, filepath.Clean(root))
	if root == "" {
		fmt.Fprintln(digest, "disabled")
		return
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			fmt.Fprintf(digest, "error\x00%s\x00%s\n", path, walkErr)
			return nil
		}
		// The config generation file changes with every reload by design; it is not a configuration change to
		// validate again.
		if entry.Name() == nginx.IngressGenerationFilename() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			fmt.Fprintf(digest, "error\x00%s\x00%s\n", path, err)
			return nil
		}
		inode := uint64(0)
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			inode = stat.Ino
		}
		fmt.Fprintf(
			digest,
			"entry\x00%s\x00%d\x00%d\x00%d\x00%d\n",
			path,
			info.Mode(),
			info.Size(),
			info.ModTime().UnixNano(),
			inode,
		)
		// File timestamps come from a coarse clock, so two same-size writes a few milliseconds apart
		// can leave identical metadata; hash the content of files written that recently.
		if info.Mode().IsRegular() && time.Since(info.ModTime()) < configRecentWriteWindow {
			writeFileContentFingerprint(digest, path)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				fmt.Fprintf(digest, "link-error\x00%s\x00%s\n", path, err)
			} else {
				fmt.Fprintf(digest, "link\x00%s\x00%s\n", path, target)
			}
		}
		return nil
	})
}

// configRecentWriteWindow bounds how long after a write a file's content is part of the fingerprint.
const configRecentWriteWindow = 2 * time.Second

func writeFileContentFingerprint(digest hash.Hash, path string) {
	file, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(digest, "content-error\x00%s\x00%s\n", path, err)
		return
	}
	defer file.Close()
	content := sha256.New()
	if _, err := io.Copy(content, file); err != nil {
		fmt.Fprintf(digest, "content-error\x00%s\x00%s\n", path, err)
		return
	}
	fmt.Fprintf(digest, "content\x00%s\x00%x\n", path, content.Sum(nil))
}

func writeActiveCertificatesFingerprint(digest hash.Hash, root string) {
	fmt.Fprintf(digest, "root\x00certificates\x00%s\n", filepath.Clean(root))
	entries, err := os.ReadDir(root)
	if err != nil {
		fmt.Fprintf(digest, "error\x00%s\x00%s\n", root, err)
		return
	}
	writePathFingerprint(digest, root)
	for _, entry := range entries {
		certRoot := filepath.Join(root, entry.Name())
		writePathFingerprint(digest, certRoot)
		if !entry.IsDir() {
			continue
		}
		for _, name := range []string{"fullchain.pem", "privkey.pem", "chain.pem"} {
			writePathFingerprint(digest, filepath.Join(certRoot, name))
		}
		current := filepath.Join(certRoot, "current")
		writePathFingerprint(digest, current)
		activeRoot := current
		if target, err := filepath.EvalSymlinks(current); err == nil {
			activeRoot = target
		}
		for _, name := range []string{"fullchain.pem", "privkey.pem", "chain.pem"} {
			writePathFingerprint(digest, filepath.Join(activeRoot, name))
		}
	}
}

func writePathFingerprint(digest hash.Hash, path string) {
	info, err := os.Lstat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Fprintf(digest, "error\x00%s\x00%s\n", path, err)
		}
		return
	}
	inode := uint64(0)
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		inode = stat.Ino
	}
	fmt.Fprintf(
		digest,
		"entry\x00%s\x00%d\x00%d\x00%d\x00%d\n",
		path,
		info.Mode(),
		info.Size(),
		info.ModTime().UnixNano(),
		inode,
	)
	if info.Mode()&os.ModeSymlink == 0 {
		return
	}
	target, err := os.Readlink(path)
	if err != nil {
		fmt.Fprintf(digest, "link-error\x00%s\x00%s\n", path, err)
	} else {
		fmt.Fprintf(digest, "link\x00%s\x00%s\n", path, target)
	}
}

func (p *NginxPlugin) acceptConfigSnapshot(snapshot nginxConfigSnapshot) {
	p.configWatchMu.Lock()
	p.validatedConfigFingerprint = snapshot.fingerprint
	p.pendingConfigFingerprint = ""
	p.configFingerprintReady = true
	p.configWatchMu.Unlock()
}

func (p *NginxPlugin) queueConfigSnapshot(snapshot nginxConfigSnapshot) bool {
	p.configWatchMu.Lock()
	defer p.configWatchMu.Unlock()
	if !p.configFingerprintReady {
		p.validatedConfigFingerprint = snapshot.fingerprint
		p.configFingerprintReady = true
		return false
	}
	if snapshot.fingerprint == p.validatedConfigFingerprint {
		p.pendingConfigFingerprint = ""
		return false
	}
	if snapshot.fingerprint == p.pendingConfigFingerprint {
		return false
	}
	p.pendingConfigFingerprint = snapshot.fingerprint
	return true
}

func (p *NginxPlugin) observeConfigChanges() bool {
	return p.queueConfigSnapshot(currentNginxConfigSnapshot(p.cfg.Nginx))
}

func (p *NginxPlugin) observeConfigTest() func() {
	before := currentNginxConfigSnapshot(p.cfg.Nginx)
	return func() {
		after := currentNginxConfigSnapshot(p.cfg.Nginx)
		if after.fingerprint == before.fingerprint {
			p.acceptConfigSnapshot(after)
		} else {
			p.queueConfigSnapshot(after)
		}
	}
}

func (p *NginxPlugin) hasPendingConfigSnapshot() bool {
	p.configWatchMu.Lock()
	defer p.configWatchMu.Unlock()
	return p.pendingConfigFingerprint != ""
}

func (p *NginxPlugin) validatePendingConfigChange() bool {
	return p.validatePendingConfigChangeWithHook(nil)
}

func (p *NginxPlugin) validatePendingConfigChangeWithHook(beforeTest func()) bool {
	snapshot := currentNginxConfigSnapshot(p.cfg.Nginx)
	p.configWatchMu.Lock()
	pending := p.pendingConfigFingerprint
	validated := p.validatedConfigFingerprint
	p.configWatchMu.Unlock()
	if pending == "" {
		return false
	}
	if snapshot.fingerprint == validated {
		p.acceptConfigSnapshot(snapshot)
		return false
	}
	if snapshot.fingerprint != pending {
		p.queueConfigSnapshot(snapshot)
		return true
	}

	expectedFingerprint := pending
	if beforeTest != nil {
		beforeTest()
	}
	ran, valid, output := p.mgr.TestConfigIf(func() bool {
		p.configWatchMu.Lock()
		defer p.configWatchMu.Unlock()
		return p.pendingConfigFingerprint == expectedFingerprint &&
			p.validatedConfigFingerprint != expectedFingerprint
	})
	if !ran {
		return p.hasPendingConfigSnapshot()
	}
	after := currentNginxConfigSnapshot(p.cfg.Nginx)
	if after.fingerprint != snapshot.fingerprint {
		p.queueConfigSnapshot(after)
		return p.hasPendingConfigSnapshot()
	}
	p.acceptConfigSnapshot(after)
	if !valid {
		p.logger.Warn("nginx configuration validation after filesystem change failed", "output", output)
	}
	return false
}

func (p *NginxPlugin) validateConfigIfStale(now time.Time) {
	_, checkedAt, checked := p.mgr.CachedConfigValidity()
	if checked && now.Sub(checkedAt) < configValidationInterval {
		return
	}
	valid, output := p.mgr.TestConfig()
	if !valid {
		p.logger.Warn("scheduled nginx configuration validation failed", "output", output)
	}
}

func (p *NginxPlugin) runConfigValidation(ctx context.Context) {
	p.runConfigValidationWithIntervals(ctx, configChangePollInterval, configChangeDebounce)
}

func (p *NginxPlugin) runConfigValidationWithIntervals(ctx context.Context, pollInterval, debounce time.Duration) {
	poll := time.NewTicker(pollInterval)
	defer poll.Stop()
	var debounceTimer *time.Timer
	var debounceC <-chan time.Time
	resetDebounce := func() {
		if debounceTimer == nil {
			debounceTimer = time.NewTimer(debounce)
		} else {
			if !debounceTimer.Stop() {
				select {
				case <-debounceTimer.C:
				default:
				}
			}
			debounceTimer.Reset(debounce)
		}
		debounceC = debounceTimer.C
	}
	defer func() {
		if debounceTimer != nil {
			debounceTimer.Stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-poll.C:
			if p.observeConfigChanges() {
				resetDebounce()
			}
			p.validateConfigIfStale(now)
		case <-debounceC:
			debounceC = nil
			if p.validatePendingConfigChange() {
				resetDebounce()
			}
		}
	}
}
