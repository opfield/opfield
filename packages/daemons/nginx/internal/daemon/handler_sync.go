package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

func (h *Handler) handleFullSync(cmd *pb.FullSyncCommand, result *pb.CommandResult) {
	h.logger.Info("starting full sync", "hosts", len(cmd.Hosts), "certs", len(cmd.Certs))

	// Snapshot existing configs for rollback
	preExistingConfigs := make(map[string][]byte)
	existingFiles, _ := nginx.ListConfigs(h.cfg.Nginx.ConfigDir)
	for _, name := range existingFiles {
		data, _ := nginx.ReadFile(filepath.Join(h.cfg.Nginx.ConfigDir, name))
		if data != nil {
			preExistingConfigs[name] = data
		}
	}
	preExistingGlobalConfig, err := nginx.ReadFile(h.cfg.Nginx.GlobalConfig)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("read global config for rollback: %v", err)
		return
	}
	globalConfigTouched := false

	// Track deployed items for rollback
	var deployedCerts []string
	var deployedHtpasswd []string
	preExistingHtpasswd := make(map[string][]byte)
	deletedStaleConfigs := make(map[string][]byte)
	ownershipRollback := make(map[string]bool)
	var flagRollback []func()

	rollback := func() {
		// Restore original configs
		for name, data := range preExistingConfigs {
			nginx.WriteAtomic(filepath.Join(h.cfg.Nginx.ConfigDir, name), data)
		}
		// Restore configs that were deleted as stale in Phase 5
		for name, data := range deletedStaleConfigs {
			nginx.WriteAtomic(filepath.Join(h.cfg.Nginx.ConfigDir, name), data)
		}
		if globalConfigTouched {
			if preExistingGlobalConfig != nil {
				_ = nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, preExistingGlobalConfig)
			} else {
				_ = nginx.RemoveFile(h.cfg.Nginx.GlobalConfig)
			}
		}
		// Remove newly deployed certs
		for _, certId := range deployedCerts {
			nginx.RemoveCert(h.cfg.Nginx.CertsDir, certId)
		}
		// Restore or remove newly deployed htpasswd. A file a Pages preview
		// references keeps its previous content: removing it would break the
		// protected preview.
		for _, alId := range deployedHtpasswd {
			path := filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", alId))
			if previous, existed := preExistingHtpasswd[alId]; existed {
				_ = nginx.WriteAtomic(path, previous)
				continue
			}
			if h.pagesUsesAccessList(alId) {
				continue
			}
			nginx.RemoveFile(path)
		}
		for hostID, previous := range ownershipRollback {
			_, _, _ = h.secureLinkState.SetSourceConfigManaged(hostID, previous)
		}
		for _, restore := range flagRollback {
			restore()
		}
	}

	// Content equal to what is on disk is not rewritten, and a sync that changes nothing does not reload nginx
	// (a reconnect resync ends with this command). The first change marks the reload as pending.
	changed := false
	markChanged := func() error {
		if changed {
			return nil
		}
		changed = true
		_, err := h.mgr.BeginChange()
		return err
	}

	// Phase 1: Deploy certs
	for _, cert := range cmd.Certs {
		if nginx.CertMatches(h.cfg.Nginx.CertsDir, cert.CertId, cert.CertPem, cert.KeyPem, cert.ChainPem) {
			continue
		}
		if err := markChanged(); err != nil {
			rollback()
			result.Success = false
			result.Error = err.Error()
			return
		}
		if err := nginx.DeployCert(h.cfg.Nginx.CertsDir, cert.CertId, cert.CertPem, cert.KeyPem, cert.ChainPem); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("deploy cert %s: %v", cert.CertId, err)
			return
		}
		deployedCerts = append(deployedCerts, cert.CertId)
	}

	// Phase 2: Deploy htpasswd files
	for _, hp := range cmd.HtpasswdFiles {
		path := filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", hp.AccessListId))
		if previous, readErr := os.ReadFile(path); readErr == nil {
			if string(previous) == hp.Content {
				continue
			}
			preExistingHtpasswd[hp.AccessListId] = previous
		}
		if err := markChanged(); err != nil {
			rollback()
			result.Success = false
			result.Error = err.Error()
			return
		}
		if err := nginx.WriteAtomic(path, []byte(hp.Content)); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("deploy htpasswd %s: %v", hp.AccessListId, err)
			return
		}
		deployedHtpasswd = append(deployedHtpasswd, hp.AccessListId)
	}

	// Phase 3: Write all host configs
	activeHosts := make(map[string]bool)
	for _, host := range cmd.Hosts {
		if host.ConfigOwnership != "" && h.secureLinkState != nil {
			managed := host.ConfigOwnership == configOwnershipManagedSecureLink
			if !managed && host.ConfigOwnership != configOwnershipUserOwned {
				rollback()
				result.Success = false
				result.Error = fmt.Sprintf("invalid config ownership %s", host.HostId)
				return
			}
			previous, found, err := h.secureLinkState.SetSourceConfigManaged(host.HostId, managed)
			if err != nil {
				rollback()
				result.Success = false
				result.Error = fmt.Sprintf("persist config ownership %s: %v", host.HostId, err)
				return
			}
			if found {
				ownershipRollback[host.HostId] = previous
			}
		}
		restoreFlag, err := h.setMaintenanceFlag(host.HostId, host.Maintenance)
		if err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("maintenance flag %s: %v", host.HostId, err)
			return
		}
		flagRollback = append(flagRollback, restoreFlag)
		path := h.mgr.ConfigPath(host.HostId)
		name := fmt.Sprintf("proxy-host-%s.conf", host.HostId)
		activeHosts[name] = true
		host.ConfigContent = naming.Render(host.ConfigContent) // as in applyConfig
		h.prepareSecureLinkListeners(host.ConfigContent)
		if previous, ok := preExistingConfigs[name]; ok && string(previous) == host.ConfigContent {
			continue
		}
		if err := markChanged(); err != nil {
			rollback()
			result.Success = false
			result.Error = err.Error()
			return
		}
		if err := nginx.WriteAtomic(path, []byte(host.ConfigContent)); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("write config %s: %v", host.HostId, err)
			return
		}
	}

	// Phase 4: Update global config if provided
	if cmd.GlobalConfig != "" && string(preExistingGlobalConfig) != cmd.GlobalConfig {
		if err := markChanged(); err != nil {
			rollback()
			result.Success = false
			result.Error = err.Error()
			return
		}
		if err := nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, []byte(cmd.GlobalConfig)); err != nil {
			rollback()
			result.Success = false
			result.Error = fmt.Sprintf("write global config: %v", err)
			return
		}
		globalConfigTouched = true
	}

	// Phase 5: Remove stale configs (save content for potential rollback)
	existing, _ := nginx.ListConfigs(h.cfg.Nginx.ConfigDir)
	for _, name := range existing {
		if !activeHosts[name] && strings.HasPrefix(name, "proxy-host-") {
			if err := markChanged(); err != nil {
				rollback()
				result.Success = false
				result.Error = err.Error()
				return
			}
			if data, ok := preExistingConfigs[name]; ok {
				deletedStaleConfigs[name] = data
			}
			os.Remove(filepath.Join(h.cfg.Nginx.ConfigDir, name))
		}
	}

	if !changed {
		// nginx already runs this configuration; only changes still waiting for their reload are loaded.
		if err := h.settleUnchanged(false); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		h.finishFullSync(cmd, nil)
		h.logger.Info("full sync complete; nothing changed", "version_hash", cmd.VersionHash)
		return
	}

	// Phase 6: Test and reload
	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		h.logConfigTestFailure("full sync", output, "version_hash", cmd.VersionHash)
		rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		return
	}

	if err := h.reloadNow(); err != nil {
		rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		return
	}
	h.finishFullSync(cmd, deletedStaleConfigs)
	h.logger.Info("full sync complete", "version_hash", cmd.VersionHash)
}

func (h *Handler) finishFullSync(cmd *pb.FullSyncCommand, deletedStaleConfigs map[string][]byte) {
	// The configs of removed hosts are gone for good: so are their caches.
	for name := range deletedStaleConfigs {
		removeHostCache(strings.TrimSuffix(strings.TrimPrefix(name, "proxy-host-"), ".conf"))
	}
	h.removeOrphanedHtpasswd()
	// Update state
	hostIDs := make([]string, 0, len(cmd.Hosts))
	for _, host := range cmd.Hosts {
		hostIDs = append(hostIDs, host.HostId)
	}
	h.retainMaintenanceFlags(hostIDs)
	h.state.SetExtra("active_host_ids", hostIDs)
	h.state.SetExtra("config_version_hash", cmd.VersionHash)
	h.state.Save()
}

func (h *Handler) handleUpdateGlobalConfig(cmd *pb.UpdateGlobalConfigCommand, result *pb.CommandResult) {
	// Backup current config
	backup, err := nginx.ReadFile(h.cfg.Nginx.GlobalConfig)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("read global config for rollback: %v", err)
		return
	}
	rollback := func() error {
		if backup != nil {
			return nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, backup)
		}
		return nginx.RemoveFile(h.cfg.Nginx.GlobalConfig)
	}
	if backup != nil && string(backup) == cmd.Content {
		if err := h.settleUnchanged(false); err != nil {
			result.Success = false
			result.Error = err.Error()
		}
		return
	}
	if _, err := h.mgr.BeginChange(); err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}

	if err := nginx.WriteAtomic(h.cfg.Nginx.GlobalConfig, []byte(cmd.Content)); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("write global config: %v", err)
		return
	}

	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		h.logConfigTestFailure("update global config", output)
		rollbackErr := rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", output)
		if rollbackErr != nil {
			result.Error += fmt.Sprintf("; rollback global config: %v", rollbackErr)
		}
		return
	}

	if err := h.reloadNow(); err != nil {
		rollbackErr := rollback()
		_, _ = h.mgr.TestConfig()
		result.Success = false
		result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		if rollbackErr != nil {
			result.Error += fmt.Sprintf("; rollback global config: %v", rollbackErr)
		}
		return
	}

	h.logger.Info("global config updated")
}

func (h *Handler) handleDeployHtpasswd(cmd *pb.DeployHtpasswdCommand, result *pb.CommandResult) {
	path := filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", cmd.AccessListId))
	if err := nginx.WriteAtomic(path, []byte(cmd.Content)); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("deploy htpasswd: %v", err)
		return
	}
	h.logger.Info("htpasswd deployed", "access_list_id", cmd.AccessListId)
}

// pagesUsesAccessList keeps credentials a protected Pages preview still references.
func (h *Handler) pagesUsesAccessList(accessListID string) bool {
	return h.pagesRuntime != nil && h.pagesRuntime.UsesAccessList(accessListID)
}

// orphanedHtpasswdMinAge keeps a credentials file that was just deployed: the
// config or Pages preview that will reference it may still be on its way.
const orphanedHtpasswdMinAge = 10 * time.Minute

// removeOrphanedHtpasswd deletes the access-list credentials (bcrypt hashes)
// that no nginx config on the node references and no Pages preview uses: the
// list was deleted, or its routes moved away or dropped it, while the node was
// not connected. It runs after a full sync, which leaves the node with exactly
// the configs Opfield serves from it. A config it cannot read keeps every file.
func (h *Handler) removeOrphanedHtpasswd() {
	dir := h.cfg.Nginx.HtpasswdDir
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			h.logger.Warn("htpasswd cleanup skipped: cannot list credentials", "error", err)
		}
		return
	}
	configs, err := h.nginxConfigText()
	if err != nil {
		h.logger.Warn("htpasswd cleanup skipped: cannot read nginx configs", "error", err)
		return
	}
	now := time.Now()
	for _, entry := range entries {
		accessListID, ok := strings.CutPrefix(entry.Name(), "access-list-")
		if !ok || !entry.Type().IsRegular() || !isValidUUID(accessListID) {
			continue
		}
		if strings.Contains(configs, entry.Name()) || h.pagesUsesAccessList(accessListID) {
			continue
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < orphanedHtpasswdMinAge {
			continue
		}
		if err := nginx.RemoveFile(filepath.Join(dir, entry.Name())); err != nil {
			h.logger.Warn("remove orphaned htpasswd", "access_list_id", accessListID, "error", err)
			continue
		}
		h.logger.Info("orphaned htpasswd removed", "access_list_id", accessListID)
	}
}

// nginxConfigText is every file of the config directory and the global config,
// the places a host, Pages preview or operator config references credentials.
func (h *Handler) nginxConfigText() (string, error) {
	var text strings.Builder
	entries, err := os.ReadDir(h.cfg.Nginx.ConfigDir)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	paths := []string{h.cfg.Nginx.GlobalConfig}
	for _, entry := range entries {
		// A symlinked config counts as well.
		path := filepath.Join(h.cfg.Nginx.ConfigDir, entry.Name())
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			paths = append(paths, path)
		}
	}
	for _, path := range paths {
		data, err := nginx.ReadFile(path)
		if err != nil {
			return "", err
		}
		text.Write(data)
		text.WriteByte('\n')
	}
	return text.String(), nil
}

func (h *Handler) handleRemoveHtpasswd(cmd *pb.RemoveHtpasswdCommand, result *pb.CommandResult) {
	if h.pagesUsesAccessList(cmd.AccessListId) {
		h.logger.Info("htpasswd kept for Pages previews", "access_list_id", cmd.AccessListId)
		return
	}
	path := filepath.Join(h.cfg.Nginx.HtpasswdDir, fmt.Sprintf("access-list-%s", cmd.AccessListId))
	if err := nginx.RemoveFile(path); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("remove htpasswd: %v", err)
		return
	}
	h.logger.Info("htpasswd removed", "access_list_id", cmd.AccessListId)
}

func (h *Handler) handleTestConfig(result *pb.CommandResult) {
	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		result.Success = false
		result.Error = output
	}
}

func (h *Handler) handleDeployAcmeChallenge(cmd *pb.DeployAcmeChallengeCommand, result *pb.CommandResult) {
	if !acmeTokenRegex.MatchString(cmd.Token) {
		result.Success = false
		result.Error = "invalid ACME token format"
		return
	}
	dir := filepath.Join(h.cfg.Nginx.AcmeChallengeDir, ".well-known", "acme-challenge")
	path := filepath.Join(dir, cmd.Token)
	if err := nginx.WriteAtomic(path, []byte(cmd.Content)); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("deploy ACME challenge: %v", err)
		return
	}
	h.logger.Info("ACME challenge deployed", "token", cmd.Token)
}

func (h *Handler) handleRemoveAcmeChallenge(cmd *pb.RemoveAcmeChallengeCommand, result *pb.CommandResult) {
	if !acmeTokenRegex.MatchString(cmd.Token) {
		result.Success = false
		result.Error = "invalid ACME token format"
		return
	}
	path := filepath.Join(h.cfg.Nginx.AcmeChallengeDir, ".well-known", "acme-challenge", cmd.Token)
	if err := nginx.RemoveFile(path); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("remove ACME challenge: %v", err)
		return
	}
	h.logger.Info("ACME challenge removed", "token", cmd.Token)
}

func (h *Handler) handleReadGlobalConfig(result *pb.CommandResult) {
	data, err := nginx.ReadFile(h.cfg.Nginx.GlobalConfig)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("read global config: %v", err)
		return
	}
	if data == nil {
		result.Success = false
		result.Error = "global config file not found"
		return
	}
	result.Detail = string(data)
}
