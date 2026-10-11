package daemon

import (
	"encoding/json"
	"fmt"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/pages"
)

func (h *Handler) pagesUnavailable(result *pb.CommandResult) bool {
	if h.pagesRuntime != nil {
		return false
	}
	result.Success = false
	result.Error = "Opfield Pages v1 runtime is unavailable on this node"
	return true
}

func (h *Handler) pagesRuntimeConfigUnavailable(result *pb.CommandResult) bool {
	if h.pagesRuntime != nil && h.pagesRuntimeConfigAvailable {
		return false
	}
	result.Success = false
	result.Error = "Opfield Pages runtime configuration is unavailable on this node"
	return true
}

func setPagesData(result *pb.CommandResult, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		result.Success = false
		result.Error = "encode Pages command result"
		return
	}
	result.Data = data
}

func (h *Handler) pagesCommandError(result *pb.CommandResult, operation string, err error) {
	result.Success = false
	// Commands never return paths, archive contents, or raw nginx output in the
	// public envelope. The daemon log has full operator diagnostics.
	h.logger.Error("Opfield Pages command failed", "operation", operation, "error", err)
	result.Error = fmt.Sprintf("Pages %s failed", operation)
}

func (h *Handler) handlePagesUploadInit(cmd *pb.PagesUploadInitCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	if err := h.pagesRuntime.InitUpload(cmd.UploadId, cmd.DeploymentId, cmd.ExpectedSize, cmd.Sha256); err != nil {
		h.pagesCommandError(result, "upload initialization", err)
	}
}
func (h *Handler) handlePagesUploadChunk(cmd *pb.PagesUploadChunkCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	nextOffset, err := h.pagesRuntime.AppendUpload(cmd.UploadId, cmd.Offset, cmd.Content)
	if err != nil {
		h.pagesCommandError(result, "upload chunk", err)
		return
	}
	setPagesData(result, map[string]int64{"nextOffset": nextOffset})
}
func (h *Handler) handlePagesUploadFinalize(cmd *pb.PagesUploadFinalizeCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	manifest, err := h.pagesRuntime.FinalizeUpload(cmd.UploadId, cmd.DeploymentId)
	if err != nil {
		h.pagesCommandError(result, "upload finalization", err)
		return
	}
	setPagesData(result, manifest)
}
func (h *Handler) handlePagesVerifyRelease(cmd *pb.PagesVerifyReleaseCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	manifest, err := h.pagesRuntime.VerifyRelease(cmd.DeploymentId, cmd.Sha256)
	if pages.IsReleaseNotStored(err) {
		// Gateway asks before it uploads a release: not stored yet is the
		// answer that starts the upload, not a failure (N-23).
		h.logger.Debug("Pages release is not stored on this node yet", "deployment_id", cmd.DeploymentId)
		result.Success = false
		result.Error = "Pages release is not stored on this node"
		return
	}
	if err != nil {
		h.pagesCommandError(result, "release verification", err)
		return
	}
	setPagesData(result, manifest)
}
func (h *Handler) handlePagesMaterializePreview(cmd *pb.PagesMaterializePreviewCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	options := pages.PreviewFallback{SPAFallback: cmd.SpaFallback, URL: cmd.FallbackUrl, Access: pagesPreviewAccess(cmd.Access)}
	if err := h.pagesRuntime.MaterializePreview(cmd.ProfileId, cmd.DeploymentId, cmd.Hostname, cmd.CertificateId, cmd.CertificateVersion, options); err != nil {
		h.pagesCommandError(result, "preview materialization", err)
	}
}

// pagesPreviewAccess maps the optional wire access list. An absent or empty
// list keeps the preview public, exactly like a proxy host without one.
func pagesPreviewAccess(access *pb.PagesPreviewAccess) *pages.PreviewAccess {
	if access == nil || (len(access.IpRules) == 0 && !access.BasicAuthEnabled) {
		return nil
	}
	rules := make([]pages.PreviewIPRule, 0, len(access.IpRules))
	for _, rule := range access.IpRules {
		rules = append(rules, pages.PreviewIPRule{Type: rule.Type, Value: rule.Value})
	}
	return &pages.PreviewAccess{AccessListID: access.AccessListId, IPRules: rules, BasicAuth: access.BasicAuthEnabled}
}

func (h *Handler) handlePagesDeployCertificate(cmd *pb.PagesDeployCertificateCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	if !isValidCertificateID(cmd.CertId) || !certificateVersionRegex.MatchString(cmd.Version) || !replicaGenerationRegex.MatchString(cmd.ReplicaGeneration) {
		result.Success = false
		result.Error = "invalid Pages certificate reference"
		return
	}
	if _, err := nginx.DeployVersionedCert(h.cfg.Nginx.CertsDir, cmd.CertId, cmd.Version, cmd.ReplicaGeneration, cmd.CertPem, cmd.KeyPem, cmd.ChainPem); err != nil {
		h.pagesCommandError(result, "certificate deployment", err)
	}
}
func (h *Handler) handlePagesRemovePreview(cmd *pb.PagesRemovePreviewCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	if err := h.pagesRuntime.RemovePreview(cmd.Hostname); err != nil {
		h.pagesCommandError(result, "preview removal", err)
	}
}
func (h *Handler) handlePagesActivateTagRoute(cmd *pb.PagesActivateTagRouteCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	if err := h.pagesRuntime.ActivateTagRoute(cmd.RouteId, cmd.DeploymentId); err != nil {
		h.pagesCommandError(result, "tag route activation", err)
		return
	}
	includePath, err := h.pagesRuntime.RouteIncludePath(cmd.RouteId)
	if err != nil {
		h.pagesCommandError(result, "tag route include path", err)
		return
	}
	setPagesData(result, map[string]string{"includePath": includePath})
}
func (h *Handler) handlePagesDeactivateTagRoute(cmd *pb.PagesDeactivateTagRouteCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	if err := h.pagesRuntime.DeactivateTagRoute(cmd.RouteId); err != nil {
		h.pagesCommandError(result, "tag route deactivation", err)
	}
}
func (h *Handler) handlePagesCleanupDeployment(cmd *pb.PagesCleanupDeploymentCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	if err := h.pagesRuntime.CleanupDeployment(cmd.DeploymentId); err != nil {
		h.pagesCommandError(result, "release cleanup", err)
	}
}
func (h *Handler) handlePagesInventory(cmd *pb.PagesInventoryCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	if len(cmd.ExpectationsJson) > 0 {
		if h.pagesRuntimeConfigUnavailable(result) {
			return
		}
		var expectations []pages.BindingExpectation
		if len(cmd.ExpectationsJson) > 8<<20 || json.Unmarshal(cmd.ExpectationsJson, &expectations) != nil || len(expectations) > 1000 {
			result.Success = false
			result.Error = "invalid Pages inspection expectations"
			return
		}
		setPagesData(result, h.pagesRuntime.InspectBindings(expectations))
		return
	}
	inventory, err := h.pagesRuntime.Inventory()
	if err != nil {
		h.pagesCommandError(result, "inventory", err)
		return
	}
	setPagesData(result, inventory)
}
func (h *Handler) handlePagesStoragePreflight(cmd *pb.PagesStoragePreflightCommand, result *pb.CommandResult) {
	if h.pagesUnavailable(result) {
		return
	}
	preflight, err := h.pagesRuntime.StoragePreflight(cmd.RequiredBytes)
	if err != nil {
		h.pagesCommandError(result, "storage preflight", err)
		return
	}
	setPagesData(result, preflight)
}

func pagesRuntimeConfigBinding(kind pb.PagesRuntimeConfigBindingKind, bindingID string) (pages.RuntimeConfigBindingKind, string, error) {
	switch kind {
	case pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE:
		return pages.RuntimeConfigBindingRoute, bindingID, nil
	case pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_PREVIEW:
		return pages.RuntimeConfigBindingPreview, bindingID, nil
	default:
		return "", "", fmt.Errorf("invalid runtime config binding kind")
	}
}

func (h *Handler) handlePagesStageRuntimeConfig(cmd *pb.PagesStageRuntimeConfigCommand, result *pb.CommandResult) {
	if h.pagesRuntimeConfigUnavailable(result) {
		return
	}
	kind, bindingID, err := pagesRuntimeConfigBinding(cmd.BindingKind, cmd.BindingId)
	if err != nil {
		result.Success = false
		result.Error = "invalid Pages runtime configuration binding"
		return
	}
	if err := h.pagesRuntime.StageRuntimeConfig(kind, bindingID, cmd.Generation, cmd.Json); err != nil {
		h.pagesCommandError(result, "runtime config staging", err)
	}
}

func (h *Handler) handlePagesActivateRuntimeConfig(cmd *pb.PagesActivateRuntimeConfigCommand, result *pb.CommandResult) {
	if h.pagesRuntimeConfigUnavailable(result) {
		return
	}
	kind, bindingID, err := pagesRuntimeConfigBinding(cmd.BindingKind, cmd.BindingId)
	if err != nil {
		result.Success = false
		result.Error = "invalid Pages runtime configuration binding"
		return
	}
	path, err := h.pagesRuntime.ActivateRuntimeConfig(kind, bindingID, cmd.Generation)
	if err != nil {
		h.pagesCommandError(result, "runtime config activation", err)
		return
	}
	setPagesData(result, map[string]string{"configPath": path})
}

func (h *Handler) handlePagesRemoveRuntimeConfig(cmd *pb.PagesRemoveRuntimeConfigCommand, result *pb.CommandResult) {
	if h.pagesRuntimeConfigUnavailable(result) {
		return
	}
	kind, bindingID, err := pagesRuntimeConfigBinding(cmd.BindingKind, cmd.BindingId)
	if err != nil {
		result.Success = false
		result.Error = "invalid Pages runtime configuration binding"
		return
	}
	if cmd.Generation > 0 {
		if err := h.pagesRuntime.DiscardRuntimeConfig(kind, bindingID, cmd.Generation); err != nil {
			h.pagesCommandError(result, "runtime config generation discard", err)
		}
		return
	}
	if err := h.pagesRuntime.RemoveRuntimeConfig(kind, bindingID); err != nil {
		h.pagesCommandError(result, "runtime config removal", err)
	}
}
