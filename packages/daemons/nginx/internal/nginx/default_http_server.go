package nginx

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/opfield/opfield/nginx-daemon/internal/errorpages"
)

// installerNotFoundLocation is the catch-all location the node installer (managed nginx mode) wrote into the HTTP
// default server, conf.d/default.conf next to nginx.conf, before 2.12.3: a 404 page inline. Only this exact shape is
// replaced, so an operator's own default server is never touched.
var installerNotFoundLocation = regexp.MustCompile(`(?s)\n    location / \{\n        default_type text/html;\n        return 404 '<!doctype html>[^']*Powered by <a href="https://opfield\.dev"[^']*</html>';\n    \}\n`)

// DefaultHTTPServerPath is the HTTP default server the installer writes in managed mode.
func DefaultHTTPServerPath(globalConfigPath string) string {
	return filepath.Join(filepath.Dir(globalConfigPath), "conf.d", "default.conf")
}

// defaultHTTPServerErrorPages is what replaces the inline 404: the same catch-all, answered by the Opfield pages for
// every error nginx generates there (scripts/setup-node.sh writes the same into new installs).
func defaultHTTPServerErrorPages() string {
	lines := []string{"", "    location / {", "        return 404;", "    }", ""}
	lines = append(lines, errorpages.ServerDirectives()...)
	return strings.Join(lines, "\n") + "\n"
}

// EnsureDefaultHTTPServerErrorPages moves the installer's HTTP default server (managed mode) to the Opfield error
// pages, so a malformed request, an unknown host or a denied status request on port 80 gets them too; one already on
// the pages gets the codes added since (errorpages.UpgradeServerDirectives). Any other file (integrate mode, an
// operator's own) is left alone. It returns the content
// it replaced and whether it wrote; a node whose daemon cannot write the file keeps it.
func EnsureDefaultHTTPServerErrorPages(globalConfigPath string) (previous []byte, written bool, err error) {
	path := DefaultHTTPServerPath(globalConfigPath)
	existing, err := ReadFile(path)
	if err != nil || existing == nil {
		return nil, false, err
	}
	content := string(existing)
	if !strings.Contains(content, "listen 80 default_server;") {
		return existing, false, nil
	}
	var next string
	if strings.Contains(content, errorpages.Location(0)) {
		// Already on the pages: a server moved (or installed) by an earlier release gets the codes added since.
		upgraded, changed := errorpages.UpgradeServerDirectives(content)
		if !changed {
			return existing, false, nil
		}
		next = upgraded
	} else {
		loc := installerNotFoundLocation.FindStringIndex(content)
		if loc == nil {
			return existing, false, nil
		}
		next = content[:loc[0]] + defaultHTTPServerErrorPages() + content[loc[1]:]
	}
	info, err := os.Stat(path)
	if err != nil {
		return existing, false, err
	}
	if err := WriteAtomic(path, []byte(next)); err != nil {
		return existing, false, err
	}
	// The installer's file keeps its mode (WriteAtomic creates with the process umask).
	_ = os.Chmod(path, info.Mode().Perm())
	return existing, true, nil
}
