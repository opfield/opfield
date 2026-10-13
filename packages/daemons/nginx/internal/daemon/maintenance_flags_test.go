package daemon

import (
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

const maintenanceTestHostC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

func newMaintenanceFlagTestHandler(t *testing.T) *reloadTestHandler {
	t.Helper()
	h := newReloadTestHandler(t)
	h.maintenanceFlagDir = filepath.Join(t.TempDir(), "maintenance")
	return h
}

func (h *reloadTestHandler) flagged(hostID string) bool {
	_, err := os.Stat(filepath.Join(h.maintenanceFlagDir, hostID))
	return err == nil
}

func maintenanceApply(hostID, content string, flag pb.ProxyMaintenanceFlag) *pb.OpfieldCommand {
	command := applyConfig(hostID, content, false)
	command.GetApplyConfig().Maintenance = flag
	return command
}

// TestMaintenanceFlagChangesWithoutReload: Gateway toggles maintenance by re-sending the route's unchanged config
// with the new flag; only the flag file changes.
func TestMaintenanceFlagChangesWithoutReload(t *testing.T) {
	h := newMaintenanceFlagTestHandler(t)
	const config = "server { listen 80; }\n"
	h.run(t, maintenanceApply(reloadTestHostA, config, pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_OFF))
	if h.reloads(t) != 1 || h.flagged(reloadTestHostA) {
		t.Fatalf("first apply: reloads=%d flagged=%v, want 1 reload and no flag", h.reloads(t), h.flagged(reloadTestHostA))
	}

	h.run(t, maintenanceApply(reloadTestHostA, config, pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_ON))
	if !h.flagged(reloadTestHostA) {
		t.Fatal("entering maintenance did not set the flag")
	}
	info, err := os.Stat(filepath.Join(h.maintenanceFlagDir, reloadTestHostA))
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("flag file mode = %v, %v; nginx workers must be able to see it", info, err)
	}
	// A command that does not carry the flag (an older Gateway, a certificate renewal) keeps it.
	h.run(t, applyConfig(reloadTestHostA, config, false))
	if !h.flagged(reloadTestHostA) {
		t.Fatal("an apply without a maintenance state cleared the flag")
	}
	h.run(t, maintenanceApply(reloadTestHostA, config, pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_OFF))
	if h.flagged(reloadTestHostA) {
		t.Fatal("leaving maintenance kept the flag")
	}
	h.run(t, tlsBundle(reloadTestHostB, "server { listen 443 ssl; }\n", strings.Repeat("a", 64), "1", false))
	bundle := tlsBundle(reloadTestHostB, "server { listen 443 ssl; }\n", strings.Repeat("a", 64), "2", false)
	bundle.GetApplyTlsBundle().Maintenance = pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_ON
	h.run(t, bundle)
	if !h.flagged(reloadTestHostB) {
		t.Fatal("a TLS bundle entering maintenance did not set the flag")
	}
	if got := h.reloads(t); got != 2 {
		t.Fatalf("maintenance changes reloaded nginx %d times", got-2)
	}

	// A config test only never touches the flag.
	test := maintenanceApply(reloadTestHostA, config, pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_ON)
	test.GetApplyConfig().TestOnly = true
	h.run(t, test)
	if h.flagged(reloadTestHostA) {
		t.Fatal("a config test set the maintenance flag")
	}
}

// TestMaintenanceFlagIsRestoredWhenTheConfigIsRejected: a change nginx rejects leaves the route as it was, its
// maintenance included.
func TestMaintenanceFlagIsRestoredWhenTheConfigIsRejected(t *testing.T) {
	h := newMaintenanceFlagTestHandler(t)
	h.run(t, maintenanceApply(reloadTestHostA, "server { listen 80; }\n", pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_OFF))
	script := "#!/bin/sh\necho \"$@\" >> '" + h.invocations + "'\ncase \"$*\" in *-t*) exit 1;; esac\nexit 0\n"
	if err := os.WriteFile(h.cfg.Nginx.Binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result := h.HandleCommand(maintenanceApply(reloadTestHostA, "server { listen 81; }\n", pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_ON))
	if result.Success {
		t.Fatal("a config nginx rejects was applied")
	}
	if h.flagged(reloadTestHostA) {
		t.Fatal("the flag of a rejected change was kept")
	}
	if _, err := h.setMaintenanceFlag("../escape", pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_ON); err == nil {
		t.Fatal("a host id that is not a UUID named a flag file")
	}
}

// TestMaintenanceFlagsFollowTheRoutesTheNodeServes: a removed route and a route a full sync does not list lose their
// flags; a full sync sets the flags it carries without reloading unchanged configs.
func TestMaintenanceFlagsFollowTheRoutesTheNodeServes(t *testing.T) {
	h := newMaintenanceFlagTestHandler(t)
	on := pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_ON
	h.run(t, maintenanceApply(reloadTestHostA, "server { listen 80; }\n", on))
	h.run(t, maintenanceApply(reloadTestHostB, "server { listen 81; }\n", on))
	h.run(t, maintenanceApply(maintenanceTestHostC, "server { listen 82; }\n", on))

	h.run(t, &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_RemoveConfig{RemoveConfig: &pb.RemoveConfigCommand{HostId: maintenanceTestHostC}}})
	if h.flagged(maintenanceTestHostC) {
		t.Fatal("removing a route kept its maintenance flag")
	}
	reloads := h.reloads(t)
	h.run(t, &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_FullSync{FullSync: &pb.FullSyncCommand{Hosts: []*pb.HostConfig{
		{HostId: reloadTestHostA, ConfigContent: "server { listen 80; }\n", Maintenance: pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_OFF},
	}}}})
	if h.flagged(reloadTestHostA) {
		t.Fatal("the full sync did not clear the flag it carried")
	}
	if h.flagged(reloadTestHostB) {
		t.Fatal("the flag of a route the full sync does not list was kept")
	}
	h.run(t, &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_FullSync{FullSync: &pb.FullSyncCommand{Hosts: []*pb.HostConfig{
		{HostId: reloadTestHostA, ConfigContent: "server { listen 80; }\n", Maintenance: on},
	}}}})
	if !h.flagged(reloadTestHostA) {
		t.Fatal("the full sync did not set the flag it carried")
	}
	// The full sync removed host B's config (one reload); the flag changes reloaded nothing.
	if got := h.reloads(t) - reloads; got != 1 {
		t.Fatalf("the full syncs reloaded nginx %d times, want 1", got)
	}
}

// maintenanceMapsPlugin is a plugin whose nginx -t is the given binary ("true" accepts, "false" rejects).
func maintenanceMapsPlugin(t *testing.T, tester string) *NginxPlugin {
	t.Helper()
	binary, err := exec.LookPath(tester)
	if err != nil {
		t.Skipf("%s binary unavailable", tester)
	}
	configDir := t.TempDir()
	return &NginxPlugin{
		cfg:                       &config.Config{Nginx: config.NginxConfig{ConfigDir: configDir}},
		mgr:                       nginx.NewManager(binary, configDir, t.TempDir(), ""),
		maintenanceFlagsSupported: true,
	}
}

// TestMaintenanceGuardMapsReloadOnlyWhenRoutesUseAnOlderCopy: the first copy waits for the reload that brings the
// routes using it; a changed copy (a daemon update) reloads at once, because the routes already use the maps.
func TestMaintenanceGuardMapsReloadOnlyWhenRoutesUseAnOlderCopy(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := maintenanceMapsPlugin(t, "true")
	if p.ensureMaintenanceGuardMaps(logger) {
		t.Fatal("the first copy of the maps asked for a reload")
	}
	if p.ensureMaintenanceGuardMaps(logger) {
		t.Fatal("an unchanged copy asked for a reload")
	}
	path := nginx.MaintenanceGuardConfigPath(p.cfg.Nginx.ConfigDir)
	if err := os.WriteFile(path, []byte("# an older copy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !p.ensureMaintenanceGuardMaps(logger) || !p.maintenanceFlagsSupported {
		t.Fatalf("a changed copy did not ask for a reload (supported=%v)", p.maintenanceFlagsSupported)
	}
}

// TestRejectedMaintenanceGuardMapsKeepThePreviousCopy: routes rendered for the flag guard use the maps, so a copy
// nginx rejects is replaced by the one before it instead of being removed.
func TestRejectedMaintenanceGuardMapsKeepThePreviousCopy(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := maintenanceMapsPlugin(t, "false")
	path := nginx.MaintenanceGuardConfigPath(p.cfg.Nginx.ConfigDir)
	older := []byte("# an older copy\n")
	if err := os.WriteFile(path, older, 0o644); err != nil {
		t.Fatal(err)
	}
	if p.ensureMaintenanceGuardMaps(logger) || !p.maintenanceFlagsSupported {
		t.Fatalf("a rejected update: supported=%v, want the previous maps kept", p.maintenanceFlagsSupported)
	}
	if content, err := os.ReadFile(path); err != nil || string(content) != string(older) {
		t.Fatalf("maps after a rejected update = %q, %v; want the previous copy", content, err)
	}

	first := maintenanceMapsPlugin(t, "false")
	if first.ensureMaintenanceGuardMaps(logger) || first.maintenanceFlagsSupported {
		t.Fatal("a rejected first copy left maintenance flags supported")
	}
	if _, err := os.Stat(nginx.MaintenanceGuardConfigPath(first.cfg.Nginx.ConfigDir)); !os.IsNotExist(err) {
		t.Fatalf("a rejected first copy stayed: %v", err)
	}
}
