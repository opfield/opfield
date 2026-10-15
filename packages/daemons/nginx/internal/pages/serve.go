package pages

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

// The console palette (packages/backend/src/lib/brand-palette.ts): paper in light, graphite in dark.
const (
	paperPage     = "#f3f2ef"
	paperInk      = "#141414"
	paperStone    = "#64635f"
	graphitePage  = "#141414"
	graphiteInk   = "#f3f2ef"
	graphiteStone = "#8f8e89"
)

const pageColorVariables = ":root{--page:" + paperPage + ";--ink:" + paperInk + ";--stone:" + paperStone + "}@media(prefers-color-scheme:dark){:root{--page:" + graphitePage + ";--ink:" + graphiteInk + ";--stone:" + graphiteStone + "}}"

const notFoundHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>Page not found</title><style>` + pageColorVariables + `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--page);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:560px;text-align:center}.status{color:var(--stone);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}h1{margin:16px 0 0;font-size:clamp(40px,8vw,64px);line-height:1.05;font-weight:700;letter-spacing:-.04em}p.message{margin:20px auto 0;max-width:440px;color:var(--stone);font-size:15px;line-height:1.6}.footer{margin-top:48px;color:var(--stone);font-size:12px}.footer a{color:var(--ink);text-decoration:none}.footer a:hover{text-decoration:underline}</style></head><body><main><section><div class="status">Error 404</div><h1>Page not found</h1><p class="message">The requested host or page is not available.</p></section><div class="footer">Powered by <a href="https://opfield.dev" rel="noopener noreferrer">Opfield</a></div></main></body></html>`

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
	// The runtime configuration answers under the Opfield path, which pages load, and under the pre-Opfield one, which
	// pages written before 2.12.1 may name themselves.
	for _, scriptPath := range []string{naming.PagesConfigScriptPath, naming.LegacyPagesConfigScriptPath} {
		lines = append(lines, "    location = "+scriptPath+" {", "        limit_except GET HEAD { deny all; }", "        alias "+runtimeConfigPath+";", "        default_type application/javascript;", "        add_header Cache-Control \"no-store, max-age=0\" always;", "    }")
	}
	lines = append(lines, "    location ~ /\\. { deny all; }", "    location / {", "        limit_except GET HEAD { deny all; }", "        sub_filter_once on;", "        sub_filter '</head>' '<script src=\""+naming.PagesConfigScriptPath+"\"></script></head>';")
	if fallback.SPAFallback {
		lines = append(lines, "        try_files $uri $uri/ /index.html;")
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
	lines = append(lines, "    location ~* \\.(?:css|js|mjs|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?)$ {", "        limit_except GET HEAD { deny all; }", "        expires 1y;", "        add_header Cache-Control \"public, max-age=31536000, immutable\" always;", "    }", "}")
	return strings.Join(lines, "\n") + "\n"
}
