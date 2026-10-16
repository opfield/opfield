package nginx

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestSweepCertificatesKeepsCurrentPreviousRecentAndReferencedVersions(t *testing.T) {
	certsDir := t.TempDir()
	configDir := t.TempDir()
	const certID = "11111111-1111-1111-1111-111111111111"
	for _, version := range []string{"v1", "v2", "v3", "v4", "v5"} {
		if _, err := DeployVersionedCert(certsDir, certID, version, "1", []byte("cert-"+version), []byte("key"), nil); err != nil {
			t.Fatal(err)
		}
	}
	versionsDir := filepath.Join(certsDir, certID, "versions")
	now := time.Now()
	ages := map[string]time.Duration{"v1": 50 * time.Hour, "v2": 40 * time.Hour, "v3": 30 * time.Hour, "v4": 20 * time.Hour, "v5": 10 * time.Hour}
	for version, age := range ages {
		at := now.Add(-age)
		if err := os.Chtimes(filepath.Join(versionsDir, version), at, at); err != nil {
			t.Fatal(err)
		}
	}
	// A fresh version from a change still being tested, a Pages preview naming v1, and a crash-left stage.
	if _, err := DeployVersionedCert(certsDir, certID, "v6", "1", []byte("cert-v6"), []byte("key"), nil); err != nil {
		t.Fatal(err)
	}
	if err := RestoreCertPointer(certsDir, certID, CertPointer{Exists: true, Target: "versions/v5"}); err != nil {
		t.Fatal(err)
	}
	preview := "ssl_certificate " + filepath.Join(certsDir, certID, "versions", "v1", "fullchain.pem") + ";\n"
	if err := os.WriteFile(filepath.Join(configDir, "pages-preview-abc.conf"), []byte(preview), 0o644); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(certsDir, certID, ".certificate-stage-123")
	if err := os.Mkdir(stage, 0o755); err != nil {
		t.Fatal(err)
	}
	old := now.Add(-2 * time.Hour)
	if err := os.Chtimes(stage, old, old); err != nil {
		t.Fatal(err)
	}

	result, err := SweepCertificates(certsDir, configDir, now)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(versionsDir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	// v5 current, v6 recent (and the most recent other), v1 referenced; v2-v4 go.
	if strings.Join(names, ",") != "v1,v5,v6" {
		t.Fatalf("versions after sweep = %v", names)
	}
	if result.Versions != 3 || result.Stages != 1 {
		t.Fatalf("result = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(certsDir, certID, "current", "fullchain.pem")); err != nil {
		t.Fatalf("current certificate no longer resolves: %v", err)
	}
}

func TestSweepCertificatesLeavesCertificatesWithoutPointer(t *testing.T) {
	certsDir := t.TempDir()
	const certID = "22222222-2222-2222-2222-222222222222"
	for _, version := range []string{"a", "b", "c"} {
		if err := os.MkdirAll(filepath.Join(certsDir, certID, "versions", version), 0o755); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-48 * time.Hour)
		_ = os.Chtimes(filepath.Join(certsDir, certID, "versions", version), old, old)
	}
	if err := DeployCert(certsDir, "legacy", []byte("cert"), []byte("key"), nil); err != nil {
		t.Fatal(err)
	}
	result, err := SweepCertificates(certsDir, t.TempDir(), time.Now())
	if err != nil || result.Versions != 0 {
		t.Fatalf("result = %#v, %v", result, err)
	}
}
