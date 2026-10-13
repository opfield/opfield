package lifecycle

import (
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/updateauth"
)

func TestSelfUpdateRejectsMissingChecksum(t *testing.T) {
	t.Setenv(LauncherManagedEnv, "1")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := SelfUpdate("https://gitlab.wiolett.net/update", "v9.9.9", "", "manifest", "nginx", logger)
	if err == nil {
		t.Fatal("expected missing checksum to be rejected")
	}
}

func TestSelfUpdateRejectsMissingSignedManifest(t *testing.T) {
	t.Setenv(LauncherManagedEnv, "1")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := SelfUpdate(
		"https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64",
		"v9.9.9",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"",
		"nginx",
		logger,
	)
	if err == nil {
		t.Fatal("expected missing signed manifest to be rejected")
	}
}

func TestSelfUpdateRejectsUnsafeDirectMode(t *testing.T) {
	t.Setenv(LauncherManagedEnv, "")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := SelfUpdate(
		"https://gitlab.wiolett.net/update",
		"v9.9.9",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"manifest",
		"nginx",
		logger,
	)
	if err == nil || !strings.Contains(err.Error(), "requires launcher supervision") {
		t.Fatalf("expected direct self-update rejection, got %v", err)
	}
}

func TestReplaceBinaryAtPathReplacesVerifiedArtifact(t *testing.T) {
	artifact := []byte("new-daemon-binary")
	checksum := fmt.Sprintf("%x", sha256.Sum256(artifact))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(artifact)
	}))
	defer server.Close()

	destination := filepath.Join(t.TempDir(), "nginx-daemon")
	if err := os.WriteFile(destination, []byte("old-daemon-binary"), 0755); err != nil {
		t.Fatal(err)
	}
	downloadURL := server.URL + "/v2.10.0-rc.27-nginx/nginx-daemon-linux-" + updateauth.NormalizeArch(runtime.GOARCH)
	verifyCalled := false
	verify := func(manifest string, expected updateauth.DaemonExpectation) (*updateauth.DaemonManifestPayload, error) {
		verifyCalled = true
		if manifest != "signed-manifest" {
			t.Fatalf("manifest = %q", manifest)
		}
		if expected.DaemonType != "nginx" || expected.Version != "v2.10.0-rc.27" || expected.Tag != "v2.10.0-rc.27-nginx" {
			t.Fatalf("unexpected manifest expectation: %#v", expected)
		}
		if expected.Arch != updateauth.NormalizeArch(runtime.GOARCH) || expected.DownloadURL != downloadURL || expected.SHA256 != checksum {
			t.Fatalf("unexpected artifact expectation: %#v", expected)
		}
		return &updateauth.DaemonManifestPayload{}, nil
	}

	err := replaceBinaryAtPath(
		downloadURL,
		"v2.10.0-rc.27",
		checksum,
		"signed-manifest",
		"nginx",
		destination,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		verify,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !verifyCalled {
		t.Fatal("signed manifest was not verified")
	}
	contents, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != string(artifact) {
		t.Fatalf("destination contents = %q", contents)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0755 {
		t.Fatalf("destination mode = %o", info.Mode().Perm())
	}
}

func TestReplaceBinaryAtPathKeepsCurrentBinaryOnChecksumMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("corrupted-candidate"))
	}))
	defer server.Close()

	destination := filepath.Join(t.TempDir(), "docker-daemon")
	if err := os.WriteFile(destination, []byte("current-binary"), 0755); err != nil {
		t.Fatal(err)
	}
	verify := func(_ string, _ updateauth.DaemonExpectation) (*updateauth.DaemonManifestPayload, error) {
		return &updateauth.DaemonManifestPayload{}, nil
	}
	err := replaceBinaryAtPath(
		server.URL+"/v2.10.0-rc.27-docker/docker-daemon-linux-amd64",
		"v2.10.0-rc.27",
		fmt.Sprintf("%x", sha256.Sum256([]byte("expected-candidate"))),
		"signed-manifest",
		"docker",
		destination,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		verify,
	)
	if err == nil {
		t.Fatal("expected checksum mismatch")
	}
	contents, readErr := os.ReadFile(destination)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(contents) != "current-binary" {
		t.Fatalf("current binary was replaced: %q", contents)
	}
}
