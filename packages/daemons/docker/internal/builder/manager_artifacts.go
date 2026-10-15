package builder

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func containedPath(root, relative string) (string, error) {
	resolved := filepath.Join(root, relative)
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", errors.New("path escapes build checkout")
	}
	return resolved, nil
}

func readBuildMetadata(path string) (buildMetadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return buildMetadata{}, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return buildMetadata{}, err
	}
	var digest string
	_ = json.Unmarshal(raw["containerimage.digest"], &digest)
	if !imageDigestPattern.MatchString(digest) {
		return buildMetadata{}, errors.New("BuildKit did not return an immutable image digest")
	}
	var descriptor struct {
		Size int64 `json:"size"`
	}
	_ = json.Unmarshal(raw["containerimage.descriptor"], &descriptor)
	return buildMetadata{Digest: digest, Size: max(descriptor.Size, 0)}, nil
}

func (m *Manager) measureImage(ctx context.Context, repository, digest string) (int64, error) {
	caPEM, err := os.ReadFile(m.config.RegistryCAPath)
	if err != nil {
		return 0, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return 0, errors.New("builder registry CA is invalid")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}}}
	var visit func(string, int) (int64, error)
	visit = func(reference string, depth int) (int64, error) {
		if depth > 3 {
			return 0, errors.New("registry manifest nesting exceeds limit")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://127.0.0.1:5443/v2/"+repository+"/manifests/"+reference, nil)
		if err != nil {
			return 0, err
		}
		request.Header.Set("Accept", strings.Join([]string{
			"application/vnd.oci.image.index.v1+json",
			"application/vnd.oci.image.manifest.v1+json",
			"application/vnd.docker.distribution.manifest.list.v2+json",
			"application/vnd.docker.distribution.manifest.v2+json",
		}, ", "))
		response, err := client.Do(request)
		if err != nil {
			return 0, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return 0, fmt.Errorf("registry manifest request returned %s", response.Status)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
		if err != nil {
			return 0, err
		}
		var manifest struct {
			Config struct {
				Size int64 `json:"size"`
			} `json:"config"`
			Layers []struct {
				Size int64 `json:"size"`
			} `json:"layers"`
			Manifests []struct {
				Digest string `json:"digest"`
				Size   int64  `json:"size"`
			} `json:"manifests"`
		}
		if err := json.Unmarshal(body, &manifest); err != nil {
			return 0, err
		}
		total := int64(len(body)) + max(manifest.Config.Size, 0)
		for _, layer := range manifest.Layers {
			total += max(layer.Size, 0)
		}
		for _, child := range manifest.Manifests {
			childSize, err := visit(child.Digest, depth+1)
			if err != nil {
				return 0, err
			}
			total += max(childSize, child.Size)
		}
		return total, nil
	}
	return visit(digest, 0)
}
func summarizeGrype(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var report struct {
		Matches []struct {
			Vulnerability struct {
				ID         string `json:"id"`
				Severity   string `json:"severity"`
				Namespace  string `json:"namespace"`
				DataSource string `json:"dataSource"`
				Fix        struct {
					Versions []string `json:"versions"`
					State    string   `json:"state"`
				} `json:"fix"`
			} `json:"vulnerability"`
			Artifact struct {
				Name    string `json:"name"`
				Version string `json:"version"`
				Type    string `json:"type"`
			} `json:"artifact"`
		} `json:"matches"`
	}
	if err := json.Unmarshal(data, &report); err != nil {
		return "", err
	}
	type vulnerabilityFinding struct {
		ID               string   `json:"id"`
		Severity         string   `json:"severity"`
		PackageName      string   `json:"packageName"`
		InstalledVersion string   `json:"installedVersion"`
		PackageType      string   `json:"packageType"`
		FixedVersions    []string `json:"fixedVersions"`
		FixState         string   `json:"fixState"`
		Namespace        string   `json:"namespace"`
		DataSource       string   `json:"dataSource"`
	}
	type severityCounts struct {
		Critical   int `json:"critical"`
		High       int `json:"high"`
		Medium     int `json:"medium"`
		Low        int `json:"low"`
		Negligible int `json:"negligible"`
		Unknown    int `json:"unknown"`
	}
	type scanSummary struct {
		severityCounts
		Scanner                  string                 `json:"scanner"`
		OSPackages               severityCounts         `json:"osPackages"`
		Fixable                  severityCounts         `json:"fixable"`
		FixableOSPackages        severityCounts         `json:"fixableOsPackages"`
		Vulnerabilities          []vulnerabilityFinding `json:"vulnerabilities"`
		VulnerabilitiesTruncated int                    `json:"vulnerabilitiesTruncated"`
	}
	trimValue := func(value string) string {
		runes := []rune(strings.TrimSpace(value))
		if len(runes) > 512 {
			runes = runes[:512]
		}
		return string(runes)
	}
	summary := scanSummary{Scanner: "grype", Vulnerabilities: make([]vulnerabilityFinding, 0, len(report.Matches))}
	for _, match := range report.Matches {
		severity := strings.ToLower(match.Vulnerability.Severity)
		counts := []*severityCounts{&summary.severityCounts}
		// OS package managers only: runtime binaries and unknown package types
		// remain subject to application policy. Count before truncating details.
		osPackage := false
		switch strings.ToLower(strings.TrimSpace(match.Artifact.Type)) {
		case "deb", "rpm", "apk", "alpm":
			osPackage = true
			counts = append(counts, &summary.OSPackages)
		}
		// Fixable: the vulnerability database reports a released fix.
		if grypeMatchFixable(match.Vulnerability.Fix.State, match.Vulnerability.Fix.Versions) {
			counts = append(counts, &summary.Fixable)
			if osPackage {
				counts = append(counts, &summary.FixableOSPackages)
			}
		}
		for _, count := range counts {
			switch severity {
			case "critical":
				count.Critical++
			case "high":
				count.High++
			case "medium":
				count.Medium++
			case "low":
				count.Low++
			case "negligible":
				count.Negligible++
			default:
				severity = "unknown"
				count.Unknown++
			}
		}
		id := trimValue(match.Vulnerability.ID)
		if id == "" {
			continue
		}
		fixedVersions := make([]string, 0, min(len(match.Vulnerability.Fix.Versions), 5))
		for _, version := range match.Vulnerability.Fix.Versions {
			if len(fixedVersions) == 5 {
				break
			}
			if value := trimValue(version); value != "" {
				fixedVersions = append(fixedVersions, value)
			}
		}
		summary.Vulnerabilities = append(summary.Vulnerabilities, vulnerabilityFinding{
			ID:               id,
			Severity:         severity,
			PackageName:      trimValue(match.Artifact.Name),
			InstalledVersion: trimValue(match.Artifact.Version),
			PackageType:      trimValue(match.Artifact.Type),
			FixedVersions:    fixedVersions,
			FixState:         trimValue(match.Vulnerability.Fix.State),
			Namespace:        trimValue(match.Vulnerability.Namespace),
			DataSource:       trimValue(match.Vulnerability.DataSource),
		})
	}
	severityOrder := map[string]int{"critical": 0, "high": 1, "medium": 2, "low": 3, "negligible": 4, "unknown": 5}
	sort.SliceStable(summary.Vulnerabilities, func(i, j int) bool {
		left, right := summary.Vulnerabilities[i], summary.Vulnerabilities[j]
		if severityOrder[left.Severity] != severityOrder[right.Severity] {
			return severityOrder[left.Severity] < severityOrder[right.Severity]
		}
		if left.ID != right.ID {
			return left.ID < right.ID
		}
		return left.PackageName < right.PackageName
	})
	if len(summary.Vulnerabilities) > maxScanVulnerabilities {
		summary.VulnerabilitiesTruncated = len(summary.Vulnerabilities) - maxScanVulnerabilities
		summary.Vulnerabilities = summary.Vulnerabilities[:maxScanVulnerabilities]
	}
	encoded, _ := json.Marshal(summary)
	return string(encoded), nil
}

// grypeMatchFixable reports whether a grype match has a released fix: fix
// state "fixed", or listed fixed versions when the state is not an explicit
// "not-fixed" or "wont-fix".
func grypeMatchFixable(state string, versions []string) bool {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "fixed":
		return true
	case "not-fixed", "wont-fix":
		return false
	}
	for _, version := range versions {
		if strings.TrimSpace(version) != "" {
			return true
		}
	}
	return false
}
