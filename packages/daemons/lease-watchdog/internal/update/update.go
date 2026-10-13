// Package update keeps the lease watchdog current on its own release line
// (tags vX.Y.Z-watchdog, component "lease-watchdog"), independently of the
// docker daemon version (A12.5). Release resolution and manifest
// verification are shared with the docker daemon's bootstrap of a missing
// watchdog (daemon-shared/leasewatchdog).
package update

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasewatchdog"
)

const (
	Component              = leasewatchdog.Component
	DaemonType             = leasewatchdog.DaemonType
	DefaultReleasesURL     = leasewatchdog.DefaultReleasesURL
	DefaultArtifactBaseURL = leasewatchdog.DefaultArtifactBaseURL
)

// ReplaceFunc downloads, verifies and atomically writes the artifact to
// destination; lifecycle.ReplaceBinaryAtPath in production.
type ReplaceFunc func(downloadURL, version, sha256, manifest, daemonType, destination string, logger *slog.Logger) error

type Config struct {
	ReleasesURL     string
	ArtifactBaseURL string
	Channel         string
	Current         string
	Executable      string
	HTTP            *http.Client
	Replace         ReplaceFunc
	// SelfTest runs the staged binary before it replaces the running one.
	SelfTest func(ctx context.Context, path string) error
	Logger   *slog.Logger
}

// Result says whether a new binary was installed; the caller then exits so
// the supervisor restarts the watchdog. Records on tmpfs survive the restart.
type Result struct {
	Updated bool
	Tag     string
}

// Check asks the update service for the next watchdog release and installs it.
func Check(ctx context.Context, cfg Config) (Result, error) {
	if cfg.Replace == nil || cfg.SelfTest == nil || cfg.Executable == "" {
		return Result{}, errors.New("watchdog update is not configured")
	}
	if !strings.HasPrefix(cfg.Current, "v") {
		// Development builds are never replaced by release artifacts.
		return Result{}, nil
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: time.Minute}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	tag, err := leasewatchdog.NextTag(ctx, cfg.HTTP, cfg.ReleasesURL, cfg.Channel, cfg.Current)
	if err != nil || tag == "" {
		return Result{}, err
	}
	manifest, payload, err := leasewatchdog.FetchManifest(ctx, cfg.HTTP, cfg.ArtifactBaseURL, tag)
	if err != nil {
		return Result{}, err
	}
	staged := cfg.Executable + ".next"
	defer os.Remove(staged)
	if err := cfg.Replace(payload.DownloadURL, payload.Version, payload.SHA256, manifest, DaemonType, staged, cfg.Logger); err != nil {
		return Result{}, err
	}
	testCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := cfg.SelfTest(testCtx, staged); err != nil {
		return Result{}, fmt.Errorf("staged watchdog %s failed its self-test: %w", tag, err)
	}
	previous := cfg.Executable + ".previous"
	if err := os.Link(cfg.Executable, previous+".tmp"); err == nil {
		_ = os.Rename(previous+".tmp", previous)
	}
	if err := os.Rename(staged, cfg.Executable); err != nil {
		return Result{}, fmt.Errorf("install watchdog %s: %w", tag, err)
	}
	return Result{Updated: true, Tag: tag}, nil
}
