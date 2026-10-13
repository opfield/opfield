package nginx

import (
	"path/filepath"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const defaultServerFilename = "00-opfield-default-server.conf"

// defaultServerConfig is the managed HTTPS catch-all. It must be the
// only default_server for 443/[::]:443 across every Opfield-managed conf.d
// file (route templates never set default_server; see
// nginx-template.service.ts) so nginx always resolves an unmatched SNI/Host
// here instead of falling through to the first loaded route.
const defaultServerConfig = `# Managed by Opfield: default server (auto-injected)
# Rejects any TLS request whose SNI or Host does not match a configured
# route, so a deleted route's hostname (or any other hostname pointed at
# this node) cannot fall through to another route's server block.
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
`

// EnsureDefaultServer writes (or repairs) the managed HTTPS catch-all server
// block described above. It is idempotent: an existing file with the exact
// managed contents is left untouched, so callers can invoke it on every
// daemon start without spurious reloads. Returns true when the file was
// created or its contents changed.
func EnsureDefaultServer(configDir string) (bool, error) {
	path := DefaultServerConfigPath(configDir)
	// The installer writes the catch-all too, under the name the daemon binary carries; a copy under the other
	// scheme's name would be a second default server, which nginx refuses.
	// legacy-name: the catch-all under its pre-Opfield name, or under the Opfield one on a node that has not moved yet
	other := filepath.Join(configDir, defaultServerFilename)
	if naming.File(defaultServerFilename) == defaultServerFilename {
		other = filepath.Join(configDir, naming.LegacyFile(defaultServerFilename))
	}
	removedOther := false
	if previous, err := ReadFile(other); err == nil && previous != nil {
		if err := RemoveFile(other); err != nil {
			return false, err
		}
		removedOther = true
	}
	existing, err := ReadFile(path)
	if err != nil {
		return removedOther, err
	}
	if existing != nil && string(existing) == defaultServerConfig {
		return removedOther, nil
	}
	return true, WriteAtomic(path, []byte(defaultServerConfig))
}

// DefaultServerConfigPath returns the path of the managed default server
// config file within the given conf.d directory, under the names in effect.
func DefaultServerConfigPath(configDir string) string {
	return filepath.Join(configDir, naming.File(defaultServerFilename))
}
