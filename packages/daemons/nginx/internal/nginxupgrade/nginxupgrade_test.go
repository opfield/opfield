package nginxupgrade

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func repoFile(t *testing.T, rel string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", rel))
	if errors.Is(err, os.ErrNotExist) {
		t.Skipf("%s is not in this checkout", rel)
	}
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// The installer carries the helper the daemon embeds, and every component names the same minimum version.
func TestHelperAndMinimumVersionMatchInstallerAndBackend(t *testing.T) {
	installer := string(repoFile(t, "scripts/setup-node.sh"))
	const start = "    cat <<'OPFIELD_NGINX_UPGRADE_HELPER'\n"
	const end = "\nOPFIELD_NGINX_UPGRADE_HELPER\n"
	i := strings.Index(installer, start)
	j := strings.Index(installer, end)
	if i < 0 || j < i {
		t.Fatal("setup-node.sh does not carry the nginx upgrade helper")
	}
	if got := installer[i+len(start) : j+1]; got != string(Script) {
		t.Fatal("the helper in setup-node.sh differs from nginx-upgrade.sh; copy nginx-upgrade.sh into the installer")
	}
	for _, check := range []struct {
		name    string
		content string
		pattern string
	}{
		{"setup-node.sh", installer, `(?m)^NGINX_MIN_VERSION="([0-9.]+)"$`},
		{"nginx-upgrade.sh", string(Script), `(?m)^ONU_MIN_VERSION=([0-9.]+)$`},
		{"nginx-minimum-version.ts", string(repoFile(t, "packages/backend/src/modules/nodes/nginx-minimum-version.ts")),
			`NGINX_MINIMUM_VERSION = '([0-9.]+)'`},
	} {
		match := regexp.MustCompile(check.pattern).FindStringSubmatch(check.content)
		if match == nil || match[1] != MinimumVersion {
			t.Errorf("%s names minimum nginx %v, the daemon %s", check.name, match, MinimumVersion)
		}
	}
}

func TestAtLeast(t *testing.T) {
	for _, tc := range []struct {
		actual, required string
		want             bool
	}{
		{"1.30.6", "1.30.6", true},
		{"1.30.10", "1.30.6", true},
		{"1.31.0", "1.30.6", true},
		{"2.0", "1.30.6", true},
		{"1.30.5", "1.30.6", false},
		{"1.28.3", "1.30.6", false},
		{"1.30", "1.30.6", false},
		{"", "1.30.6", false},
		{"nginx/1.30.6", "1.30.6", false},
	} {
		if got := AtLeast(tc.actual, tc.required); got != tc.want {
			t.Errorf("AtLeast(%q, %q) = %v, want %v", tc.actual, tc.required, got, tc.want)
		}
	}
}

func TestParseStatus(t *testing.T) {
	st := ParseStatus([]byte("state=failed\nfrom=1.28.3\nto=\nat=1792847086\nerror=could not add the repository: 404 \n"))
	if st.State != "failed" || st.From != "1.28.3" || st.Error != "could not add the repository: 404" || st.At.Unix() != 1792847086 {
		t.Fatalf("unexpected status %+v", st)
	}
}

type fakeHost struct {
	versions []string
	defer_   string
	pid      int
	locked   bool
	swapped  string
}

func (h *fakeHost) Version() (string, error) {
	v := h.versions[0]
	if len(h.versions) > 1 {
		h.versions = h.versions[1:]
	}
	return v, nil
}
func (h *fakeHost) DeferReason() string     { return h.defer_ }
func (h *fakeHost) MasterPID() (int, error) { return h.pid, nil }
func (h *fakeHost) WithReloadLock(fn func() error) error {
	h.locked = true
	defer func() { h.locked = false }()
	return fn()
}
func (h *fakeHost) Swapped(version string) { h.swapped = version }

func newTestUpgrader(host *fakeHost, mode string) (*Upgrader, *[]string) {
	u := New(host, slog.New(slog.NewTextHandler(io.Discard, nil)))
	calls := &[]string{}
	u.mode = func() string { return mode }
	u.poll = time.Millisecond
	u.exeReplaced = func(int) bool { return true }
	u.trigger = func(context.Context, string) error { *calls = append(*calls, "trigger"); return nil }
	u.runSwap = func(context.Context) (string, error) {
		if !host.locked {
			return "", errors.New("swap without the reload lock")
		}
		*calls = append(*calls, "swap")
		return "swapped", nil
	}
	return u, calls
}

func TestCheckUpgradesAnOldNginxAndSwapsUnderTheReloadLock(t *testing.T) {
	host := &fakeHost{versions: []string{"1.28.3", "1.30.6"}, pid: 42}
	u, calls := newTestUpgrader(host, ModeDirect)
	u.readStatus = func() (Status, error) {
		return Status{State: "installed", From: "1.28.3", To: "1.30.6", At: time.Now().Add(time.Second)}, nil
	}
	u.Check(context.Background())
	report := u.Report()
	if report.State != StateCurrent || report.PreviousVersion != "1.28.3" || report.UpgradedAt == 0 || report.Mode != ModeDirect {
		t.Fatalf("unexpected report %+v", report)
	}
	if strings.Join(*calls, ",") != "trigger,swap" || host.swapped != "1.30.6" {
		t.Fatalf("calls %v, swapped %q", *calls, host.swapped)
	}
}

func TestCheckIgnoresAStatusOlderThanItsRequest(t *testing.T) {
	host := &fakeHost{versions: []string{"1.28.3"}, pid: 42}
	u, _ := newTestUpgrader(host, ModeHelper)
	reads := 0
	u.readStatus = func() (Status, error) {
		reads++
		if reads < 3 {
			return Status{State: "failed", Error: "an earlier run", At: time.Now().Add(-time.Hour)}, nil
		}
		return Status{State: "failed", Error: "gpg is needed", At: time.Now().Add(time.Second)}, nil
	}
	u.Check(context.Background())
	if report := u.Report(); report.State != StateFailed || report.Detail != "gpg is needed" {
		t.Fatalf("unexpected report %+v", report)
	}
}

func TestCheckDefersAndReportsManualMode(t *testing.T) {
	host := &fakeHost{versions: []string{"1.28.3"}, defer_: "a configuration change waits for its nginx reload"}
	u, calls := newTestUpgrader(host, ModeDirect)
	u.Check(context.Background())
	if report := u.Report(); report.State != StateDeferred || report.Detail != host.defer_ || len(*calls) != 0 {
		t.Fatalf("unexpected report %+v, calls %v", report, *calls)
	}

	host.defer_ = ""
	u, calls = newTestUpgrader(host, ModeManual)
	u.Check(context.Background())
	report := u.Report()
	if report.State != StateManual || report.Command != ManualCommand() || report.Command == "" || len(*calls) != 0 {
		t.Fatalf("unexpected report %+v, calls %v", report, *calls)
	}
}

// A binary installed by hand or by an earlier run that a restart interrupted is swapped in once nginx -v is current.
func TestCheckSwapsACurrentBinaryTheMasterDoesNotRunYet(t *testing.T) {
	host := &fakeHost{versions: []string{"1.30.6"}, pid: 42}
	u, calls := newTestUpgrader(host, ModeDirect)
	u.Check(context.Background())
	if report := u.Report(); report.State != StateCurrent || strings.Join(*calls, ",") != "swap" {
		t.Fatalf("unexpected report %+v, calls %v", report, *calls)
	}

	host = &fakeHost{versions: []string{"1.30.6"}, pid: 42}
	u, calls = newTestUpgrader(host, ModeDirect)
	u.exeReplaced = func(int) bool { return false }
	u.Check(context.Background())
	if report := u.Report(); report.State != StateCurrent || len(*calls) != 0 {
		t.Fatalf("unexpected report %+v, calls %v", report, *calls)
	}
}

// A deferral does not last forever: after a day the upgrade runs anyway.
func TestCheckRunsADeferredUpgradeAfterADay(t *testing.T) {
	host := &fakeHost{versions: []string{"1.28.3", "1.28.3", "1.30.6"}, pid: 42, defer_: "the node's ingress health check fails"}
	u, calls := newTestUpgrader(host, ModeDirect)
	now := time.Now()
	u.now = func() time.Time { return now }
	u.readStatus = func() (Status, error) {
		return Status{State: "installed", From: "1.28.3", To: "1.30.6", At: now.Add(time.Second)}, nil
	}
	u.Check(context.Background())
	if report := u.Report(); report.State != StateDeferred || len(*calls) != 0 {
		t.Fatalf("unexpected report %+v, calls %v", report, *calls)
	}
	now = now.Add(25 * time.Hour)
	u.Check(context.Background())
	if report := u.Report(); report.State != StateCurrent || strings.Join(*calls, ",") != "trigger,swap" {
		t.Fatalf("unexpected report %+v, calls %v", report, *calls)
	}
}
