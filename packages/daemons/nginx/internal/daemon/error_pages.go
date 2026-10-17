package daemon

import (
	"log/slog"

	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// ensureErrorPages writes the page variables nginx answers its own errors with (errorpages.Config) and reports whether
// nginx must reload to use them. A first copy needs no reload of its own: only configs rendered for
// nginx.ErrorPagesCapability use the variables, and the reload that loads those configs loads them. A changed copy (a
// daemon update) is loaded at once, since the routes already use it; one nginx does not accept is replaced by the copy
// before it, and without any copy the node does not report the capability.
func (p *NginxPlugin) ensureErrorPages(logger *slog.Logger) (reload bool) {
	dir := p.cfg.Nginx.ConfigDir
	previous, written, err := nginx.EnsureErrorPagesConfig(dir)
	if err != nil {
		logger.Warn("Opfield error pages are unavailable; nginx answers its errors with its own pages", "error", err)
		p.errorPagesSupported = false
		return false
	}
	p.errorPagesSupported = true
	if !written {
		return false
	}
	valid, output := p.mgr.TestConfig()
	switch {
	case valid:
		return previous != nil
	case previous != nil:
		if err := nginx.WriteAtomic(nginx.ErrorPagesConfigPath(dir), previous); err != nil {
			logger.Warn("failed to restore the Opfield error pages", "error", err)
		}
		logger.Warn("updated Opfield error pages conflict with this node's nginx configuration; the previous pages stay", "output", output)
		return false
	default:
		_ = nginx.RemoveFile(nginx.ErrorPagesConfigPath(dir))
		logger.Warn("Opfield error pages conflict with this node's nginx configuration; nginx answers its errors with its own pages", "output", output)
		p.errorPagesSupported = false
		return false
	}
}

// ensureDefaultHTTPServerErrorPages moves the HTTP default server the installer wrote (managed mode) to the Opfield
// error pages and reports whether nginx must reload. A change nginx does not accept is taken back.
func (p *NginxPlugin) ensureDefaultHTTPServerErrorPages(logger *slog.Logger) (reload bool) {
	path := nginx.DefaultHTTPServerPath(p.cfg.Nginx.GlobalConfig)
	previous, written, err := nginx.EnsureDefaultHTTPServerErrorPages(p.cfg.Nginx.GlobalConfig)
	if err != nil {
		logger.Info("the HTTP default server keeps nginx's own error pages; it could not be updated", "path", path, "error", err)
		return false
	}
	if !written {
		return false
	}
	if valid, output := p.mgr.TestConfig(); !valid {
		if err := nginx.WriteAtomic(path, previous); err != nil {
			logger.Warn("failed to restore the HTTP default server", "path", path, "error", err)
		}
		logger.Warn("the HTTP default server with the Opfield error pages conflicts with this node's nginx configuration; it stays as it was", "output", output)
		return false
	}
	logger.Info("the HTTP default server answers with the Opfield error pages", "path", path)
	return true
}
