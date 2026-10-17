package docker

import (
	"context"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"io/fs"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/opfield/opfield/daemon-shared/leasewatchdog"
)

type watchdogUpdateHost struct {
	files    map[string]string
	commands [][]string
	output   string
}

func (h *watchdogUpdateHost) bootstrap(manager string) *watchdogBootstrap {
	return &watchdogBootstrap{
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		euid:           func() int { return 0 },
		release:        true,
		serviceManager: func() string { return manager },
		readFile: func(path string) ([]byte, error) {
			if content, ok := h.files[path]; ok {
				return []byte(content), nil
			}
			return nil, fs.ErrNotExist
		},
		run: func(_ context.Context, name string, args ...string) error {
			h.commands = append(h.commands, append([]string{name}, args...))
			return nil
		},
		runOutput: func(_ context.Context, name string, args ...string) (string, error) {
			h.commands = append(h.commands, append([]string{name}, args...))
			return h.output, nil
		},
	}
}

// F-8: after this daemon's update, a watchdog of an older release checks for
// its update at once, with the endpoints and channel of its service, and is
// restarted when it installed one. The pre-Opfield service, which runs while
// it is installed, is the one updated.
func TestOlderLeaseWatchdogUpdatesAfterTheDaemonUpdate(t *testing.T) {
	legacyArgs := "run --records-owner root --auto-update --releases-url https://u.test/releases --artifact-base-url https://u.test/a --channel preview"
	host := &watchdogUpdateHost{
		files: map[string]string{
			leasewatchdog.LegacySystemdUnitPath: "[Service]\nExecStart=" + leasewatchdog.LegacyBinaryPath + " " + legacyArgs + "\n",
		},
		output: "lease-watchdog updated to v2.12.1-rc.3-watchdog; restart the " + legacycompat.LeaseWatchdogName + " service\n",
	}
	if err := host.bootstrap("systemd").updateOlder(context.Background(), "v2.12.0", "v2.12.1-rc.3"); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{leasewatchdog.LegacyBinaryPath, "update", "--releases-url", "https://u.test/releases", "--artifact-base-url", "https://u.test/a", "--channel", "preview"},
		{"systemctl", "try-restart", leasewatchdog.LegacyUnitName},
	}
	if !reflect.DeepEqual(host.commands, want) {
		t.Fatalf("commands %q, want %q", host.commands, want)
	}

	// OpenRC, the Opfield service, no newer release published: no restart.
	host = &watchdogUpdateHost{
		files:  map[string]string{leasewatchdog.OpenRCPath: "#!/sbin/openrc-run\ncommand_args=\"run --auto-update\"\n"},
		output: "lease-watchdog is up to date\n",
	}
	if err := host.bootstrap("openrc").updateOlder(context.Background(), "v2.12.1-rc.2", "v2.12.1-rc.3"); err != nil {
		t.Fatal(err)
	}
	if want := [][]string{{leasewatchdog.BinaryPath, "update"}}; !reflect.DeepEqual(host.commands, want) {
		t.Fatalf("commands %q, want %q", host.commands, want)
	}
	host.output = "lease-watchdog updated to v2.12.1-rc.3-watchdog; restart the opfield-lease-watchdog service\n"
	host.commands = nil
	if err := host.bootstrap("openrc").updateOlder(context.Background(), "v2.12.1-rc.2", "v2.12.1-rc.3"); err != nil {
		t.Fatal(err)
	}
	if last := host.commands[len(host.commands)-1]; !reflect.DeepEqual(last, []string{"rc-service", "--ifstarted", leasewatchdog.UnitName, "restart"}) {
		t.Fatalf("restart %q", last)
	}
}

// A watchdog as new as the daemon, no watchdog, a development build, a
// service without self-update or a daemon without root: nothing runs.
func TestLeaseWatchdogUpdateOnlyForAnOlderAutoUpdatingWatchdog(t *testing.T) {
	unit := map[string]string{leasewatchdog.SystemdUnitPath: "ExecStart=" + leasewatchdog.BinaryPath + " run --auto-update\n"}
	for name, tc := range map[string]struct {
		running, daemon string
		files           map[string]string
		edit            func(*watchdogBootstrap)
	}{
		"same release":     {"v2.12.1-rc.3", "v2.12.1-rc.3", unit, nil},
		"newer watchdog":   {"v2.12.1", "v2.12.1-rc.3", unit, nil},
		"no watchdog":      {"", "v2.12.1-rc.3", unit, nil},
		"development":      {"v2.12.0", "dev", unit, func(b *watchdogBootstrap) { b.release = false }},
		"no auto-update":   {"v2.12.0", "v2.12.1", map[string]string{leasewatchdog.SystemdUnitPath: "ExecStart=" + leasewatchdog.BinaryPath + " run\n"}, nil},
		"operator service": {"v2.12.0", "v2.12.1", map[string]string{leasewatchdog.SystemdUnitPath: "ExecStart=/opt/custom/watchdog run --auto-update\n"}, nil},
		"not root":         {"v2.12.0", "v2.12.1", unit, func(b *watchdogBootstrap) { b.euid = func() int { return 1000 } }},
	} {
		t.Run(name, func(t *testing.T) {
			host := &watchdogUpdateHost{files: tc.files, output: "updated to"}
			b := host.bootstrap("systemd")
			if tc.edit != nil {
				tc.edit(b)
			}
			if err := b.updateOlder(context.Background(), tc.running, tc.daemon); err != nil {
				t.Fatal(err)
			}
			if len(host.commands) != 0 {
				t.Fatalf("ran %q", host.commands)
			}
		})
	}
}

func TestWatchdogUpdateArgsTakeTheServiceEndpoints(t *testing.T) {
	got := watchdogUpdateArgs(strings.Fields("--records-owner gw --auto-update --releases-url=https://r --artifact-base-url https://a --channel preview --update-interval 1h"))
	want := []string{"update", "--releases-url", "https://r", "--artifact-base-url", "https://a", "--channel", "preview"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args %q, want %q", got, want)
	}
}
