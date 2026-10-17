// Package leasewatchdog holds what installs and updates the independent lease
// watchdog (A12.5): its install paths, the service definitions and the
// signed release resolution. The node installer (scripts/setup-docker-node.sh)
// is the source of truth for the paths and service files; a test keeps this
// package identical to it. The watchdog's own self-update and the docker
// daemon's bootstrap of a missing watchdog both use it.
package leasewatchdog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/opfield/opfield/daemon-shared/updateauth"
)

const (
	// BinaryPath and UnitName match LEASE_WATCHDOG_BIN / LEASE_WATCHDOG_UNIT.
	BinaryPath = "/usr/local/bin/opfield-lease-watchdog"
	UnitName   = "opfield-lease-watchdog"
	// SystemdUnitPath and OpenRCPath are where the installer writes them.
	SystemdUnitPath = "/etc/systemd/system/" + UnitName + ".service"
	OpenRCPath      = "/etc/init.d/" + UnitName

	// The pre-Opfield service. The watchdog moves itself to UnitName
	// (MigrateLegacyService); while the old unit is installed (a node not
	// migrated yet, or an older installer restored it) the new one does not
	// start, so two watchdogs never run.
	// legacy-name: legacycompat.LeaseWatchdogName service and binary of pre-Opfield nodes — remove once every node reports none
	LegacyBinaryPath      = "/usr/local/bin/" + legacycompat.LeaseWatchdogName
	LegacyUnitName        = legacycompat.LeaseWatchdogName
	LegacySystemdUnitPath = "/etc/systemd/system/" + LegacyUnitName + ".service"
	LegacyOpenRCPath      = "/etc/init.d/" + LegacyUnitName

	// Component is the update-service package; DaemonType the signed
	// manifest daemonType of its artifacts (tags vX.Y.Z-watchdog).
	Component  = "lease-watchdog"
	DaemonType = "watchdog"

	DefaultReleasesURL     = legacycompat.UpdateFeedBase + "/releases"
	DefaultArtifactBaseURL = legacycompat.UpdateFeedBase

	maxResponseBytes = 64 * 1024
)

// RunArgs is the watchdog command line of the service (installer "args"), with the release channel it updates on: the
// docker daemon's.
func RunArgs(recordsOwner, releasesURL, artifactBaseURL, channel string) string {
	return fmt.Sprintf("run --records-owner %s --auto-update --releases-url %s --artifact-base-url %s --channel %s",
		recordsOwner, releasesURL, artifactBaseURL, channel)
}

// SystemdUnit is the installer's systemd unit for binary and args.
func SystemdUnit(binary, args string) string {
	return `[Unit]
Description=Opfield Availability Lease Watchdog
# Deliberately independent of docker-daemon and docker: it must keep
# enforcing lease deadlines when either one is stopped, hung or removed.
After=local-fs.target
# Never next to the pre-Opfield unit of the same watchdog: that one runs
# while it is installed and moves the node to this unit.
ConditionPathExists=!` + LegacySystemdUnitPath + `

[Service]
Type=simple
User=root
ExecStart=` + binary + ` ` + args + `
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`
}

// OpenRCScript is the installer's OpenRC service for binary and args.
func OpenRCScript(binary, args string) string {
	return `#!/sbin/openrc-run
name="Opfield Availability Lease Watchdog"
command="` + binary + `"
command_args="` + args + `"
pidfile="/run/${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=1
output_log="/var/log/` + UnitName + `.log"
error_log="/var/log/` + UnitName + `.err"

depend() {
    need localmount
}

start_pre() {
    # Never next to the pre-Opfield service of the same watchdog: that one runs
    # while it is installed and moves the node to this service.
    if [ -e ` + LegacyOpenRCPath + ` ]; then
        eerror "` + LegacyUnitName + ` is installed and runs instead"
        return 1
    fi
}
`
}

// ArtifactName is the release asset for this architecture.
func ArtifactName() string {
	return "lease-watchdog-linux-" + updateauth.NormalizeArch(runtime.GOARCH)
}

// NextTag asks the update service for the watchdog release to install after
// current ("" for a first install: the latest on the channel). An empty tag
// means no update.
//
// The signature of a release proves only that it was built by us, not which
// one to run: the watchdog installs on its own as root, so it takes a tag only
// if it is newer than current, and never a release candidate on the stable
// channel. A compromised update service cannot make it downgrade or leave the
// stable line.
func NextTag(ctx context.Context, client *http.Client, releasesURL, channel, current string) (string, error) {
	channel = orDefault(channel, "stable")
	endpoint, err := url.Parse(orDefault(releasesURL, DefaultReleasesURL))
	if err != nil {
		return "", err
	}
	query := endpoint.Query()
	query.Set("component", Component)
	if current != "" {
		query.Set("current", current)
	}
	query.Set("channel", channel)
	endpoint.RawQuery = query.Encode()
	body, status, err := get(ctx, client, endpoint.String())
	if err != nil {
		return "", err
	}
	switch status {
	case http.StatusNoContent:
		return "", nil
	case http.StatusOK:
	default:
		return "", fmt.Errorf("update service returned status %d", status)
	}
	var next struct {
		Target struct {
			TagName string `json:"tag_name"`
		} `json:"target"`
	}
	if err := json.Unmarshal(body, &next); err != nil {
		return "", fmt.Errorf("decode update service response: %w", err)
	}
	tag := next.Target.TagName
	if !strings.HasSuffix(tag, "-"+DaemonType) || (current != "" && tag == current+"-"+DaemonType) {
		return "", nil
	}
	offered, ok := parseReleaseVersion(strings.TrimSuffix(tag, "-"+DaemonType))
	if !ok {
		return "", fmt.Errorf("update service offered %q, which is not a release tag", tag)
	}
	if channel == "stable" && offered.candidate {
		return "", fmt.Errorf("update service offered release candidate %s on the stable channel", tag)
	}
	if current == "" {
		return tag, nil
	}
	running, ok := parseReleaseVersion(current)
	if !ok {
		// Not a release build: never replaced by a release artifact.
		return "", nil
	}
	if !offered.newerThan(running) {
		return "", fmt.Errorf("update service offered %s, which is not newer than the running %s", tag, current)
	}
	return tag, nil
}

var releaseVersionPattern = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$`)

// releaseVersion is vX.Y.Z or the release candidate vX.Y.Z-rc.N, which comes
// before vX.Y.Z.
type releaseVersion struct {
	parts     [4]uint64
	candidate bool
}

func parseReleaseVersion(value string) (releaseVersion, bool) {
	match := releaseVersionPattern.FindStringSubmatch(value)
	if match == nil {
		return releaseVersion{}, false
	}
	var version releaseVersion
	for i, part := range match[1:] {
		if part == "" {
			continue
		}
		number, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return releaseVersion{}, false
		}
		version.parts[i] = number
	}
	version.candidate = match[4] != ""
	return version, true
}

func (v releaseVersion) newerThan(other releaseVersion) bool {
	for i := 0; i < 3; i++ {
		if v.parts[i] != other.parts[i] {
			return v.parts[i] > other.parts[i]
		}
	}
	if v.candidate != other.candidate {
		return other.candidate
	}
	return v.parts[3] > other.parts[3]
}

// FetchManifest downloads and verifies the signed update manifest of tag
// against the embedded update trust anchor. Nothing is downloaded or
// installed unless it verifies and names this component's artifact.
func FetchManifest(ctx context.Context, client *http.Client, artifactBaseURL, tag string) (string, *updateauth.DaemonManifestPayload, error) {
	artifact := ArtifactName()
	base := strings.TrimRight(orDefault(artifactBaseURL, DefaultArtifactBaseURL), "/")
	manifestURL := fmt.Sprintf("%s/%s/%s/%s.update.json", base, Component, url.PathEscape(tag), artifact)
	body, status, err := get(ctx, client, manifestURL)
	if err != nil {
		return "", nil, fmt.Errorf("fetch watchdog update manifest: %w", err)
	}
	if status != http.StatusOK {
		return "", nil, fmt.Errorf("fetch watchdog update manifest: status %d", status)
	}
	manifest := string(body)
	payload, err := updateauth.VerifyEnvelope[updateauth.DaemonManifestPayload](manifest)
	if err != nil {
		return "", nil, fmt.Errorf("verify watchdog update manifest: %w", err)
	}
	if payload.DaemonType != DaemonType || payload.Tag != tag || payload.ArtifactName != artifact {
		return "", nil, errors.New("watchdog update manifest does not describe the requested artifact")
	}
	return manifest, payload, nil
}

func get(ctx context.Context, client *http.Client, target string) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, 0, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	return body, response.StatusCode, err
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// Older reports whether the watchdog release watchdog (its build, as its
// heartbeat names it) comes before the daemon release daemon. Builds that are
// no release (development builds) are never older.
func Older(watchdog, daemon string) bool {
	running, ok := parseReleaseVersion(strings.TrimSuffix(watchdog, "-"+DaemonType))
	if !ok {
		return false
	}
	current, ok := parseReleaseVersion(daemon)
	return ok && current.newerThan(running)
}
