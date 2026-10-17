package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/updateauth"
)

type fakeTransport map[string]*http.Response

func (f fakeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	for prefix, response := range f {
		if strings.HasPrefix(request.URL.String(), prefix) {
			return response, nil
		}
	}
	return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(""))}, nil
}

func respond(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}
}

func testConfig(t *testing.T, transport fakeTransport, replaced *bool) Config {
	executable := filepath.Join(t.TempDir(), "lease-watchdog")
	if err := os.WriteFile(executable, []byte("current"), 0o755); err != nil {
		t.Fatal(err)
	}
	return Config{
		ReleasesURL: "https://updates.test/opfield/releases", ArtifactBaseURL: "https://updates.test/opfield",
		Current: "v1.0.0", Executable: executable, HTTP: &http.Client{Transport: transport},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Replace: func(string, string, string, string, string, string, *slog.Logger) error {
			*replaced = true
			return nil
		},
		SelfTest: func(context.Context, string) error { return nil },
	}
}

func TestNoUpdateLeavesBinaryAlone(t *testing.T) {
	replaced := false
	cfg := testConfig(t, fakeTransport{"https://updates.test/opfield/releases": respond(http.StatusNoContent, "")}, &replaced)
	result, err := Check(context.Background(), cfg)
	if err != nil || result.Updated || replaced {
		t.Fatalf("result %+v err %v replaced %v", result, err, replaced)
	}
}

func TestUntrustedManifestIsRejectedBeforeDownload(t *testing.T) {
	_, forged, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(updateauth.DaemonManifestPayload{
		Kind: "daemon-binary", Version: "v1.0.1", Tag: "v1.0.1-watchdog", DaemonType: DaemonType,
		ArtifactName: "lease-watchdog-linux-amd64", DownloadURL: "https://evil.test/x", SHA256: strings.Repeat("a", 64),
	})
	envelope, _ := json.Marshal(updateauth.SignPayload(forged, payload))
	replaced := false
	cfg := testConfig(t, fakeTransport{
		"https://updates.test/opfield/releases":        respond(http.StatusOK, `{"target":{"tag_name":"v1.0.1-watchdog"}}`),
		"https://updates.test/opfield/lease-watchdog/": respond(http.StatusOK, string(envelope)),
	}, &replaced)
	if _, err := Check(context.Background(), cfg); err == nil || replaced {
		t.Fatalf("forged manifest must be rejected before any download, err %v replaced %v", err, replaced)
	}
	if data, _ := os.ReadFile(cfg.Executable); string(data) != "current" {
		t.Fatal("running binary must stay untouched")
	}
}

func TestOtherComponentTagIsIgnored(t *testing.T) {
	replaced := false
	cfg := testConfig(t, fakeTransport{
		"https://updates.test/opfield/releases": respond(http.StatusOK, `{"target":{"tag_name":"v1.0.1-docker"}}`),
	}, &replaced)
	result, err := Check(context.Background(), cfg)
	if err != nil || result.Updated || replaced {
		t.Fatalf("result %+v err %v replaced %v", result, err, replaced)
	}
}
