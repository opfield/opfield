package nginx

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// certificateLeftoverAge: a certificate stage exists only while one command runs; an older one was left by a
	// crash.
	certificateLeftoverAge = time.Hour
	// certificateVersionGrace: a version written this recently may belong to a change still being tested.
	certificateVersionGrace = time.Hour
	// maxConfigScanBytes bounds one config file read while looking for certificate version references.
	maxConfigScanBytes = 8 << 20
)

// CertificateSweepResult counts what SweepCertificates removed.
type CertificateSweepResult struct {
	Stages   int
	Versions int
}

// SweepCertificates removes, in every certificate directory, crash-left `.certificate-stage-*` directories and the
// version directories nothing can use any more: every renewal adds one (DeployVersionedCert) and only removing the
// whole certificate removed them before. It keeps the version `current` points to, the most recent other version
// (the rollback target of the next change), versions written within the last hour, and every version a file under
// configDir names (Pages previews name a version directly). The caller serializes it with configuration changes.
func SweepCertificates(certsDir, configDir string, now time.Time) (CertificateSweepResult, error) {
	result := CertificateSweepResult{}
	entries, err := os.ReadDir(certsDir)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	var references []string
	referencesRead := false
	var errs []error
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		root := filepath.Join(certsDir, entry.Name())
		children, err := os.ReadDir(root)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, child := range children {
			if !strings.HasPrefix(child.Name(), ".certificate-stage-") {
				continue
			}
			path := filepath.Join(root, child.Name())
			if info, err := os.Lstat(path); err == nil && info.ModTime().Before(now.Add(-certificateLeftoverAge)) {
				if os.RemoveAll(path) == nil {
					result.Stages++
				}
			}
		}
		candidates := unusedCertificateVersions(root, now)
		if len(candidates) == 0 {
			continue
		}
		if !referencesRead {
			references, err = readConfigReferences(configDir)
			if err != nil {
				// Without the configs no version can be proven unused.
				return result, errors.Join(append(errs, err)...)
			}
			referencesRead = true
		}
		for _, version := range candidates {
			needle := "/" + entry.Name() + "/versions/" + version + "/"
			if referenced(references, needle) {
				continue
			}
			if err := os.RemoveAll(filepath.Join(root, "versions", version)); err != nil {
				errs = append(errs, err)
				continue
			}
			result.Versions++
		}
	}
	return result, errors.Join(errs...)
}

// unusedCertificateVersions lists the versions of one certificate other than its current one, the most recent
// other one and the ones written within certificateVersionGrace. A certificate whose current pointer cannot be read
// keeps every version.
func unusedCertificateVersions(root string, now time.Time) []string {
	versionsDir := filepath.Join(root, "versions")
	entries, err := os.ReadDir(versionsDir)
	if err != nil {
		return nil
	}
	target, err := os.Readlink(filepath.Join(root, "current"))
	if err != nil || filepath.Dir(filepath.Clean(target)) != "versions" {
		return nil
	}
	current := filepath.Base(target)
	type version struct {
		name     string
		modified time.Time
	}
	others := []version{}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == current || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := os.Lstat(filepath.Join(versionsDir, entry.Name()))
		if err != nil || !info.IsDir() {
			continue
		}
		others = append(others, version{name: entry.Name(), modified: info.ModTime()})
	}
	newest := -1
	for index, candidate := range others {
		if newest < 0 || candidate.modified.After(others[newest].modified) {
			newest = index
		}
	}
	unused := []string{}
	for index, candidate := range others {
		if index == newest || candidate.modified.After(now.Add(-certificateVersionGrace)) {
			continue
		}
		unused = append(unused, candidate.name)
	}
	return unused
}

// readConfigReferences reads every regular file under configDir (route, Pages and daemon configs).
func readConfigReferences(configDir string) ([]string, error) {
	contents := []string{}
	err := filepath.WalkDir(configDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) && path == configDir {
				return filepath.SkipDir
			}
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() > maxConfigScanBytes {
			return errors.New("config file too large to scan for certificate references: " + path)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		contents = append(contents, string(content))
		return nil
	})
	return contents, err
}

func referenced(contents []string, needle string) bool {
	for _, content := range contents {
		if strings.Contains(content, needle) {
			return true
		}
	}
	return false
}
