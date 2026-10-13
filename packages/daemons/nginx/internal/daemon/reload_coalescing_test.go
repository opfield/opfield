package daemon

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	sharedstate "github.com/opfield/opfield/daemon-shared/state"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

const (
	reloadTestHostA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	reloadTestHostB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	reloadTestCert  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

type reloadTestHandler struct {
	*Handler
	invocations string
	stateDir    string
}

// newReloadTestHandler runs the handler against a fake nginx that records every invocation.
func newReloadTestHandler(t *testing.T) *reloadTestHandler {
	t.Helper()
	dir := t.TempDir()
	configDir := filepath.Join(dir, "conf.d")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	invocations := filepath.Join(dir, "invocations")
	binary := filepath.Join(dir, "nginx")
	script := "#!/bin/sh\necho \"$@\" >> '" + invocations + "'\nexit 0\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(dir, "state")
	st, err := sharedstate.Load(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Nginx: config.NginxConfig{
		Binary: binary, ConfigDir: configDir, CertsDir: filepath.Join(dir, "certs"),
		HtpasswdDir: filepath.Join(dir, "htpasswd"), GlobalConfig: filepath.Join(dir, "nginx.conf"),
	}}
	writeSyncTestFile(t, cfg.Nginx.GlobalConfig, "http {}\n")
	mgr := nginx.NewManager(binary, configDir, cfg.Nginx.CertsDir, cfg.Nginx.GlobalConfig)
	mgr.SetReloadPendingMarker(filepath.Join(stateDir, "nginx-reload-pending"))
	handler := &Handler{cfg: cfg, mgr: mgr, state: st, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	t.Cleanup(handler.cancelDeferredReload)
	return &reloadTestHandler{Handler: handler, invocations: invocations, stateDir: stateDir}
}

func (h *reloadTestHandler) reloads(t *testing.T) int {
	t.Helper()
	data, err := os.ReadFile(h.invocations)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(data), "-s reload")
}

func (h *reloadTestHandler) run(t *testing.T, command *pb.OpfieldCommand) {
	t.Helper()
	if result := h.HandleCommand(command); !result.Success {
		t.Fatalf("command failed: %s", result.Error)
	}
}

func applyConfig(hostID, content string, deferred bool) *pb.OpfieldCommand {
	return &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_ApplyConfig{ApplyConfig: &pb.ApplyConfigCommand{
		HostId: hostID, ConfigContent: content, DeferReload: deferred,
	}}}
}

func tlsBundle(hostID, content, version, replicaGeneration string, deferred bool) *pb.OpfieldCommand {
	return &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_ApplyTlsBundle{ApplyTlsBundle: &pb.ApplyTlsBundleCommand{
		HostId: hostID, ConfigContent: content, Generation: strings.Repeat("e", 64), DeferReload: deferred,
		Certificates: []*pb.VersionedCertBundle{{
			CertId: reloadTestCert, CertPem: []byte("certificate\n"), KeyPem: []byte("key\n"),
			Version: version, ReplicaGeneration: replicaGeneration,
		}},
	}}}
}

// TestReconnectResyncOfUnchangedContentDoesNotReload: Gateway re-sends every route and TLS bundle when a
// node reconnects; content nginx already runs causes no reload.
func TestReconnectResyncOfUnchangedContentDoesNotReload(t *testing.T) {
	h := newReloadTestHandler(t)
	versionA := strings.Repeat("a", 64)
	h.run(t, applyConfig(reloadTestHostA, "server { listen 80; }\n", false))
	h.run(t, tlsBundle(reloadTestHostB, "server { listen 443 ssl; }\n", versionA, "1", false))
	if got := h.reloads(t); got != 2 {
		t.Fatalf("initial applies reloaded %d times, want 2", got)
	}

	// The reconnect resync: the same routes, the bundle with a new replica generation, then the full sync.
	h.run(t, applyConfig(reloadTestHostA, "server { listen 80; }\n", true))
	h.run(t, tlsBundle(reloadTestHostB, "server { listen 443 ssl; }\n", versionA, "2", true))
	h.run(t, &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_FullSync{FullSync: &pb.FullSyncCommand{Hosts: []*pb.HostConfig{
		{HostId: reloadTestHostA, ConfigContent: "server { listen 80; }\n"},
		{HostId: reloadTestHostB, ConfigContent: "server { listen 443 ssl; }\n"},
	}}}})
	// An immediate apply of the same content does not reload either.
	h.run(t, applyConfig(reloadTestHostA, "server { listen 80; }\n", false))
	if got := h.reloads(t); got != 2 {
		t.Fatalf("a resync of unchanged content reloaded nginx %d times", got-2)
	}
	generation, err := os.ReadFile(filepath.Join(h.cfg.Nginx.CertsDir, reloadTestCert, ".opfield-replica-generation"))
	if err != nil || string(generation) != "2" {
		t.Fatalf("replica generation of an unchanged bundle = %q, %v; want it recorded", generation, err)
	}
	if h.mgr.ReloadPending() {
		t.Fatal("a reload is pending after an unchanged resync")
	}
}

// TestDeferredChangesLoadWithOneReload: changes that arrive together (deferred by the reconnect resync) are
// each tested and loaded with a single reload, by the command that closes the batch or by the daemon itself.
func TestDeferredChangesLoadWithOneReload(t *testing.T) {
	h := newReloadTestHandler(t)
	h.run(t, applyConfig(reloadTestHostA, "server { listen 80; }\n", true))
	h.run(t, tlsBundle(reloadTestHostB, "server { listen 443 ssl; }\n", strings.Repeat("b", 64), "1", true))
	h.run(t, applyConfig(reloadTestHostA, "server { listen 8080; }\n", true))
	if got := h.reloads(t); got != 0 {
		t.Fatalf("deferred changes reloaded nginx %d times before the batch ended", got)
	}
	if _, err := os.Stat(filepath.Join(h.stateDir, "nginx-reload-pending")); err != nil {
		t.Fatalf("the pending reload is not recorded for a daemon restart: %v", err)
	}
	h.run(t, &pb.OpfieldCommand{Payload: &pb.OpfieldCommand_FullSync{FullSync: &pb.FullSyncCommand{Hosts: []*pb.HostConfig{
		{HostId: reloadTestHostA, ConfigContent: "server { listen 8080; }\n"},
		{HostId: reloadTestHostB, ConfigContent: "server { listen 443 ssl; }\n"},
	}}}})
	if got := h.reloads(t); got != 1 {
		t.Fatalf("a batch of three changes reloaded nginx %d times, want 1", got)
	}
	if _, err := os.Stat(filepath.Join(h.stateDir, "nginx-reload-pending")); !os.IsNotExist(err) {
		t.Fatalf("the pending reload marker outlived the reload: %v", err)
	}

	// Without a command that closes the batch, the daemon reloads once the batch went quiet.
	h.run(t, applyConfig(reloadTestHostA, "server { listen 8081; }\n", true))
	h.run(t, applyConfig(reloadTestHostB, "server { listen 8443; }\n", true))
	deadline := time.Now().Add(deferredReloadQuiet + 3*time.Second)
	for h.reloads(t) < 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := h.reloads(t); got != 2 {
		t.Fatalf("a quiet batch of two changes reloaded nginx %d times, want 1", got-1)
	}
}
