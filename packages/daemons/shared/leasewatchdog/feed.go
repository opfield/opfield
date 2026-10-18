package leasewatchdog

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/opfield/opfield/daemon-shared/legacycompat"
)

// legacy-name: legacycompat.UpdateFeedBase, the feed base of watchdog services written before 2.12.6 — remove this
// file and its callers after every install runs v2.12.6
var legacyFeedURLs = map[string]string{
	legacycompat.UpdateFeedBase + "/releases": DefaultReleasesURL,
	legacycompat.UpdateFeedBase:               DefaultArtifactBaseURL,
}

// CurrentFeedURL is value, or its Opfield counterpart when value is a default
// of the earlier feed namespace. Any other address (a mirror) is kept.
func CurrentFeedURL(value string) string {
	if current, ok := legacyFeedURLs[strings.TrimRight(strings.TrimSpace(value), "/")]; ok {
		return current
	}
	return value
}

// argsWithCurrentFeed returns the watchdog arguments with the release
// endpoints moved off the earlier feed namespace, and whether anything
// changed.
func argsWithCurrentFeed(args string) (string, bool) {
	fields := strings.Fields(args)
	changed := false
	for i := 0; i < len(fields); i++ {
		if !strings.HasPrefix(fields[i], "-") {
			continue
		}
		name, value, inline := strings.Cut(strings.TrimLeft(fields[i], "-"), "=")
		if name != "releases-url" && name != "artifact-base-url" {
			continue
		}
		if inline {
			if current := CurrentFeedURL(value); current != value {
				fields[i] = strings.TrimSuffix(fields[i], value) + current
				changed = true
			}
			continue
		}
		if i+1 < len(fields) {
			i++
			if current := CurrentFeedURL(fields[i]); current != fields[i] {
				fields[i] = current
				changed = true
			}
		}
	}
	if !changed {
		return args, false
	}
	return strings.Join(fields, " "), true
}

// MoveServiceToCurrentFeed rewrites the release endpoints of the installed
// watchdog service that still name the earlier feed namespace, so the next
// start reads the Opfield one. Only those two flag values change. It reports
// whether the service file changed; the running process needs no restart, it
// already maps the endpoints with CurrentFeedURL.
func MoveServiceToCurrentFeed(ctx context.Context, host ServiceHost) (bool, error) {
	var path, prefix, suffix string
	var mode os.FileMode
	switch {
	case host.Systemd:
		path, prefix, mode = SystemdUnitPath, "ExecStart="+BinaryPath+" ", 0o644
	case host.OpenRC:
		path, prefix, suffix, mode = OpenRCPath, `command_args="`, `"`, 0o755
	default:
		return false, nil
	}
	content, err := os.ReadFile(host.path(path))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	lines := strings.Split(string(content), "\n")
	changed := false
	for i, line := range lines {
		if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, suffix) || len(line) < len(prefix)+len(suffix) {
			continue
		}
		if updated, ok := argsWithCurrentFeed(line[len(prefix) : len(line)-len(suffix)]); ok {
			lines[i] = prefix + updated + suffix
			changed = true
		}
	}
	if !changed {
		return false, nil
	}
	if err := writeIfChanged(host.path(path), strings.Join(lines, "\n"), mode); err != nil {
		return false, err
	}
	if host.Systemd {
		if err := host.Run(ctx, "systemctl", "daemon-reload"); err != nil {
			return true, err
		}
	}
	return true, nil
}
