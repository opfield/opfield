package daemon

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// Maintenance without a reload (proxy_maintenance_flag_v1). Gateway renders every managed route on this node with a
// guard that checks, per request, whether the file <maintenanceFlagDir>/<host id> exists, and answers with the
// maintenance page only then. Entering and leaving maintenance is the creation and removal of that file: nginx keeps
// running its configuration, and the idle keep-alive connections of every other route stay open (a reload closes
// them). The directory is fixed because the configs Gateway renders name it, and it persists across restarts so a
// route stays in maintenance while the daemon is down.
const maintenanceFlagCapability = "proxy_maintenance_flag_v1"

// maintenanceFlagDir is the flag directory under the names in effect.
func maintenanceFlagDir() string { return naming.Path(naming.EtcDir + "/maintenance") }

// prepareMaintenanceFlagDir creates the flag directory; nginx workers only need to reach the files in it.
func prepareMaintenanceFlagDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.Chmod(dir, 0o755)
}

func (h *Handler) maintenanceFlagPath(hostID string) string {
	return filepath.Join(h.maintenanceFlagDir, hostID)
}

func (h *Handler) maintenanceFlagSet(hostID string) bool {
	info, err := os.Stat(h.maintenanceFlagPath(hostID))
	return err == nil && info.Mode().IsRegular()
}

// setMaintenanceFlag brings a route's flag to the state Gateway sent. It returns the function that restores the
// previous state, for a command that fails after it. UNSPECIFIED, and a daemon without the flag directory, keep the
// flag as it is.
func (h *Handler) setMaintenanceFlag(hostID string, flag pb.ProxyMaintenanceFlag) (func(), error) {
	noop := func() {}
	if h.maintenanceFlagDir == "" || flag == pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_UNSPECIFIED {
		return noop, nil
	}
	if !isValidUUID(hostID) {
		return nil, errors.New("invalid host id for the maintenance flag")
	}
	enabled := flag == pb.ProxyMaintenanceFlag_PROXY_MAINTENANCE_FLAG_ON
	previous := h.maintenanceFlagSet(hostID)
	if previous == enabled {
		return noop, nil
	}
	if err := h.writeMaintenanceFlag(hostID, enabled); err != nil {
		return nil, fmt.Errorf("set maintenance flag: %w", err)
	}
	h.logger.Info("maintenance flag changed", "host_id", hostID, "maintenance", enabled)
	return func() {
		if err := h.writeMaintenanceFlag(hostID, previous); err != nil {
			h.logger.Warn("restore maintenance flag", "host_id", hostID, "error", err)
		}
	}, nil
}

func (h *Handler) writeMaintenanceFlag(hostID string, enabled bool) error {
	path := h.maintenanceFlagPath(hostID)
	if !enabled {
		return nginx.RemoveFile(path)
	}
	if err := prepareMaintenanceFlagDir(h.maintenanceFlagDir); err != nil {
		return err
	}
	if err := nginx.WriteAtomic(path, []byte("maintenance\n")); err != nil {
		return err
	}
	return os.Chmod(path, 0o644)
}

// removeMaintenanceFlag drops the flag of a route the node no longer serves.
func (h *Handler) removeMaintenanceFlag(hostID string) {
	if h.maintenanceFlagDir == "" || !isValidUUID(hostID) {
		return
	}
	if err := nginx.RemoveFile(h.maintenanceFlagPath(hostID)); err != nil {
		h.logger.Warn("remove maintenance flag", "host_id", hostID, "error", err)
	}
}

// retainMaintenanceFlags removes the flags of every route a full sync did not list: a full sync names every route the
// node serves.
func (h *Handler) retainMaintenanceFlags(hostIDs []string) {
	if h.maintenanceFlagDir == "" {
		return
	}
	entries, err := os.ReadDir(h.maintenanceFlagDir)
	if err != nil {
		if !os.IsNotExist(err) {
			h.logger.Warn("maintenance flag cleanup skipped", "error", err)
		}
		return
	}
	served := make(map[string]bool, len(hostIDs))
	for _, hostID := range hostIDs {
		served[hostID] = true
	}
	for _, entry := range entries {
		if served[entry.Name()] || !isValidUUID(entry.Name()) {
			continue
		}
		h.removeMaintenanceFlag(entry.Name())
		h.logger.Info("maintenance flag of a route the node no longer serves removed", "host_id", entry.Name())
	}
}

// ensureMaintenanceGuardMaps writes the shared maps of the flag-checked maintenance guard and reports whether nginx
// must reload to use them. A first copy needs no reload of its own: only route configs Gateway renders for this
// capability use the maps, and the reload that loads those configs loads them. A changed copy (a daemon update) is
// loaded at once, since the routes already use the maps; one nginx does not accept is replaced by the copy before it.
func (p *NginxPlugin) ensureMaintenanceGuardMaps(logger *slog.Logger) (reload bool) {
	dir := p.cfg.Nginx.ConfigDir
	previous, written, err := nginx.EnsureMaintenanceGuardConfig(dir)
	if err != nil {
		logger.Warn("maintenance guard maps are unavailable; maintenance changes reload nginx", "error", err)
		p.maintenanceFlagsSupported = false
		return false
	}
	if !written {
		return false
	}
	valid, output := p.mgr.TestConfig()
	switch {
	case valid:
		return previous != nil
	case previous != nil:
		if err := nginx.WriteAtomic(nginx.MaintenanceGuardConfigPath(dir), previous); err != nil {
			logger.Warn("failed to restore the maintenance guard maps", "error", err)
		}
		logger.Warn("updated maintenance guard maps conflict with this node's nginx configuration; the previous maps stay", "output", output)
		return false
	default:
		_ = nginx.RemoveFile(nginx.MaintenanceGuardConfigPath(dir))
		logger.Warn("maintenance guard maps conflict with this node's nginx configuration; maintenance changes reload nginx", "output", output)
		p.maintenanceFlagsSupported = false
		return false
	}
}
