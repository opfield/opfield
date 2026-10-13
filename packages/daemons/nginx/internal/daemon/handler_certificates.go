package daemon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

type certificateInventoryResult struct {
	Certificates []certificateInventoryItem `json:"certificates"`
}

type certificateInventoryItem struct {
	CertID      string `json:"certId"`
	Present     bool   `json:"present"`
	Version     string `json:"version"`
	Fingerprint string `json:"fingerprint"`
}

type legacyCertificateExportResult struct {
	Certificates []legacyCertificateExport `json:"certificates"`
}

type legacyCertificateExport struct {
	CertID   string `json:"certId"`
	CertPem  []byte `json:"certPem"`
	KeyPem   []byte `json:"keyPem"`
	ChainPem []byte `json:"chainPem,omitempty"`
}

// handleApplyTlsBundle preserves the currently loaded TLS configuration until
// both the certificate pointer and config have passed nginx -t and reload.
func (h *Handler) handleApplyTlsBundle(cmd *pb.ApplyTlsBundleCommand, result *pb.CommandResult) {
	if !isValidUUID(cmd.HostId) || !certificateVersionRegex.MatchString(cmd.Generation) {
		result.Success = false
		result.Error = "invalid TLS bundle identifier"
		return
	}
	// As in handleApplyConfig: the flag first, restored when the bundle is not applied.
	restoreFlag, err := h.setMaintenanceFlag(cmd.HostId, cmd.Maintenance)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	h.applyTlsBundle(cmd, result)
	if !result.Success {
		restoreFlag()
	}
}

func (h *Handler) applyTlsBundle(cmd *pb.ApplyTlsBundleCommand, result *pb.CommandResult) {
	cmd.ConfigContent = naming.Render(cmd.ConfigContent) // as in applyConfig
	configPath := h.mgr.ConfigPath(cmd.HostId)
	oldConfig, _ := nginx.ReadFile(configPath)
	pointers := make(map[string]nginx.CertPointer, len(cmd.Certificates))
	restoreOwnership := func() {}
	// The bundle nginx already runs (a reconnect resync re-sends every host): the same config and every
	// certificate's current pointer on the same version. Its files are kept and nginx is not reloaded; the
	// replica generations are still recorded below.
	unchanged := oldConfig != nil && bytes.Equal(oldConfig, []byte(cmd.ConfigContent))
	for _, cert := range cmd.Certificates {
		if !isValidCertificateID(cert.CertId) || !certificateVersionRegex.MatchString(cert.Version) {
			unchanged = false
			break
		}
		unchanged = unchanged && nginx.CertVersionActive(h.cfg.Nginx.CertsDir, cert.CertId, cert.Version)
	}
	undoChange := func() {}
	if !unchanged {
		// Marked before the certificate pointers switch: from here the files may be ahead of nginx.
		var err error
		if undoChange, err = h.mgr.BeginChange(); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
	}

	// reloaded: a reload was attempted, so nginx is brought back to the restored files as well.
	rollback := func(reloaded bool) {
		if oldConfig != nil {
			_ = nginx.WriteAtomic(configPath, oldConfig)
		} else {
			_ = nginx.RemoveFile(configPath)
		}
		for certID, pointer := range pointers {
			_ = nginx.RestoreCertPointer(h.cfg.Nginx.CertsDir, certID, pointer)
		}
		// A failed test/reload must leave the loaded server on the last known
		// valid pair as well as restoring files on disk. Best effort is correct
		// here: the original failure remains the command result.
		if valid, _ := h.mgr.TestConfig(); reloaded && valid {
			_ = h.reloadNow()
		}
		restoreOwnership()
	}

	for _, cert := range cmd.Certificates {
		if !isValidCertificateID(cert.CertId) || !certificateVersionRegex.MatchString(cert.Version) || !replicaGenerationRegex.MatchString(cert.ReplicaGeneration) {
			result.Success = false
			result.Error = "invalid TLS certificate identifier"
			rollback(false)
			undoChange()
			return
		}
		pointer, err := nginx.DeployVersionedCert(
			h.cfg.Nginx.CertsDir,
			cert.CertId,
			cert.Version,
			cert.ReplicaGeneration,
			cert.CertPem,
			cert.KeyPem,
			cert.ChainPem,
		)
		if err != nil {
			rollback(false)
			undoChange()
			result.Success = false
			result.Error = "stage TLS certificate failed"
			return
		}
		pointers[cert.CertId] = pointer
	}
	restoreOwnership, err := h.setConfigOwnership(cmd.HostId, cmd.ConfigOwnership)
	if err != nil {
		rollback(false)
		undoChange()
		result.Success = false
		result.Error = "persist TLS config ownership failed"
		return
	}

	if unchanged {
		if err := h.settleUnchanged(cmd.DeferReload); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		h.recordTLSBundle(cmd)
		return
	}
	if err := nginx.WriteAtomic(configPath, []byte(cmd.ConfigContent)); err != nil {
		rollback(false)
		undoChange()
		result.Success = false
		result.Error = "write TLS proxy configuration failed"
		return
	}
	valid, output := h.mgr.TestConfig()
	result.Detail = output
	if !valid {
		h.logConfigTestFailure("apply TLS bundle", output, "host_id", cmd.HostId)
		rollback(false)
		undoChange()
		result.Success = false
		result.Error = fmt.Sprintf("nginx config test failed: %s", strings.TrimSpace(output))
		return
	}
	if err := h.commitChange(cmd.DeferReload); err != nil {
		h.logger.Error("nginx reload failed", "action", "apply TLS bundle", "host_id", cmd.HostId, "error", err)
		rollback(true)
		result.Success = false
		result.Error = fmt.Sprintf("nginx reload failed: %v", err)
		return
	}
	h.recordTLSBundle(cmd)
	h.logger.Info("TLS bundle applied", "host_id", cmd.HostId, "certificate_count", len(cmd.Certificates), "reload_deferred", cmd.DeferReload)
}

func (h *Handler) recordTLSBundle(cmd *pb.ApplyTlsBundleCommand) {
	h.state.SetExtra("last_tls_bundle_generation", cmd.Generation)
	h.state.Save()
}

func (h *Handler) handleInspectCertificates(cmd *pb.InspectCertificatesCommand, result *pb.CommandResult) {
	response := certificateInventoryResult{Certificates: make([]certificateInventoryItem, 0, len(cmd.CertIds))}
	for _, certID := range cmd.CertIds {
		if !isValidCertificateID(certID) {
			result.Success = false
			result.Error = "invalid certificate id"
			return
		}
		snapshot, err := nginx.InspectCertificate(h.cfg.Nginx.CertsDir, certID)
		if err != nil {
			result.Success = false
			result.Error = "certificate inspection failed"
			return
		}
		response.Certificates = append(response.Certificates, certificateInventoryItem{
			CertID: certID, Present: snapshot.Present, Version: snapshot.Version, Fingerprint: snapshot.Fingerprint,
		})
	}
	data, err := json.Marshal(response)
	if err != nil {
		result.Success = false
		result.Error = "certificate inspection serialization failed"
		return
	}
	result.Data = data
}

func (h *Handler) handleExportLegacyCertificates(cmd *pb.ExportLegacyCertificatesCommand, result *pb.CommandResult) {
	response := legacyCertificateExportResult{Certificates: make([]legacyCertificateExport, 0, len(cmd.CertIds))}
	for _, certID := range cmd.CertIds {
		if !isValidCertificateID(certID) {
			result.Success = false
			result.Error = "invalid certificate id"
			return
		}
		certPem, keyPem, chainPem, err := nginx.ReadCertificateForExport(h.cfg.Nginx.CertsDir, certID)
		if err != nil {
			// Do not reveal filesystem paths or private material in an error. The
			// successful response remains limited to this explicit requested ref.
			result.Success = false
			result.Error = "requested legacy certificate is unavailable"
			return
		}
		response.Certificates = append(response.Certificates, legacyCertificateExport{
			CertID: certID, CertPem: certPem, KeyPem: keyPem, ChainPem: chainPem,
		})
	}
	data, err := json.Marshal(response)
	if err != nil {
		result.Success = false
		result.Error = "legacy certificate export serialization failed"
		return
	}
	result.Data = data
}

func (h *Handler) handleRemoveCertificateReplica(cmd *pb.RemoveCertificateReplicaCommand, result *pb.CommandResult) {
	if !isValidCertificateID(cmd.CertId) || (cmd.ExpectedVersion != "" && !certificateVersionRegex.MatchString(cmd.ExpectedVersion)) || !replicaGenerationRegex.MatchString(cmd.ExpectedReplicaGeneration) {
		result.Success = false
		result.Error = "invalid certificate replica identifier"
		return
	}
	if err := nginx.RemoveCertificateReplica(h.cfg.Nginx.CertsDir, cmd.CertId, cmd.ExpectedVersion, cmd.ExpectedReplicaGeneration); err != nil {
		result.Success = false
		result.Error = "certificate replica removal failed"
		return
	}
	h.logger.Info("certificate replica removed", "cert_id", cmd.CertId)
}
