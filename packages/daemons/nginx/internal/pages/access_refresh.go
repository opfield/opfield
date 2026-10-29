package pages

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A protected preview is rendered with the list's fallback directives until the access socket has the list's policy,
// and with access checks from then on (SetAccessChecks). The policy arrives on its own command, so the runtime keeps
// what each protected preview was materialized with and renders it again when its list's policy comes or goes
// (RefreshAccessChecks).

// previewAccessRecord is what a protected preview was materialized with.
type previewAccessRecord struct {
	Hostname           string           `json:"hostname"`
	DeploymentID       string           `json:"deploymentId"`
	CertificateID      string           `json:"certificateId,omitempty"`
	CertificateVersion string           `json:"certificateVersion,omitempty"`
	SPAFallback        bool             `json:"spaFallback,omitempty"`
	URL                string           `json:"url,omitempty"`
	Access             *PreviewAccess   `json:"access"`
	ClientIP           *PreviewClientIP `json:"clientIp,omitempty"`
}

func (r *Runtime) previewAccessDir() string { return filepath.Join(r.root, "preview-access") }

func (r *Runtime) previewAccessRecordPath(hostname string) string {
	return filepath.Join(r.previewAccessDir(), strings.TrimSuffix(filepath.Base(r.previewConfigPath(hostname)), ".conf")+".json")
}

// recordPreviewAccess keeps what a materialized preview needs to be rendered again; a preview without an access list
// needs nothing.
func (r *Runtime) recordPreviewAccess(hostname, deploymentID, certificateID, certificateVersion string, fallback PreviewFallback) error {
	path := r.previewAccessRecordPath(hostname)
	if fallback.Access == nil {
		return removePreviewAccessRecord(path)
	}
	content, err := json.Marshal(previewAccessRecord{
		Hostname: hostname, DeploymentID: deploymentID, CertificateID: certificateID, CertificateVersion: certificateVersion,
		SPAFallback: fallback.SPAFallback, URL: fallback.URL, Access: fallback.Access, ClientIP: fallback.ClientIP,
	})
	if err != nil {
		return err
	}
	// The fallback rules stay owner-only.
	return writeAtomic(path, content, privateFileMode)
}

func removePreviewAccessRecord(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// RefreshAccessChecks renders again every protected preview whose list's policy came to or left the access socket
// since it was rendered, and returns how many changed. A preview that cannot be rendered keeps its config (a checked
// preview whose list left the policy is answered 503 by the socket: closed) and is reported.
func (r *Runtime) RefreshAccessChecks() (int, error) {
	paths, err := filepath.Glob(filepath.Join(r.previewAccessDir(), "pages-preview-*.json"))
	if err != nil {
		return 0, err
	}
	changed := 0
	var failures []error
	for _, path := range paths {
		rendered, err := r.refreshPreviewAccess(path)
		if err != nil {
			failures = append(failures, err)
		} else if rendered {
			changed++
		}
	}
	return changed, errors.Join(failures...)
}

func (r *Runtime) refreshPreviewAccess(recordPath string) (bool, error) {
	data, err := readFileNoFollow(recordPath)
	if err != nil {
		return false, err
	}
	var record previewAccessRecord
	if err := json.Unmarshal(data, &record); err != nil || !validHostname(record.Hostname) || record.Access == nil {
		return false, fmt.Errorf("invalid preview access record %s", filepath.Base(recordPath))
	}
	configPath := r.previewConfigPath(record.Hostname)
	current, err := readFileNoFollow(configPath)
	if errors.Is(err, os.ErrNotExist) || (err == nil && isRevokedPreview(current)) {
		// The preview is gone; so is what it was rendered with.
		return false, removePreviewAccessRecord(recordPath)
	}
	if err != nil {
		return false, err
	}
	checked := r.accessChecked(record.Access)
	if strings.Contains(string(current), "    auth_request "+accessCheckPath+";\n") == checked {
		return false, nil
	}
	if err := validatePreviewAccess(record.Access); err != nil {
		return false, err
	}
	if err := r.ensurePreviewCredentials(record.Access); err != nil {
		return false, fmt.Errorf("preview %s: %w", record.Hostname, err)
	}
	runtimeConfigPath, err := r.RuntimeConfigPath(RuntimeConfigBindingPreview, record.Hostname)
	if err != nil {
		return false, err
	}
	content := r.previewConfig(record.Hostname, record.DeploymentID, record.CertificateID, record.CertificateVersion, runtimeConfigPath,
		PreviewFallback{SPAFallback: record.SPAFallback, URL: record.URL, Access: record.Access, ClientIP: record.ClientIP})
	if err := r.applyConfig(configPath, []byte(content)); err != nil {
		return false, fmt.Errorf("preview %s: %w", record.Hostname, err)
	}
	return true, nil
}
