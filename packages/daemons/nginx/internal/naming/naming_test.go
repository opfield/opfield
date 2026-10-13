package naming

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const legacyRoute = `upstream gateway_secure_link_aaaa {
    server unix:/run/gateway-secure-links/aaaa.sock;
}
server {
    if (-f /etc/nginx/gateway/maintenance/aaaa) {
        set $gateway_maintenance 1;
    }
    secure_link "$cookie_gateway_maintenance_access_sig,$cookie_gateway_maintenance_access_exp";
    location = gateway-maintenance-access {
        proxy_set_header X-Gateway-Maintenance-Host $host;
    }
    location = /_gateway/maintenance-access { return 204; }
    location = /.well-known/gateway-ingress-health {
        proxy_pass http://unix:/run/gateway-ingress-health/health.sock:/health;
        proxy_set_header X-Gateway-Ingress-Generation $gateway_ingress_generation;
    }
    location = /_gateway/pages/config.js { alias $gateway_pages_runtime_config_path; }
    location / {
        auth_basic_user_file /etc/nginx/gateway/htpasswd/access-list-1;
        # gateway-managed-secure-link-upstream aaaa
        proxy_pass http://gateway_secure_link_aaaa;
    }
}
`

func TestNormalizeAndToLegacyAreInverse(t *testing.T) {
	opfield := Normalize(legacyRoute)
	for _, old := range []string{"/run/gateway-secure-links/", "$gateway_maintenance", "gateway-maintenance-access", "X-Gateway-", "/_gateway/maintenance-access", "/etc/nginx/gateway/", "gateway_pages_", "gateway-managed-secure-link-upstream", "gateway_secure_link_", "/run/gateway-ingress-health/", "gateway_ingress_generation"} {
		if strings.Contains(opfield, old) {
			t.Errorf("normalized config still names %q:\n%s", old, opfield)
		}
	}
	// Both public paths keep their names: monitors and pages of customers use them.
	for _, kept := range []string{"/.well-known/gateway-ingress-health", "/_gateway/pages/config.js"} {
		if !strings.Contains(opfield, kept) {
			t.Errorf("normalized config lost %q", kept)
		}
	}
	if back := ToLegacy(opfield); back != legacyRoute {
		t.Fatalf("ToLegacy(Normalize(x)) differs:\n%s", back)
	}
	if again := Normalize(opfield); again != opfield {
		t.Fatal("Normalize is not idempotent")
	}
}

func TestRenderFollowsTheScheme(t *testing.T) {
	t.Cleanup(func() { SetLegacy(false) })
	content := "set $opfield_maintenance 1; include /etc/nginx/gateway/htpasswd/x;"
	SetLegacy(true)
	if got := Render(content); got != "set $gateway_maintenance 1; include /etc/nginx/gateway/htpasswd/x;" {
		t.Fatalf("legacy render = %q", got)
	}
	if got := Path("/etc/nginx/opfield/conf.d"); got != "/etc/nginx/gateway/conf.d" {
		t.Fatalf("legacy path = %q", got)
	}
	if got := File("00-opfield-maintenance.conf"); got != "00-gateway-maintenance.conf" {
		t.Fatalf("legacy file = %q", got)
	}
	SetLegacy(false)
	if got := Render(content); got != "set $opfield_maintenance 1; include /etc/nginx/opfield/htpasswd/x;" {
		t.Fatalf("opfield render = %q", got)
	}
	if got := Path("/etc/nginx/gateway/conf.d"); got != "/etc/nginx/opfield/conf.d" {
		t.Fatalf("opfield path = %q", got)
	}
	if got := Path("/etc/nginx/conf.d/sites"); got != "/etc/nginx/conf.d/sites" {
		t.Fatalf("a path outside the node directories changed: %q", got)
	}
	if got := Path("/run/gateway-secure-links-other"); got != "/run/gateway-secure-links-other" {
		t.Fatalf("a sibling of a node directory changed: %q", got)
	}
}

func TestAliasOfAndSameDir(t *testing.T) {
	if alias, ok := AliasOf("/run/opfield-secure-links/a.sock"); !ok || alias != "/run/gateway-secure-links/a.sock" {
		t.Fatalf("alias = %q %v", alias, ok)
	}
	if alias, ok := AliasOf("/run/gateway-registry-links"); !ok || alias != "/run/opfield-registry-links" {
		t.Fatalf("alias = %q %v", alias, ok)
	}
	if _, ok := AliasOf("/tmp/x.sock"); ok {
		t.Fatal("a path outside the node directories has an alias")
	}
	if !SameDir("/run/gateway-secure-links", "/run/opfield-secure-links") || SameDir("/run/gateway-secure-links", "/run/opfield-registry-links") {
		t.Fatal("SameDir")
	}
	if !SameDir("/tmp/a", "/tmp/a") {
		t.Fatal("SameDir of one path")
	}
}

func TestMoveEntriesLeavesLinksAndIsIdempotent(t *testing.T) {
	root := t.TempDir()
	legacy, current := filepath.Join(root, "gateway-links"), filepath.Join(root, "opfield-links")
	for _, dir := range []string{legacy, current} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(legacy, "a.sock"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(legacy, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A crash between the placeholder and the exchange left the self-pointing link of b.sock.
	if err := os.WriteFile(filepath.Join(legacy, "b.sock"), []byte("b"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(current, "b.sock"), filepath.Join(current, "b.sock")); err != nil {
		t.Fatal(err)
	}
	for round := 0; round < 2; round++ {
		if err := MoveEntries(legacy, current); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
	}
	for _, name := range []string{"a.sock", "b.sock", "sub"} {
		info, err := os.Lstat(filepath.Join(current, name))
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("%s is not under the new name: %v %v", name, info, err)
		}
		link, err := os.Readlink(filepath.Join(legacy, name))
		if err != nil || link != filepath.Join(current, name) {
			t.Fatalf("old name of %s = %q %v", name, link, err)
		}
		if _, err := os.Stat(filepath.Join(legacy, name)); err != nil {
			t.Fatalf("old name of %s does not resolve: %v", name, err)
		}
	}
	if content, err := os.ReadFile(filepath.Join(legacy, "b.sock")); err != nil || string(content) != "b" {
		t.Fatalf("b.sock through the old name = %q %v", content, err)
	}
}

func TestMoveEntriesRefusesAConflict(t *testing.T) {
	root := t.TempDir()
	legacy, current := filepath.Join(root, "old"), filepath.Join(root, "new")
	for _, dir := range []string{legacy, current} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "x"), []byte(dir), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := MoveEntries(legacy, current); !errors.Is(err, ErrEntryConflict) {
		t.Fatalf("err = %v, want a conflict", err)
	}
	if content, _ := os.ReadFile(filepath.Join(legacy, "x")); string(content) != legacy {
		t.Fatal("the old entry changed")
	}
}
