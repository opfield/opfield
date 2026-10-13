package supervisor

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/opfield/opfield/relay-supervisor/internal/hostnames"
)

// F-4: a relay running as its own user commits an update without moving its
// names; it says so with the remedy, as the nginx daemon does.
func TestNonRootRelayWarnsThatItKeepsItsOldNames(t *testing.T) {
	var out bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&out, nil))
	warnHostNamesNeedInstaller(logger, hostnames.LegacyCount{"paths": 4, "services": 1}, "gwsvc")
	line := out.String()
	for _, want := range []string{"level=WARN", "run the relay installer of this release again as root with OPFIELD_RELAY_RUN_USER=gwsvc",
		"run_user=gwsvc", "paths=4", "services=1"} {
		if !strings.Contains(line, want) {
			t.Fatalf("warning %q lacks %q", line, want)
		}
	}
	out.Reset()
	warnHostNamesNeedInstaller(logger, hostnames.LegacyCount{}, "gwsvc")
	if out.Len() != 0 {
		t.Fatalf("a relay with nothing left to move warned: %s", out.String())
	}
}
