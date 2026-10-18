package daemon

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// diskHousekeepingInterval: how often the node removes what its commands leave behind (diskHousekeeping).
const diskHousekeepingInterval = time.Hour

// orphanHostCacheAge: a proxy cache directory of a host this node no longer serves is removed once it has not
// changed for this long.
const orphanHostCacheAge = time.Hour

// runDiskHousekeeping runs diskHousekeeping at session start and then every hour until the session ends.
func (p *NginxPlugin) runDiskHousekeeping(ctx context.Context) {
	ticker := time.NewTicker(diskHousekeepingInterval)
	defer ticker.Stop()
	for {
		p.diskHousekeeping(time.Now())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// diskHousekeeping bounds what the node keeps on disk between commands: Pages uploads, extraction stages,
// runtime-config generations and revoked previews (pages.Runtime.Sweep), certificate versions and stages
// (nginx.SweepCertificates), and proxy caches of hosts the node no longer serves. It holds the handler's mutation
// lock, so no command changes the files it looks at meanwhile; every existing node heals on the daemon update.
func (p *NginxPlugin) diskHousekeeping(now time.Time) {
	if p.handler == nil {
		return
	}
	p.handler.mutationMu.Lock()
	defer p.handler.mutationMu.Unlock()
	if p.pagesRuntime != nil {
		// A revoked preview's denial vhost may go only where the managed catch-all answers its hostname instead.
		_, err := os.Stat(nginx.DefaultServerConfigPath(p.cfg.Nginx.ConfigDir))
		result, err := p.pagesRuntime.Sweep(now, err == nil)
		if err != nil {
			p.logger.Warn("Pages disk housekeeping could not remove everything", "error", err)
		}
		if result.Total() > 0 {
			p.logger.Info("removed unused Pages files", "uploads", result.Uploads, "stages", result.Stages,
				"runtime_config_versions", result.RuntimeConfigVersions, "revoked_previews", result.RevokedPreviews,
				"temporary_files", result.TemporaryFiles)
		}
	}
	certs, err := nginx.SweepCertificates(p.cfg.Nginx.CertsDir, p.cfg.Nginx.ConfigDir, now)
	if err != nil {
		p.logger.Warn("certificate disk housekeeping could not remove everything", "error", err)
	}
	if certs.Versions > 0 || certs.Stages > 0 {
		p.logger.Info("removed unused certificate versions", "versions", certs.Versions, "stages", certs.Stages)
	}
	if removed := p.handler.removeOrphanedHostCaches(now); removed > 0 {
		p.logger.Info("removed proxy caches of removed routes", "caches", removed)
	}
}

// activeHostIDs is the host set of the last full sync, or false before the first one.
func (h *Handler) activeHostIDs() (map[string]bool, bool) {
	if h.state == nil {
		return nil, false
	}
	raw, found := h.state.GetExtra("active_host_ids")
	if !found {
		return nil, false
	}
	ids := map[string]bool{}
	switch values := raw.(type) {
	case []string:
		for _, id := range values {
			ids[id] = true
		}
	case []any:
		for _, value := range values {
			id, ok := value.(string)
			if !ok {
				return nil, false
			}
			ids[id] = true
		}
	default:
		return nil, false
	}
	return ids, true
}

// removeOrphanedHostCaches removes the proxy cache directories of hosts that are neither in the last full sync nor
// configured on the node, in /tmp and in nginx's own /tmp when its service has a private one. Route removal takes
// the cache with it; this covers removals before that also reached nginx's private /tmp.
func (h *Handler) removeOrphanedHostCaches(now time.Time) int {
	active, known := h.activeHostIDs()
	if !known {
		return 0
	}
	removed := 0
	for _, root := range hostCacheRoots(h.nginxMasterPID()) {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			hostID, found := strings.CutPrefix(entry.Name(), "nginx-cache-")
			if !found || !entry.IsDir() || hostCacheDir(hostID) == "" || active[hostID] {
				continue
			}
			if _, err := os.Lstat(filepath.Join(h.cfg.Nginx.ConfigDir, "proxy-host-"+hostID+".conf")); err == nil {
				continue
			}
			path := filepath.Join(root, entry.Name())
			info, err := os.Lstat(path)
			if err != nil || !info.IsDir() || info.ModTime().After(now.Add(-orphanHostCacheAge)) {
				continue
			}
			if nginx.RemoveDir(path) == nil {
				removed++
			}
		}
	}
	return removed
}

func (h *Handler) nginxMasterPID() int {
	if h.mgr == nil {
		return 0
	}
	pid, err := h.mgr.CachedPID()
	if err != nil {
		return 0
	}
	return pid
}

// hostCacheRoots are the directories proxy caches can live in: hostCacheRoot, and the same path inside the nginx
// master's mount namespace (a service with PrivateTmp writes /tmp/nginx-cache-<id> to its own /tmp).
func hostCacheRoots(masterPID int) []string {
	roots := []string{hostCacheRoot}
	if masterPID > 0 {
		private := filepath.Join("/proc", strconv.Itoa(masterPID), "root") + hostCacheRoot
		if !sameDirectory(private, hostCacheRoot) {
			roots = append(roots, private)
		}
	}
	return roots
}

func sameDirectory(a, b string) bool {
	first, err := os.Stat(a)
	if err != nil {
		return true // nothing to look at there
	}
	second, err := os.Stat(b)
	return err == nil && os.SameFile(first, second)
}

// unknownHostsAnswered reports whether the node's managed default servers answer every hostname no server block
// names: the HTTPS catch-all (handshake rejected) and the installer's HTTP default server answering 404. An operator's
// own default server (integrate mode) may serve something else, so then revoked previews keep their denial vhosts.
func (p *NginxPlugin) unknownHostsAnswered() bool {
	if _, err := os.Stat(nginx.DefaultServerConfigPath(p.cfg.Nginx.ConfigDir)); err != nil {
		return false
	}
	content, err := nginx.ReadFile(nginx.DefaultHTTPServerPath(p.cfg.Nginx.GlobalConfig))
	if err != nil || content == nil {
		return false
	}
	text := string(content)
	return strings.Contains(text, "listen 80 default_server;") && strings.Contains(text, "return 404")
}
