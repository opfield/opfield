package nginx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The HTTP default server the installer wrote in managed mode before 2.12.3 (scripts/setup-node.sh).
const installerDefaultServer = `server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
    }

    location /nginx_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
        access_log off;
    }

    location / {
        default_type text/html;
        return 404 '<!doctype html><html lang="en"><head><title>Page not found</title><style>body{font-family:Inter,"Segoe UI",sans-serif}</style></head><body><main><h1>Page not found</h1><div class="footer">Powered by <a href="https://opfield.dev" rel="noopener noreferrer">Opfield</a></div></main></body></html>';
    }
}
`

func TestDefaultHTTPServerMovesToErrorPagesOnce(t *testing.T) {
	root := t.TempDir()
	global := filepath.Join(root, "nginx.conf")
	path := DefaultHTTPServerPath(global)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(installerDefaultServer), 0o640); err != nil {
		t.Fatal(err)
	}
	previous, written, err := EnsureDefaultHTTPServerErrorPages(global)
	if err != nil || !written || string(previous) != installerDefaultServer {
		t.Fatalf("written=%v err=%v", written, err)
	}
	next, _ := os.ReadFile(path)
	text := string(next)
	for _, want := range []string{"location / {\n        return 404;\n    }", "error_page 400 414 505 /.well-known/opfield-error;", "location @opfield_error {", "location /nginx_status {", "location /.well-known/acme-challenge/ {"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "Page not found") {
		t.Fatal("the inline page is still there")
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	if _, written, err := EnsureDefaultHTTPServerErrorPages(global); err != nil || written {
		t.Fatalf("second run wrote=%v err=%v", written, err)
	}
}

func TestDefaultHTTPServerOfAnOperatorIsLeftAlone(t *testing.T) {
	root := t.TempDir()
	global := filepath.Join(root, "nginx.conf")
	path := DefaultHTTPServerPath(global)
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	own := "server {\n    listen 80 default_server;\n    location / {\n        return 404 'mine';\n    }\n}\n"
	_ = os.WriteFile(path, []byte(own), 0o644)
	if _, written, err := EnsureDefaultHTTPServerErrorPages(global); err != nil || written {
		t.Fatalf("wrote=%v err=%v", written, err)
	}
	// No file at all (integrate mode on a distribution without one): nothing to do.
	if _, written, err := EnsureDefaultHTTPServerErrorPages(filepath.Join(t.TempDir(), "nginx.conf")); err != nil || written {
		t.Fatalf("wrote=%v err=%v", written, err)
	}
}

func TestErrorPagesConfigReplacesTheOtherSchemesCopy(t *testing.T) {
	dir := t.TempDir()
	if _, written, err := EnsureErrorPagesConfig(dir); err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}
	if _, written, err := EnsureErrorPagesConfig(dir); err != nil || written {
		t.Fatalf("second run written=%v err=%v", written, err)
	}
}

// A default server on the pages of an earlier release (the installer writes the same two lines) gets 501 and 505.
func TestDefaultHTTPServerOnEarlierPagesGetsTheNewCodes(t *testing.T) {
	root := t.TempDir()
	global := filepath.Join(root, "nginx.conf")
	path := DefaultHTTPServerPath(global)
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	earlier := "server {\n    listen 80 default_server;\n    server_name _;\n\n    location / {\n        return 404;\n    }\n\n" +
		"    error_page 401 403 404 405 408 413 429 500 502 503 504 @opfield_error;\n    error_page 400 414 /.well-known/opfield-error;\n" +
		"    error_page 494 @opfield_error_494;\n    location @opfield_error {\n        default_type text/html;\n        return 200 $opfield_error_page;\n    }\n}\n"
	_ = os.WriteFile(path, []byte(earlier), 0o644)
	previous, written, err := EnsureDefaultHTTPServerErrorPages(global)
	if err != nil || !written || string(previous) != earlier {
		t.Fatalf("written=%v err=%v", written, err)
	}
	next, _ := os.ReadFile(path)
	want := strings.Replace(strings.Replace(earlier, " 500 502 ", " 500 501 502 ", 1), "400 414 /", "400 414 505 /", 1)
	if string(next) != want {
		t.Fatalf("got:\n%s", next)
	}
	if _, written, _ := EnsureDefaultHTTPServerErrorPages(global); written {
		t.Fatal("second run wrote")
	}
}

// The HTTPS catch-all answers an unknown Host (after a TLS handshake for a route's SNI) with the Opfield pages when
// the node keeps them, and stays the installer's plain file otherwise.
func TestDefaultServerAnswersWithTheErrorPages(t *testing.T) {
	dir := t.TempDir()
	if changed, err := EnsureDefaultServer(dir, false); err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	plain, _ := os.ReadFile(DefaultServerConfigPath(dir))
	if string(plain) != defaultServerConfig {
		t.Fatalf("plain catch-all:\n%s", plain)
	}
	if changed, err := EnsureDefaultServer(dir, true); err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	text, _ := os.ReadFile(DefaultServerConfigPath(dir))
	for _, want := range []string{
		"    listen 443 ssl default_server;\n    listen [::]:443 ssl default_server;\n    server_name _;\n    ssl_reject_handshake on;\n\n    location / {\n        return 404;\n    }\n\n    error_page ",
		"error_page 400 414 505 /.well-known/opfield-error;",
		"error_page 401 403 404 405 408 413 429 500 501 502 503 504 @opfield_error;",
		"    location @opfield_error_497 {",
	} {
		if !strings.Contains(string(text), want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	if !strings.HasSuffix(string(text), "    }\n}\n") || strings.Count(string(text), "server {") != 1 {
		t.Fatalf("one server block:\n%s", text)
	}
	if changed, _ := EnsureDefaultServer(dir, true); changed {
		t.Fatal("second run wrote")
	}
	// Without the variables again (a node that lost them), the plain file comes back.
	if changed, _ := EnsureDefaultServer(dir, false); !changed {
		t.Fatal("the plain catch-all must come back")
	}
}

func TestIngressHealthServerAnswersWithTheErrorPages(t *testing.T) {
	plain := IngressHealthServerConfig("/certs", false)
	if strings.Contains(plain, "error_page") || !strings.HasSuffix(plain, "    location / {\n        return 404;\n    }\n}\n") {
		t.Fatalf("plain:\n%s", plain)
	}
	pages := IngressHealthServerConfig("/certs", true)
	for _, want := range []string{"    location / {\n        return 404;\n    }\n\n    error_page ", "error_page 400 414 505 /.well-known/opfield-error;", "    location @opfield_error {"} {
		if !strings.Contains(pages, want) {
			t.Fatalf("missing %q in:\n%s", want, pages)
		}
	}
	if !strings.HasSuffix(pages, "    }\n}\n") {
		t.Fatalf("pages:\n%s", pages)
	}
}
