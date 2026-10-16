package daemon

import (
	"path/filepath"
	"regexp"

	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// hostCacheRoot holds the per-host proxy cache directories that proxy host
// configs declare as proxy_cache_path /tmp/nginx-cache-<host id>: the cache of
// a route with caching enabled and the stale cache that keeps the public status
// page up while Opfield is unreachable. A variable so tests can move it.
var hostCacheRoot = "/tmp"

var hostCacheIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]+$`)

// hostCacheDir is the cache directory of a proxy host, or "" for an id that is
// not a plain host id (never a path outside hostCacheRoot).
func hostCacheDir(hostID string) string {
	if !hostCacheIDPattern.MatchString(hostID) {
		return ""
	}
	return filepath.Join(hostCacheRoot, "nginx-cache-"+hostID)
}

// removeHostCache deletes a removed proxy host's cache directory, also inside nginx's own /tmp when its service has
// a private one (hostCacheRoots).
func (h *Handler) removeHostCache(hostID string) {
	if hostCacheDir(hostID) == "" {
		return
	}
	for _, root := range hostCacheRoots(h.nginxMasterPID()) {
		_ = nginx.RemoveDir(filepath.Join(root, "nginx-cache-"+hostID))
	}
}
