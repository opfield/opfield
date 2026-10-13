package nginx

import (
	"bytes"
	"path/filepath"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const maintenanceGuardFilename = "00-opfield-maintenance.conf"

// maintenanceGuardConfig is the http-level part of the maintenance guard Opfield renders into every managed route of
// a node that keeps maintenance flags (proxy_maintenance_flag_v1). The variables are the same for every route, so a
// node defines them once however many routes it serves; each request evaluates them only while its route's flag is
// set (Opfield's nginx-maintenance-flag-guard.ts). It is written with the names in effect (naming.Render).
//
//   - $opfield_maintenance is "1" while the route that handles the request is in maintenance: the route's guard sets it
//     when the flag file exists. Its default comes from this map, so reading it never logs an uninitialized variable.
//   - $opfield_maintenance_route names the guard location that answers the request, empty when the route handles it:
//     the paths the maintenance page itself needs, ACME challenges and the reserved health paths, and a request with a
//     valid access cookie.
//   - $opfield_maintenance_cookie is the Cookie a route forwards: the request's own, without Opfield's access cookies
//     during maintenance. Each cookie goes with the separator that joined it to its neighbours (the first rule of a map
//     takes the cookie at the start, the second one anywhere after it), so no empty or leading ";" is left.
const maintenanceGuardConfig = `# Managed by Opfield: maintenance of the routes on this node (auto-generated).
map $pid $opfield_maintenance {
    default "";
}

map $opfield_maintenance $opfield_maintenance_route {
    default "";
    1 $opfield_maintenance_target;
}

map $uri $opfield_maintenance_target {
    default $opfield_maintenance_bypass;
    ~^/\.well-known/acme-challenge/ "";
    ` + naming.IngressHealthPath + ` "";
    ` + naming.LegacyIngressHealthPath + ` "";
    /_opfield/maintenance-access opfield-maintenance-access;
    /_opfield/maintenance-access/status opfield-maintenance-status;
}

map $secure_link $opfield_maintenance_bypass {
    default opfield-maintenance;
    "1" "";
}

map $secure_link $opfield_maintenance_access {
    default false;
    "1" true;
}

map $http_cookie $opfield_maintenance_cookie_sig {
    default $http_cookie;
    "~^opfield_maintenance_access_sig=[^;]*(?:;\s*(.*))?$" "$1";
    "~^(.*?);\s*opfield_maintenance_access_sig=[^;]*(.*)$" "$1$2";
}

map $opfield_maintenance_cookie_sig $opfield_maintenance_cookie_stripped {
    default $opfield_maintenance_cookie_sig;
    "~^opfield_maintenance_access_exp=[^;]*(?:;\s*(.*))?$" "$1";
    "~^(.*?);\s*opfield_maintenance_access_exp=[^;]*(.*)$" "$1$2";
}

map $opfield_maintenance $opfield_maintenance_cookie {
    volatile;
    default $http_cookie;
    1 $opfield_maintenance_cookie_stripped;
}
`

// MaintenanceGuardConfigPath is the managed file in the config directory that holds the shared maps.
func MaintenanceGuardConfigPath(configDir string) string {
	return filepath.Join(configDir, naming.File(maintenanceGuardFilename))
}

// MaintenanceGuardContent is the shared maps under the names in effect.
func MaintenanceGuardContent() []byte {
	return []byte(naming.Render(maintenanceGuardConfig))
}

// EnsureMaintenanceGuardConfig writes the shared maps when they are missing or differ. It returns the content it
// replaced (nil when the file was missing) and whether it wrote.
func EnsureMaintenanceGuardConfig(configDir string) (previous []byte, written bool, err error) {
	path := MaintenanceGuardConfigPath(configDir)
	existing, err := ReadFile(path)
	if err != nil {
		return nil, false, err
	}
	desired := MaintenanceGuardContent()
	if bytes.Equal(existing, desired) {
		return existing, false, nil
	}
	return existing, true, WriteAtomic(path, desired)
}
