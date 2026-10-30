package pages

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/opfield/opfield/nginx-daemon/internal/errorpages"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

// notFoundHTML is the generic Opfield 404 a preview answers a missing page with when the deployment has no 404.html.
var notFoundHTML = errorpages.NotFoundHTML

// previewAssetPattern names the static assets a preview caches for a year.
const previewAssetPattern = `\.(?:css|js|mjs|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?)$`

// PreviewFallback carries the per-preview serving options: missing-path
// handling and the optional Project access list.
type PreviewFallback struct {
	SPAFallback bool
	URL         string
	Access      *PreviewAccess
	// ClientIP takes the visitor's address from a trusted proxy (realip).
	ClientIP *PreviewClientIP
	// DeferReload loads the preview with the reload of its batch
	// (SetDeferredReload) instead of shortly after the last Pages change.
	DeferReload bool
}

func validPagesFallbackURL(value string) bool {
	if strings.IndexFunc(value, unicode.IsSpace) >= 0 || strings.ContainsAny(value, ";'\"{}\\`$#") {
		return false
	}
	parsed, err := url.ParseRequestURI(value)
	return err == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https")
}

func (r *Runtime) applyConfig(configPath string, next []byte) error {
	return r.applyConfigWith(configPath, next, false)
}

// applyConfigWith writes and tests a config; with SetDeferredReload the
// handler loads it (with deferred, with the reload of its batch), without it
// nginx reloads at once.
func (r *Runtime) applyConfigWith(configPath string, next []byte, batch bool) error {
	deferred := r.beginChange != nil && r.scheduleReload != nil
	old, err := os.ReadFile(configPath)
	oldExists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	next = naming.RenderBytes(next)
	if (next == nil && !oldExists) || (next != nil && oldExists && string(old) == string(next)) {
		return nil
	}
	undoChange := func() {}
	if deferred {
		if undoChange, err = r.beginChange(); err != nil {
			return err
		}
	}
	if next == nil {
		if err := os.Remove(configPath); err != nil && !os.IsNotExist(err) {
			undoChange()
			return err
		}
	} else if err := writeAtomic(configPath, next, 0o640); err != nil {
		undoChange()
		return err
	}
	restore := func() error {
		if oldExists {
			return writeAtomic(configPath, old, 0o640)
		}
		if err := os.Remove(configPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	valid, output := r.nginx.TestConfig()
	if !valid {
		_ = restore()
		undoChange()
		_, _ = r.nginx.TestConfig()
		return fmt.Errorf("nginx config test failed: %s", output)
	}
	if deferred {
		r.scheduleReload(batch)
		return nil
	}
	if err := r.nginx.Reload(); err != nil {
		if restoreErr := restore(); restoreErr != nil {
			return fmt.Errorf("nginx reload failed: %v; restore failed: %w", err, restoreErr)
		}
		if valid, output := r.nginx.TestConfig(); !valid {
			return fmt.Errorf("nginx reload failed: %v; restored config test failed: %s", err, output)
		}
		if restoreErr := r.nginx.Reload(); restoreErr != nil {
			return fmt.Errorf("nginx reload failed: %v; restore reload failed: %w", err, restoreErr)
		}
		return fmt.Errorf("nginx reload failed: %w", err)
	}
	return nil
}

func (r *Runtime) isReferenced(deploymentID string) bool {
	needle := r.releaseContentDir(deploymentID)
	paths, _ := filepath.Glob(filepath.Join(r.configDir, "pages-preview-*.conf"))
	routes, _ := filepath.Glob(filepath.Join(r.configDir, "pages", "routes", "*.inc"))
	paths = append(paths, routes...)
	for _, configPath := range paths {
		if content, err := os.ReadFile(configPath); err == nil && strings.Contains(string(content), needle) {
			return true
		}
	}
	return false
}

func (r *Runtime) previewConfig(hostname, deploymentID, certificateID, certificateVersion, runtimeConfigPath string, fallback PreviewFallback) string {
	lines := []string{"# opfield-pages immutable preview"}
	if certificateID != "" && fallback.Access.Enabled() {
		// Never ask for basic-auth credentials over plain HTTP: a protected
		// preview with a certificate only answers port 80 with a redirect.
		lines = append(lines, "server {", "    listen 80;", "    server_name "+hostname+";", "    return 301 https://"+hostname+"$request_uri;", "}", "server {")
	} else {
		lines = append(lines, "server {", "    listen 80;")
	}
	if certificateID != "" {
		certRoot := filepath.Join(r.certsDir, certificateID, "versions", certificateVersion)
		lines = append(lines, "    listen 443 ssl;", "    ssl_certificate "+filepath.Join(certRoot, "fullchain.pem")+";", "    ssl_certificate_key "+filepath.Join(certRoot, "privkey.pem")+";")
	}
	lines = append(lines, "    server_name "+hostname+";")
	lines = append(lines, previewClientIPDirectives(fallback.ClientIP)...)
	lines = append(lines, r.previewAccessDirectives(fallback.Access)...)
	lines = append(lines, "    root "+r.releaseContentDir(deploymentID)+";", "    index index.html;", "    add_header X-Content-Type-Options nosniff always;", "    add_header Referrer-Policy same-origin always;")
	if !fallback.SPAFallback && fallback.URL != "" {
		lines = append(lines, "    error_page 404 =302 "+fallback.URL+";")
	} else {
		// No "=": the project's own 404.html is served with the original 404 status.
		lines = append(lines, "    error_page 404 @opfield_pages_404;")
	}
	// Every other page nginx answers with itself (a denied client, a refused method) is an Opfield page too.
	if r.accessChecked(fallback.Access) {
		// 401 goes to the access challenge, and the pages answer without a second check. A check that fails while nginx
		// already handles an error (the project's 404 page, a direct request for an internal access path) goes to the
		// challenge too, instead of nginx's own 401 page.
		lines = append(lines, "    recursive_error_pages on;")
		if r.errorPages {
			lines = append(lines, errorpages.AccessCheckedServerDirectives(404, 401)...)
		}
	} else {
		lines = append(lines, r.errorPageDirectives(404)...)
	}
	// The runtime configuration answers under the Opfield path, which pages load, and under the pre-Opfield one, which
	// pages written before 2.12.1 may name themselves.
	for _, scriptPath := range []string{naming.PagesConfigScriptPath, naming.LegacyPagesConfigScriptPath} {
		lines = append(lines, "    location = "+scriptPath+" {", "        limit_except GET HEAD { deny all; }", "        alias "+runtimeConfigPath+";", "        default_type application/javascript;", "        add_header Cache-Control \"no-store, max-age=0\" always;", "    }")
	}
	lines = append(lines, "    location ~ /\\. { deny all; }", "    location / {", "        limit_except GET HEAD { deny all; }", "        sub_filter_once on;", "        sub_filter '</head>' '<script src=\""+naming.PagesConfigScriptPath+"\"></script></head>';")
	if fallback.SPAFallback {
		// The SPA fallback covers app paths only: a missing path with a file extension answers 404 (the deployment's
		// 404.html), as on a route. Nested regex locations win over the server's, so the dot-file and asset rules are
		// repeated here; they take the access rules and headers of this location.
		lines = append(lines, "        try_files $uri $uri/ /index.html;",
			"        location ~ /\\. { deny all; }",
			"        location ~* "+previewAssetPattern+" {", "            limit_except GET HEAD { deny all; }", "            try_files $uri =404;", "            expires 1y;", "            add_header Cache-Control \"public, max-age=31536000, immutable\" always;", "        }",
			"        location ~ \\.[^/]+$ {", "            limit_except GET HEAD { deny all; }", "            try_files $uri =404;", "        }")
	} else {
		lines = append(lines, "        try_files $uri $uri/ =404;")
	}
	lines = append(lines, "    }")
	if fallback.SPAFallback || fallback.URL == "" {
		// The deployment's top-level 404.html answers a missing path (with the runtime configuration script injected like
		// any page); without one, the generic Opfield page does.
		lines = append(lines, "    location @opfield_pages_404 {", "        try_files /404.html @opfield_pages_not_found;", "        sub_filter_once on;", "        sub_filter '</head>' '<script src=\""+naming.PagesConfigScriptPath+"\"></script></head>';", "    }")
		lines = append(lines, "    location @opfield_pages_not_found {", "        default_type text/html;", "        return 404 '"+notFoundHTML+"';", "    }")
	}
	lines = append(lines, "    location ~* "+previewAssetPattern+" {", "        limit_except GET HEAD { deny all; }", "        expires 1y;", "        add_header Cache-Control \"public, max-age=31536000, immutable\" always;", "    }", "}")
	return strings.Join(lines, "\n") + "\n"
}

// errorPageDirectives are the server-level lines that hand nginx's own error responses to the Opfield pages, without
// the codes the server answers itself; none when the node does not keep the page variables (SetErrorPages).
func (r *Runtime) errorPageDirectives(except ...int) []string {
	if !r.errorPages {
		return nil
	}
	return errorpages.ServerDirectives(except...)
}
