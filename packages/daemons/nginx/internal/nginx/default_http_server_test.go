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
	for _, want := range []string{"location / {\n        return 404;\n    }", "error_page 400 414 /.well-known/opfield-error;", "location @opfield_error {", "location /nginx_status {", "location /.well-known/acme-challenge/ {"} {
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
