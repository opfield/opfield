package nginx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const legacyGlobalConfig = `http {
    # Gateway daemon log format (auto-injected)
    log_format gateway_combined '$remote_addr - $remote_user [$time_local] '
    '"$request" $status $body_bytes_sent '
    '"$http_referer" "$http_user_agent" '
    '$upstream_response_time $request_time';

    # Gateway Pages generated hostnames (auto-injected)
    server_names_hash_bucket_size 128;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/gateway/sites.include.conf;
    include /etc/nginx/gateway/stub_status.conf;
}
`

func TestOpfieldGlobalConfigRenamesOurParts(t *testing.T) {
	next := OpfieldGlobalConfig(legacyGlobalConfig, false)
	for _, want := range []string{
		"# Opfield daemon log format (auto-injected)",
		"log_format opfield_combined '$remote_addr",
		"# Opfield Pages generated hostnames (auto-injected)",
		"include /etc/nginx/opfield/sites.include.conf;",
		"include /etc/nginx/opfield/stub_status.conf;",
		"include /etc/nginx/conf.d/*.conf;",
	} {
		if !strings.Contains(next, want) {
			t.Errorf("missing %q in:\n%s", want, next)
		}
	}
	if strings.Contains(next, "gateway") || strings.Contains(next, "Gateway") {
		t.Fatalf("pre-Opfield names left:\n%s", next)
	}
	if again := OpfieldGlobalConfig(next, false); again != next {
		t.Fatal("not idempotent")
	}
}

func TestOpfieldGlobalConfigKeepsALogFormatInUse(t *testing.T) {
	next := OpfieldGlobalConfig(legacyGlobalConfig, true)
	if !strings.Contains(next, "log_format opfield_combined") || !strings.Contains(next, "log_format gateway_combined") {
		t.Fatalf("both formats expected:\n%s", next)
	}
	if !LegacyLogFormatInUse("log_format gateway_combined '';\naccess_log /x gateway_combined;\n") {
		t.Fatal("a use outside the definition is a use")
	}
	if LegacyLogFormatInUse("log_format gateway_combined '';\n") {
		t.Fatal("the definition alone is no use")
	}
}

func TestEnsureLogFormatUsesTheScheme(t *testing.T) {
	t.Cleanup(func() { naming.SetLegacy(false) })
	path := filepath.Join(t.TempDir(), "nginx.conf")
	for _, legacy := range []bool{true, false} {
		naming.SetLegacy(legacy)
		if err := os.WriteFile(path, []byte("http {\n}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if changed, err := EnsureLogFormat(path); err != nil || !changed {
			t.Fatalf("legacy=%v: changed %v err %v", legacy, changed, err)
		}
		content, _ := os.ReadFile(path)
		want := map[bool]string{true: "log_format gateway_combined", false: "log_format opfield_combined"}[legacy]
		if !strings.Contains(string(content), want) {
			t.Fatalf("legacy=%v:\n%s", legacy, content)
		}
		if changed, _ := EnsureLogFormat(path); changed {
			t.Fatalf("legacy=%v: second call changed the file", legacy)
		}
	}
}

func TestDaemonFilesFollowTheScheme(t *testing.T) {
	t.Cleanup(func() { naming.SetLegacy(false) })
	naming.SetLegacy(true)
	guard := string(MaintenanceGuardContent())
	if strings.Contains(guard, "opfield_") || !strings.Contains(guard, "map $pid $gateway_maintenance {") ||
		!strings.Contains(guard, "/_gateway/maintenance-access gateway-maintenance-access;") {
		t.Fatalf("legacy guard:\n%s", guard)
	}
	if filepath.Base(MaintenanceGuardConfigPath("/c")) != "00-gateway-maintenance.conf" || IngressGenerationFilename() != "00-gateway-ingress-generation.conf" ||
		filepath.Base(DefaultServerConfigPath("/c")) != "00-gateway-default-server.conf" || filepath.Base(IngressHealthServerPath("/c")) != "00-gateway-ingress-health.conf" {
		t.Fatal("legacy file names")
	}
	if location := IngressHealthLocation(); !strings.Contains(location, "unix:/run/gateway-ingress-health/health.sock") ||
		!strings.Contains(location, "X-Gateway-Ingress-Generation $gateway_ingress_generation") {
		t.Fatalf("legacy location:\n%s", location)
	}
	naming.SetLegacy(false)
	guard = string(MaintenanceGuardContent())
	if strings.Contains(guard, "gateway_") || strings.Contains(guard, "gateway-maintenance") {
		t.Fatalf("opfield guard:\n%s", guard)
	}
	// Both reserved health paths bypass maintenance, under either scheme.
	for _, path := range []string{"/.well-known/opfield-ingress-health \"\";", "/.well-known/gateway-ingress-health \"\";"} {
		if !strings.Contains(guard, path) {
			t.Fatalf("guard lacks %q", path)
		}
	}
	location := IngressHealthLocation()
	if strings.Count(location, "location = ") != 2 || !strings.Contains(location, "location = /.well-known/opfield-ingress-health {") ||
		!strings.Contains(location, "location = /.well-known/gateway-ingress-health {") || strings.Contains(location, "/run/gateway-") {
		t.Fatalf("opfield location:\n%s", location)
	}
}

// A default HTTP server a daemon before 2.12.1 patched has the pre-Opfield location; the patch adds only the Opfield
// one (a second location for the same path fails nginx -t).
func TestDefaultHTTPServerHealthPatchAddsOnlyMissingLocations(t *testing.T) {
	dir := t.TempDir()
	global := filepath.Join(dir, "nginx.conf")
	if err := os.MkdirAll(filepath.Join(dir, "conf.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	legacyPatched := "server {\n    listen 80 default_server;\n    server_name _;\n\n" + naming.ToLegacy(ingressHealthLocationFor(LegacyIngressHealthPath)) +
		"    location /.well-known/acme-challenge/ {\n    }\n    location /health {\n    }\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "conf.d", "default.conf"), []byte(legacyPatched), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, patched, ok := DefaultHTTPServerHealthPatch(global)
	if !ok {
		t.Fatal("no patch")
	}
	text := string(patched)
	if strings.Count(text, "location = /.well-known/gateway-ingress-health {") != 1 || strings.Count(text, "location = /.well-known/opfield-ingress-health {") != 1 {
		t.Fatalf("patched:\n%s", text)
	}
	if err := os.WriteFile(filepath.Join(dir, "conf.d", "default.conf"), patched, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, again := DefaultHTTPServerHealthPatch(global); again {
		t.Fatal("a server with both locations is patched again")
	}
	if found := InstallerDefaultHTTPServers(global); len(found) != 1 {
		t.Fatalf("installer default servers = %v", found)
	}
}

func TestCertificateMetadataUnderEitherName(t *testing.T) {
	t.Cleanup(func() { naming.SetLegacy(false) })
	root := filepath.Join(t.TempDir(), "certs")
	id := "11111111-1111-4111-8111-111111111111"
	if err := os.MkdirAll(filepath.Join(root, id), 0o755); err != nil {
		t.Fatal(err)
	}
	// A daemon before 2.12.1 wrote the replica generation under the pre-Opfield name.
	if err := os.WriteFile(filepath.Join(root, id, ".gateway-replica-generation"), []byte("7"), 0o644); err != nil {
		t.Fatal(err)
	}
	pointer, err := CurrentCertPointer(root, id)
	if err != nil || !pointer.ReplicaGenerationExists || pointer.ReplicaGeneration != "7" {
		t.Fatalf("pointer %+v err %v", pointer, err)
	}
	if err := writeReplicaGeneration(filepath.Join(root, id), "8"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, id, ".gateway-replica-generation")); !os.IsNotExist(err) {
		t.Fatal("the pre-Opfield copy stays and a daemon of the other scheme would read it")
	}
	if pointer, _ := CurrentCertPointer(root, id); pointer.ReplicaGeneration != "8" {
		t.Fatalf("generation = %q", pointer.ReplicaGeneration)
	}
	naming.SetLegacy(true)
	if err := writeReplicaGeneration(filepath.Join(root, id), "9"); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(filepath.Join(root, id, ".gateway-replica-generation")); string(content) != "9" {
		t.Fatal("a legacy node writes the pre-Opfield name, which a rolled back daemon reads")
	}
}

func TestIngressHealthCertificateNamesBothHostnames(t *testing.T) {
	certs := t.TempDir()
	if written, err := EnsureIngressHealthCertificate(certs, time.Now()); err != nil || !written {
		t.Fatalf("written %v err %v", written, err)
	}
	if written, _ := EnsureIngressHealthCertificate(certs, time.Now()); written {
		t.Fatal("a valid certificate is replaced")
	}
	if _, err := os.Stat(filepath.Join(certs, "opfield-ingress-health", "fullchain.pem")); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureDefaultServerKeepsOneCopy(t *testing.T) {
	t.Cleanup(func() { naming.SetLegacy(false) })
	dir := t.TempDir()
	for _, legacy := range []bool{true, false} {
		naming.SetLegacy(legacy)
		// The installer wrote the catch-all under the other scheme's name.
		other := map[bool]string{true: "00-opfield-default-server.conf", false: "00-gateway-default-server.conf"}[legacy]
		if err := os.WriteFile(filepath.Join(dir, other), []byte(defaultServerConfig), 0o644); err != nil {
			t.Fatal(err)
		}
		if changed, err := EnsureDefaultServer(dir); err != nil || !changed {
			t.Fatalf("legacy=%v: changed %v err %v", legacy, changed, err)
		}
		entries, _ := os.ReadDir(dir)
		if len(entries) != 1 || entries[0].Name() != filepath.Base(DefaultServerConfigPath(dir)) {
			t.Fatalf("legacy=%v: files %v", legacy, entries)
		}
	}
}
