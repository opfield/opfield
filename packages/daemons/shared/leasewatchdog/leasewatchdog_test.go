package leasewatchdog

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/updateauth"
)

const installerPath = "../../../../scripts/setup-docker-node.sh"

// heredoc returns the body of the first heredoc that follows marker.
func heredoc(t *testing.T, script, marker string) string {
	t.Helper()
	start := strings.Index(script, marker)
	if start < 0 {
		t.Fatalf("installer has no %q", marker)
	}
	body := script[start+len(marker):]
	body = body[strings.Index(body, "\n")+1:]
	end := strings.Index(body, "\nUNIT\n")
	if end < 0 {
		t.Fatal("unterminated heredoc")
	}
	return body[:end+1]
}

// The installer is the source of truth: the daemon's bootstrap must write the
// same binary path, unit name and service files.
func TestServiceDefinitionsMatchTheNodeInstaller(t *testing.T) {
	data, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	for name, want := range map[string]string{"LEASE_WATCHDOG_BIN": BinaryPath, "LEASE_WATCHDOG_UNIT": UnitName} {
		if !strings.Contains(script, name+`="`+want+`"`) {
			t.Fatalf("installer %s differs from %q", name, want)
		}
	}
	argsLine := regexp.MustCompile(`local args="([^"]+)"`).FindStringSubmatch(script)
	if argsLine == nil || argsLine[1] != RunArgs("${RUN_USER}", "${RELEASES_API_URL}", "${ARTIFACT_BASE_URL}", "$(lease_watchdog_channel)") {
		t.Fatalf("installer watchdog args %q differ from RunArgs", argsLine)
	}
	replacer := strings.NewReplacer("${LEASE_WATCHDOG_BIN}", BinaryPath, "${args}", "ARGS", "${LEASE_WATCHDOG_UNIT}", UnitName, `\${RC_SVCNAME}`, "${RC_SVCNAME}")
	systemd := replacer.Replace(heredoc(t, script, `cat > "/etc/systemd/system/${LEASE_WATCHDOG_UNIT}.service" <<UNIT`))
	if systemd != SystemdUnit(BinaryPath, "ARGS") {
		t.Fatalf("systemd unit differs from the installer:\n%s\n---\n%s", systemd, SystemdUnit(BinaryPath, "ARGS"))
	}
	openrc := replacer.Replace(heredoc(t, script, `cat > "/etc/init.d/${LEASE_WATCHDOG_UNIT}" <<UNIT`))
	if openrc != OpenRCScript(BinaryPath, "ARGS") {
		t.Fatalf("OpenRC script differs from the installer:\n%s\n---\n%s", openrc, OpenRCScript(BinaryPath, "ARGS"))
	}
}

type fakeTransport map[string]string

func (f fakeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	for prefix, body := range f {
		if strings.HasPrefix(request.URL.String(), prefix) {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
		}
	}
	return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(strings.NewReader(""))}, nil
}

func TestReleaseResolutionAndForgedManifest(t *testing.T) {
	client := &http.Client{Transport: fakeTransport{"https://u.test/releases": `{"target":{"tag_name":"v2.0.1-watchdog"}}`}}
	tag, err := NextTag(context.Background(), client, "https://u.test/releases", "stable", "")
	if err != nil || tag != "v2.0.1-watchdog" {
		t.Fatalf("tag %q err %v", tag, err)
	}
	if tag, _ := NextTag(context.Background(), &http.Client{Transport: fakeTransport{}}, "https://u.test/releases", "", "v2.0.1"); tag != "" {
		t.Fatal("no content means no release")
	}
	_, forged, _ := ed25519.GenerateKey(rand.Reader)
	payload, _ := json.Marshal(updateauth.DaemonManifestPayload{Kind: "daemon-binary", DaemonType: DaemonType, Tag: tag, ArtifactName: ArtifactName()})
	envelope, _ := json.Marshal(updateauth.SignPayload(forged, payload))
	client = &http.Client{Transport: fakeTransport{"https://u.test/gateway/lease-watchdog/": string(envelope)}}
	if _, _, err := FetchManifest(context.Background(), client, "https://u.test/gateway", tag); err == nil {
		t.Fatal("a manifest not signed by the update key must be rejected")
	}
}

// The watchdog updates itself as root without an admin: whatever the update
// service names, it moves only to a newer release, and never to a release
// candidate on the stable channel (a first install included).
func TestNextTagTakesOnlyNewerReleasesOfTheChannel(t *testing.T) {
	offer := func(channel, current, tag string) (string, error) {
		client := &http.Client{Transport: fakeTransport{"https://u.test/releases": `{"target":{"tag_name":"` + tag + `"}}`}}
		return NextTag(context.Background(), client, "https://u.test/releases", channel, current)
	}
	for _, tc := range []struct {
		channel, current, tag string
		want                  string
		refused               bool
	}{
		{channel: "stable", current: "v2.10.1", tag: "v2.11.0-watchdog", want: "v2.11.0-watchdog"},
		{channel: "stable", current: "v2.11.0-rc.22", tag: "v2.11.0-watchdog", want: "v2.11.0-watchdog"},
		{channel: "preview", current: "v2.11.0-rc.22", tag: "v2.11.0-rc.23-watchdog", want: "v2.11.0-rc.23-watchdog"},
		{channel: "preview", current: "v2.11.0-rc.9", tag: "v2.11.0-rc.10-watchdog", want: "v2.11.0-rc.10-watchdog"},
		{channel: "stable", current: "", tag: "v2.11.0-watchdog", want: "v2.11.0-watchdog"},
		{channel: "stable", current: "v2.11.0", tag: "v2.11.0-watchdog", want: ""},
		{channel: "stable", current: "v2.11.0", tag: "v2.10.1-watchdog", refused: true},
		{channel: "preview", current: "v2.11.0-rc.22", tag: "v2.11.0-rc.21-watchdog", refused: true},
		{channel: "preview", current: "v2.11.0", tag: "v2.11.0-rc.30-watchdog", refused: true},
		{channel: "stable", current: "v2.10.1", tag: "v2.11.0-rc.30-watchdog", refused: true},
		{channel: "", current: "", tag: "v2.11.0-rc.30-watchdog", refused: true},
		{channel: "stable", current: "v2.10.1", tag: "v2.11-watchdog", refused: true},
	} {
		tag, err := offer(tc.channel, tc.current, tc.tag)
		if tc.refused {
			if err == nil || tag != "" {
				t.Fatalf("%s on %q from %q: took %q (err %v), want a refusal", tc.tag, tc.channel, tc.current, tag, err)
			}
			continue
		}
		if err != nil || tag != tc.want {
			t.Fatalf("%s on %q from %q: tag %q err %v, want %q", tc.tag, tc.channel, tc.current, tag, err, tc.want)
		}
	}
}

func TestOlderComparesReleases(t *testing.T) {
	for _, tc := range []struct {
		watchdog, daemon string
		older            bool
	}{
		{"v2.12.0", "v2.12.1-rc.3", true},
		{"v2.12.1-rc.3", "v2.12.1-rc.3", false},
		{"v2.12.1-rc.3-watchdog", "v2.12.1", true},
		{"v2.12.1", "v2.12.1-rc.4", false},
		{"v2.12.2", "v2.12.1", false},
		{"dev", "v2.12.1", false},
		{"", "v2.12.1", false},
		{"v2.12.0", "dev", false},
	} {
		if got := Older(tc.watchdog, tc.daemon); got != tc.older {
			t.Errorf("Older(%q, %q) = %v, want %v", tc.watchdog, tc.daemon, got, tc.older)
		}
	}
}
