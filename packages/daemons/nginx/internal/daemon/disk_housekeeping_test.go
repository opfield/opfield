package daemon

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	sharedstate "github.com/opfield/opfield/daemon-shared/state"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

func TestRemoveOrphanedHostCachesKeepsServedAndRecentHosts(t *testing.T) {
	dir := t.TempDir()
	previous := hostCacheRoot
	hostCacheRoot = filepath.Join(dir, "tmp")
	t.Cleanup(func() { hostCacheRoot = previous })
	configDir := filepath.Join(dir, "conf")
	for _, path := range []string{hostCacheRoot, configDir} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	st, err := sharedstate.Load(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	handler := &Handler{
		cfg:    &config.Config{Nginx: config.NginxConfig{ConfigDir: configDir}},
		state:  st,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	old := time.Now().Add(-2 * time.Hour)
	for _, id := range []string{"active", "configured", "removed", "fresh"} {
		path := filepath.Join(hostCacheRoot, "nginx-cache-"+id)
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatal(err)
		}
		if id != "fresh" {
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	unrelated := filepath.Join(hostCacheRoot, "other-dir")
	if err := os.Mkdir(unrelated, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(unrelated, old, old)
	if err := os.WriteFile(filepath.Join(configDir, "proxy-host-configured.conf"), []byte("server {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Before the first full sync the node does not know its hosts: nothing goes.
	if removed := handler.removeOrphanedHostCaches(time.Now()); removed != 0 {
		t.Fatalf("removed %d caches before the first full sync", removed)
	}
	// Loaded from disk the list is []any; both forms count.
	st.SetExtra("active_host_ids", []any{"active"})
	if removed := handler.removeOrphanedHostCaches(time.Now()); removed != 1 {
		t.Fatalf("removed %d caches, want 1", removed)
	}
	if _, err := os.Lstat(filepath.Join(hostCacheRoot, "nginx-cache-removed")); !os.IsNotExist(err) {
		t.Fatal("cache of the removed host kept")
	}
	for _, path := range []string{"nginx-cache-active", "nginx-cache-configured", "nginx-cache-fresh", "other-dir"} {
		if _, err := os.Lstat(filepath.Join(hostCacheRoot, path)); err != nil {
			t.Fatalf("%s removed: %v", path, err)
		}
	}
}

func TestHostCacheRootsAddsNginxPrivateTmpOnlyWhenItDiffers(t *testing.T) {
	if roots := hostCacheRoots(0); len(roots) != 1 {
		t.Fatalf("roots without a master pid = %v", roots)
	}
	// This process shares the test's /tmp, so its namespace adds nothing.
	if roots := hostCacheRoots(os.Getpid()); len(roots) != 1 {
		t.Fatalf("roots for a shared /tmp = %v", roots)
	}
}

func TestUnknownHostsAnsweredNeedsBothManagedDefaultServers(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, "conf.d")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	global := filepath.Join(dir, "nginx.conf")
	plugin := &NginxPlugin{cfg: &config.Config{Nginx: config.NginxConfig{ConfigDir: configDir, GlobalConfig: global}}}
	if plugin.unknownHostsAnswered() {
		t.Fatal("answered without any default server")
	}
	if _, err := nginx.EnsureDefaultServer(configDir); err != nil {
		t.Fatal(err)
	}
	if plugin.unknownHostsAnswered() {
		t.Fatal("answered without the HTTP default server")
	}
	httpDefault := nginx.DefaultHTTPServerPath(global)
	if err := os.WriteFile(httpDefault, []byte("server {\n    listen 80 default_server;\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n    }\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if plugin.unknownHostsAnswered() {
		t.Fatal("an operator's own HTTP default server counted")
	}
	if err := os.WriteFile(httpDefault, []byte("server {\n    listen 80 default_server;\n    location / {\n        return 404;\n    }\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !plugin.unknownHostsAnswered() {
		t.Fatal("managed default servers not recognised")
	}
}
