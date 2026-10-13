package daemon

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	sharedstate "github.com/opfield/opfield/daemon-shared/state"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

func TestFullSyncRemovesOrphanedHtpasswd(t *testing.T) {
	const (
		hostID        = "11111111-1111-4111-8111-111111111111"
		routeList     = "22222222-2222-4222-8222-222222222222"
		previewList   = "33333333-3333-4333-8333-333333333333"
		deletedList   = "44444444-4444-4444-8444-444444444444"
		justDeployed  = "55555555-5555-4555-8555-555555555555"
		operatorsList = "66666666-6666-4666-8666-666666666666"
	)
	dir := t.TempDir()
	configDir := filepath.Join(dir, "conf.d")
	htpasswdDir := filepath.Join(dir, "htpasswd")
	globalConfig := filepath.Join(dir, "nginx.conf")
	for _, path := range []string{configDir, htpasswdDir} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	binary := filepath.Join(dir, "nginx")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	authFile := func(accessListID string) string {
		return "auth_basic_user_file /etc/nginx/gateway/htpasswd/access-list-" + accessListID + ";"
	}
	// A Pages preview and an operator's global config reference credentials outside the synced host configs.
	writeSyncTestFile(t, filepath.Join(configDir, "pages-preview-0123456789abcdef01234567.conf"), "server { "+authFile(previewList)+" }\n")
	writeSyncTestFile(t, globalConfig, "http { server { "+authFile(operatorsList)+" } }\n")
	old := time.Now().Add(-time.Hour)
	for _, accessListID := range []string{routeList, previewList, deletedList, justDeployed, operatorsList} {
		path := filepath.Join(htpasswdDir, "access-list-"+accessListID)
		writeSyncTestFile(t, path, "ops:$2y$10$hash\n")
		if accessListID != justDeployed {
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	unrelated := filepath.Join(htpasswdDir, "operator-users")
	writeSyncTestFile(t, unrelated, "ops:$2y$10$hash\n")
	if err := os.Chtimes(unrelated, old, old); err != nil {
		t.Fatal(err)
	}

	st, err := sharedstate.Load(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Nginx: config.NginxConfig{
		Binary: binary, ConfigDir: configDir, CertsDir: filepath.Join(dir, "certs"),
		HtpasswdDir: htpasswdDir, GlobalConfig: globalConfig,
	}}
	handler := &Handler{
		cfg: cfg, mgr: nginx.NewManager(binary, configDir, cfg.Nginx.CertsDir, globalConfig), state: st,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	result := &pb.CommandResult{Success: true}

	handler.handleFullSync(&pb.FullSyncCommand{Hosts: []*pb.HostConfig{{
		HostId:        hostID,
		ConfigContent: "server { " + authFile(routeList) + " }\n",
	}}}, result)

	if !result.Success {
		t.Fatalf("full sync failed: %s", result.Error)
	}
	for accessListID, kept := range map[string]bool{
		routeList: true, previewList: true, operatorsList: true, justDeployed: true, deletedList: false,
	} {
		_, err := os.Stat(filepath.Join(htpasswdDir, "access-list-"+accessListID))
		if kept && err != nil {
			t.Fatalf("credentials of %s were removed: %v", accessListID, err)
		}
		if !kept && !os.IsNotExist(err) {
			t.Fatalf("orphaned credentials of %s were kept: %v", accessListID, err)
		}
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("a file that is not access-list credentials was removed: %v", err)
	}
}

func writeSyncTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
}
