package pages

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

// BindingExpectation carries desired state, never operator-controlled paths.
// The daemon retains ownership of config rendering and filesystem validation.
type BindingExpectation struct {
	Kind               RuntimeConfigBindingKind `json:"kind"`
	ID                 string                   `json:"id"`
	DeploymentID       string                   `json:"deploymentId"`
	SHA256             string                   `json:"sha256"`
	Size               int64                    `json:"size"`
	Generation         uint64                   `json:"generation"`
	RuntimeConfig      json.RawMessage          `json:"runtimeConfig"`
	CertificateID      string                   `json:"certificateId,omitempty"`
	CertificateVersion string                   `json:"certificateVersion,omitempty"`
	SPAFallback        bool                     `json:"spaFallback,omitempty"`
	FallbackURL        string                   `json:"fallbackUrl,omitempty"`
	Access             *PreviewAccess           `json:"access,omitempty"`
	ClientIP           *PreviewClientIP         `json:"clientIp,omitempty"`
}

type BindingInspection struct {
	Matches          []bool `json:"matches"`
	VerifiedReleases int    `json:"verifiedReleases"`
}

// InspectBindings does one full validation per distinct release in this batch.
// No verification survives the request: a later cycle sees filesystem drift.
// Incorrect permissions are repaired; already-correct files are never chmoded.
func (r *Runtime) InspectBindings(expected []BindingExpectation) BindingInspection {
	result := BindingInspection{Matches: make([]bool, len(expected))}
	type verification struct {
		manifest releaseManifest
		err      error
	}
	releases := make(map[string]verification)
	for i, binding := range expected {
		if validateID(binding.DeploymentID) != nil || !sha256Pattern.MatchString(binding.SHA256) || binding.Size <= 0 ||
			validateRuntimeConfigBinding(binding.Kind, binding.ID) != nil || binding.Generation == 0 {
			continue
		}
		verified, found := releases[binding.DeploymentID]
		if !found {
			verified.manifest, verified.err = r.VerifyRelease(binding.DeploymentID, "")
			releases[binding.DeploymentID] = verified
			result.VerifiedReleases++
		}
		if verified.err != nil || verified.manifest.DeploymentID != binding.DeploymentID ||
			verified.manifest.SHA256 != binding.SHA256 || verified.manifest.Size != binding.Size {
			continue
		}
		result.Matches[i] = r.bindingMatches(binding)
	}
	return result
}

func (r *Runtime) bindingMatches(binding BindingExpectation) bool {
	if binding.CertificateID != "" && (!certPattern.MatchString(binding.CertificateID) || !sha256Pattern.MatchString(binding.CertificateVersion)) {
		return false
	}
	if binding.CertificateID == "" && binding.CertificateVersion != "" || binding.FallbackURL != "" && !validPagesFallbackURL(binding.FallbackURL) {
		return false
	}
	if validatePreviewAccess(binding.Access) != nil || r.ensurePreviewCredentials(binding.Access) != nil || validatePreviewClientIP(binding.ClientIP) != nil {
		return false
	}
	canonical, err := canonicalRuntimeConfig(binding.RuntimeConfig)
	if err != nil {
		return false
	}
	wantedJS, err := runtimeConfigJavaScript(canonical)
	if err != nil {
		return false
	}
	if err := r.ensureRuntimeConfigPublicDirs(binding.Kind, binding.ID); err != nil {
		return false
	}
	if err := r.ensureRuntimeConfigBindingMetadata(binding.Kind, binding.ID); err != nil {
		return false
	}
	currentPath, err := r.RuntimeConfigPath(binding.Kind, binding.ID)
	if err != nil {
		return false
	}
	target, err := os.Readlink(currentPath)
	if err != nil || target != "versions/"+strconv.FormatUint(binding.Generation, 10)+".js" || validateRuntimeConfigCurrentTarget(currentPath, target) != nil {
		return false
	}
	versionPath := filepath.Join(filepath.Dir(currentPath), target)
	if err := chmodNoFollowRegular(versionPath, publicFileMode); err != nil {
		return false
	}
	actualJS, err := readFileNoFollow(versionPath)
	if err != nil || !bytes.Equal(actualJS, wantedJS) {
		return false
	}
	configPath := r.routeIncludePath(binding.ID)
	wanted := r.routeConfig(binding.ID, binding.DeploymentID, currentPath)
	if binding.Kind == RuntimeConfigBindingPreview {
		configPath = r.previewConfigPath(binding.ID)
		wanted = r.previewConfig(binding.ID, binding.DeploymentID, binding.CertificateID, binding.CertificateVersion, currentPath, PreviewFallback{SPAFallback: binding.SPAFallback, URL: binding.FallbackURL, Access: binding.Access, ClientIP: binding.ClientIP})
	}
	actual, err := readFileNoFollow(configPath)
	return err == nil && bytes.Equal(actual, []byte(wanted))
}
