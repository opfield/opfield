package daemon

import (
	"log/slog"
	"os"
	"path/filepath"

	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

// workerReadableDirs are the directories nginx workers, which run as an unprivileged user (nginx, www-data), read at
// request time: htpasswd files, maintenance flags below the Opfield tree, and HTTP-01 challenges.
func workerReadableDirs(cfg *config.NginxConfig) []string {
	acme := cfg.AcmeChallengeDir
	return []string{
		naming.Path(naming.EtcDir),
		cfg.HtpasswdDir,
		filepath.Dir(acme),
		acme,
		filepath.Join(acme, ".well-known"),
		filepath.Join(acme, ".well-known", "acme-challenge"),
	}
}

// ensureWorkerReadableDirs gives those directories back the read and traversal bits nginx workers need. An installer
// run under a restrictive umask (hosted installs use 077) created them 0700: workers then answered basic
// authentication with 500 and never found maintenance flags or ACME challenges. Bits are only added, never removed.
func ensureWorkerReadableDirs(dirs []string, logger *slog.Logger) {
	for _, dir := range dirs {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		mode := info.Mode().Perm()
		if mode&0o055 == 0o055 {
			continue
		}
		if err := os.Chmod(dir, mode|0o055); err != nil {
			logger.Warn("nginx workers cannot read a directory they need", "path", dir, "mode", mode.String(), "error", err)
			continue
		}
		logger.Info("made a directory readable for nginx workers", "path", dir, "previous_mode", mode.String())
	}
}
