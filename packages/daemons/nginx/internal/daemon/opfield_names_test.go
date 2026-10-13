package daemon

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	sharedstate "github.com/opfield/opfield/daemon-shared/state"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

const namesTestHost = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

// A route config as Opfield rendered it for a node with the pre-Opfield names.
const namesTestLegacyRoute = `upstream gateway_secure_link_aaaa {
    server unix:/run/gateway-secure-links/` + namesTestHost + `.sock;
}
server {
    listen 80;
    if (-f /etc/nginx/gateway/maintenance/` + namesTestHost + `) {
        set $gateway_maintenance 1;
    }
    location = /.well-known/gateway-ingress-health {
        proxy_set_header X-Gateway-Ingress-Generation $gateway_ingress_generation;
    }
    location / {
        # gateway-managed-secure-link-upstream ` + namesTestHost + `
        proxy_pass http://gateway_secure_link_aaaa;
    }
}
`

type namesTestNode struct {
	plugin      *NginxPlugin
	root        string
	legacyEtc   string
	opfieldEtc  string
	configDir   string
	global      string
	invocations string
	files       map[string]string
}

// newNamesTestNode lays out a node with the pre-Opfield names under a temporary root, with a fake nginx whose
// "nginx -t" fails while failTest exists.
func newNamesTestNode(t *testing.T) *namesTestNode {
	t.Helper()
	root := t.TempDir()
	node := &namesTestNode{
		root:       root,
		legacyEtc:  filepath.Join(root, "etc", "gateway"),
		opfieldEtc: filepath.Join(root, "etc", "opfield"),
		global:     filepath.Join(root, "etc", "nginx.conf"),
	}
	node.configDir = filepath.Join(node.legacyEtc, "conf.d")
	dirs := []naming.DirPair{
		{Legacy: node.legacyEtc, Current: node.opfieldEtc},
		{Legacy: filepath.Join(root, "run", "gateway-secure-links"), Current: filepath.Join(root, "run", "opfield-secure-links")},
		{Legacy: filepath.Join(root, "run", "gateway-registry-links"), Current: filepath.Join(root, "run", "opfield-registry-links")},
	}
	previousDirs, previousEtc := nodeDirs, legacyEtcDir
	nodeDirs, legacyEtcDir = func() []naming.DirPair { return dirs }, node.legacyEtc
	t.Cleanup(func() {
		nodeDirs, legacyEtcDir = previousDirs, previousEtc
		naming.SetLegacy(false)
	})
	node.files = map[string]string{
		filepath.Join(node.configDir, "proxy-host-"+namesTestHost+".conf"):        namesTestLegacyRoute,
		filepath.Join(node.configDir, "00-gateway-maintenance.conf"):              "# Gateway managed\nmap $pid $gateway_maintenance {\n    default \"\";\n}\n",
		filepath.Join(node.configDir, "00-gateway-ingress-generation.conf"):       "map $pid $gateway_ingress_generation {\n    default \"5\";\n}\n",
		filepath.Join(node.configDir, "pages", "routes", namesTestHost+".inc"):    "# gateway-pages route x\nset $gateway_pages_runtime_config_path /p;\n",
		filepath.Join(node.legacyEtc, "sites.include.conf"):                       "include /etc/nginx/gateway/conf.d/*.conf;\n",
		filepath.Join(node.legacyEtc, "htpasswd", "access-list-1"):                "user:hash\n",
		filepath.Join(root, "run", "gateway-secure-links", namesTestHost+".sock"): "socket\n",
		node.global: "http {\n    # Gateway daemon log format (auto-injected)\n    log_format gateway_combined '$remote_addr';\n    include /etc/nginx/gateway/sites.include.conf;\n}\n",
	}
	for path, content := range node.files {
		writeNamesTestFile(t, path, content)
	}
	node.invocations = filepath.Join(root, "invocations")
	binary := filepath.Join(root, "nginx")
	failTest := filepath.Join(root, "fail-test")
	script := "#!/bin/sh\necho \"$@\" >> '" + node.invocations + "'\nif [ \"$1\" = \"-t\" ] && [ -e '" + failTest + "' ]; then echo 'nginx: [emerg] test' >&2; exit 1; fi\nexit 0\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(root, "state")
	st, err := sharedstate.Load(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Nginx: config.NginxConfig{
		Binary: binary, ConfigDir: node.configDir, CertsDir: filepath.Join(root, "certs"),
		HtpasswdDir: filepath.Join(node.legacyEtc, "htpasswd"), GlobalConfig: node.global,
	}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if due := resolveNames(cfg, stateDir, logger); !due || !naming.Legacy() {
		t.Fatalf("a node with %s must still move (due %v)", node.legacyEtc, due)
	}
	mgr := nginx.NewManager(binary, node.configDir, cfg.Nginx.CertsDir, node.global)
	handler := &Handler{cfg: cfg, mgr: mgr, state: st, logger: logger}
	t.Cleanup(handler.cancelDeferredReload)
	node.plugin = &NginxPlugin{
		cfg: cfg, baseCfg: &lifecycle.BaseConfig{StateDir: stateDir}, mgr: mgr, handler: handler, logger: logger,
		namesMigrationDue: true, registrationChanged: make(chan struct{}, 1),
	}
	return node
}

func (n *namesTestNode) read(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func TestMoveToOpfieldNames(t *testing.T) {
	node := newNamesTestNode(t)
	node.plugin.migrateNames()

	if naming.Legacy() {
		t.Fatal("the node still runs with the pre-Opfield names")
	}
	if !slices.Contains(node.plugin.capabilities(), naming.Capability) {
		t.Fatal("the Opfield names capability is not reported")
	}
	select {
	case <-node.plugin.registrationChanged:
	default:
		t.Fatal("the control session is not asked to register again")
	}
	if _, err := os.Stat(filepath.Join(node.root, "state", namesMarkerFile)); err != nil {
		t.Fatalf("marker: %v", err)
	}
	// The directories moved; the old names link to them, so the paths the process started with still work.
	for _, dir := range nodeDirs() {
		if info, err := os.Lstat(dir.Legacy); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s is not a link: %v", dir.Legacy, err)
		}
		if info, err := os.Lstat(dir.Current); err != nil || !info.IsDir() {
			t.Fatalf("%s is not a directory: %v", dir.Current, err)
		}
	}
	if content := node.read(t, filepath.Join(node.root, "run", "opfield-secure-links", namesTestHost+".sock")); content != "socket\n" {
		t.Fatal("the socket did not move with its directory")
	}
	newConfDir := filepath.Join(node.opfieldEtc, "conf.d")
	route := node.read(t, filepath.Join(newConfDir, "proxy-host-"+namesTestHost+".conf"))
	if route != naming.Normalize(namesTestLegacyRoute) || strings.Contains(route, "$gateway_") || strings.Contains(route, "/run/gateway-") {
		t.Fatalf("route config:\n%s", route)
	}
	if !strings.Contains(route, "location = /.well-known/gateway-ingress-health {") {
		t.Fatal("the pre-Opfield health path a monitor probes was dropped")
	}
	for _, name := range []string{"00-gateway-maintenance.conf", "00-gateway-ingress-generation.conf"} {
		if _, err := os.Stat(filepath.Join(newConfDir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s is still there", name)
		}
	}
	if guard := node.read(t, filepath.Join(newConfDir, "00-opfield-maintenance.conf")); guard != string(nginx.MaintenanceGuardContent()) {
		t.Fatalf("guard maps not regenerated:\n%s", guard)
	}
	if generation := node.read(t, filepath.Join(newConfDir, "00-opfield-ingress-generation.conf")); !strings.Contains(generation, "$opfield_ingress_generation") {
		t.Fatalf("generation file:\n%s", generation)
	}
	if include := node.read(t, filepath.Join(newConfDir, "pages", "routes", namesTestHost+".inc")); include != "# opfield-pages route x\nset $opfield_pages_runtime_config_path /p;\n" {
		t.Fatalf("Pages include:\n%s", include)
	}
	if sites := node.read(t, filepath.Join(node.opfieldEtc, "sites.include.conf")); sites != "include /etc/nginx/opfield/conf.d/*.conf;\n" {
		t.Fatalf("sites include:\n%s", sites)
	}
	global := node.read(t, node.global)
	if strings.Contains(global, "gateway") || !strings.Contains(global, "log_format opfield_combined") || !strings.Contains(global, "include /etc/nginx/opfield/sites.include.conf;") {
		t.Fatalf("nginx.conf:\n%s", global)
	}
	if htpasswd := node.read(t, filepath.Join(node.opfieldEtc, "htpasswd", "access-list-1")); htpasswd != "user:hash\n" {
		t.Fatal("htpasswd file changed")
	}
	invocations := node.read(t, node.invocations)
	if !strings.Contains(invocations, "-s reload") {
		t.Fatalf("nginx was not reloaded:\n%s", invocations)
	}

	// A config with the pre-Opfield names that arrives afterwards (Opfield has not seen the new capability yet) is
	// written with the Opfield ones.
	result := node.plugin.handler.HandleCommand(applyConfig(namesTestHost, namesTestLegacyRoute, false))
	if !result.Success {
		t.Fatal(result.Error)
	}
	if route := node.read(t, filepath.Join(newConfDir, "proxy-host-"+namesTestHost+".conf")); route != naming.Normalize(namesTestLegacyRoute) {
		t.Fatalf("applied config:\n%s", route)
	}
}

func TestMoveToOpfieldNamesRollsBackWhenNginxRejectsIt(t *testing.T) {
	node := newNamesTestNode(t)
	writeNamesTestFile(t, filepath.Join(node.root, "fail-test"), "x")
	node.plugin.migrateNames()

	if !naming.Legacy() {
		t.Fatal("the node switched to the Opfield names although nginx rejected them")
	}
	if slices.Contains(node.plugin.capabilities(), naming.Capability) {
		t.Fatal("the capability is reported")
	}
	if _, err := os.Stat(filepath.Join(node.root, "state", namesMarkerFile)); !os.IsNotExist(err) {
		t.Fatal("marker written")
	}
	// Every file is back as it was (read through the old names, which stay valid).
	for path, content := range node.files {
		if got := node.read(t, path); got != content {
			t.Fatalf("%s not restored:\n%s", path, got)
		}
	}
	for _, name := range []string{"00-opfield-maintenance.conf", "00-opfield-ingress-generation.conf"} {
		if _, err := os.Stat(filepath.Join(node.configDir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s left behind", name)
		}
	}
	if strings.Contains(node.read(t, node.invocations), "-s reload") {
		t.Fatal("nginx reloaded a configuration it rejected")
	}
	// Once per process: a second call does nothing.
	_ = os.Remove(filepath.Join(node.root, "fail-test"))
	node.plugin.migrateNames()
	if !naming.Legacy() {
		t.Fatal("the move ran twice in one process")
	}
}

func TestResolveNames(t *testing.T) {
	t.Cleanup(func() { naming.SetLegacy(false) })
	root := t.TempDir()
	previous := legacyEtcDir
	legacyEtcDir = filepath.Join(root, "gateway")
	t.Cleanup(func() { legacyEtcDir = previous })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	// A new install: no pre-Opfield directory.
	fresh := filepath.Join(root, "fresh-state")
	cfg := &config.Config{Nginx: config.NginxConfig{ConfigDir: "/etc/nginx/opfield/conf.d", HtpasswdDir: "/etc/nginx/opfield/htpasswd"}}
	if due := resolveNames(cfg, fresh, logger); due || naming.Legacy() {
		t.Fatal("a new install must use the Opfield names")
	}
	if _, err := os.Stat(filepath.Join(fresh, namesMarkerFile)); err != nil {
		t.Fatal("a new install records its names")
	}

	// A node installed before 2.12.1: its configured paths stay where its files are until it moves.
	if err := os.MkdirAll(legacyEtcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg = &config.Config{Nginx: config.NginxConfig{ConfigDir: "/etc/nginx/opfield/conf.d", HtpasswdDir: "/etc/nginx/gateway/htpasswd"}}
	if due := resolveNames(cfg, filepath.Join(root, "old-state"), logger); !due || !naming.Legacy() {
		t.Fatal("a node with the pre-Opfield directory must move")
	}
	if cfg.Nginx.ConfigDir != "/etc/nginx/gateway/conf.d" || cfg.Nginx.HtpasswdDir != "/etc/nginx/gateway/htpasswd" {
		t.Fatalf("legacy paths = %+v", cfg.Nginx)
	}

	// A node that moved: the marker wins over the old name (a link now), and the paths of its config file are mapped.
	if err := writeNamesMarker(fresh); err != nil {
		t.Fatal(err)
	}
	cfg = &config.Config{Nginx: config.NginxConfig{ConfigDir: "/etc/nginx/gateway/conf.d", HtpasswdDir: "/etc/nginx/gateway/htpasswd"}}
	if due := resolveNames(cfg, fresh, logger); due || naming.Legacy() {
		t.Fatal("a moved node must use the Opfield names")
	}
	if cfg.Nginx.ConfigDir != "/etc/nginx/opfield/conf.d" || cfg.Nginx.HtpasswdDir != "/etc/nginx/opfield/htpasswd" {
		t.Fatalf("opfield paths = %+v", cfg.Nginx)
	}
}

func TestKeptNamesCoverTheOtherDirectoryName(t *testing.T) {
	names := keptNames("/run/opfield-secure-links/a.sock#42")
	if len(names) != 2 || names[1] != "/run/gateway-secure-links/a.sock#42" {
		t.Fatalf("names = %v", names)
	}
	names = keptNames("/run/opfield-secure-links/a.loopback#127.64.0.1_9000")
	if len(names) != 2 || names[1] != "/run/gateway-secure-links/a.loopback#127.64.0.1_9000" {
		t.Fatalf("loopback names = %v", names)
	}
	if names := keptNames("/tmp/x.sock#1"); len(names) != 1 {
		t.Fatalf("names outside the node directories = %v", names)
	}
	if !sameSocketPath("/run/gateway-secure-links/a.sock", "/run/opfield-secure-links/a.sock") || sameSocketPath("/run/gateway-secure-links/a.sock", "/run/opfield-secure-links/b.sock") {
		t.Fatal("sameSocketPath")
	}
}

func writeNamesTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
