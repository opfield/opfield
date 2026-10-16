package lifecycle

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/updateauth"
)

type daemonManifestVerifier func(string, updateauth.DaemonExpectation) (*updateauth.DaemonManifestPayload, error)

// SelfUpdate downloads a new binary from downloadURL, verifies its checksum,
// and atomically replaces the current binary. Restart is delegated to the
// process supervisor and is not coupled to a particular init system.
func SelfUpdate(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType string, logger *slog.Logger) error {
	if launcherManagedFromEnvironment() != "1" {
		return fmt.Errorf("self-update requires launcher supervision")
	}
	if strings.TrimSpace(expectedChecksum) == "" {
		return fmt.Errorf("missing update checksum")
	}
	if strings.TrimSpace(signedManifest) == "" {
		return fmt.Errorf("missing signed update manifest")
	}
	execPath, err := os.Executable()
	if err != nil {
		logger.Error("self-update failed to resolve executable path", "error", err)
		return fmt.Errorf("resolve executable path: %w", err)
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		logger.Error("self-update failed to resolve executable symlink", "error", err)
		return fmt.Errorf("resolve symlinks: %w", err)
	}
	stateDir := launcherStateDirFromEnvironment(execPath)
	if _, err := stageLauncherUpdate(stateDir, daemonType, execPath, Version, targetVersion, time.Now()); err != nil {
		logger.Error("self-update failed to stage rollback state", "error", err)
		return err
	}
	if err := ReplaceBinaryAtPath(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType, execPath, logger); err != nil {
		state, stateErr := readLauncherUpdateState(stateDir)
		if stateErr == nil && state != nil {
			if rollbackErr := rollbackLauncherUpdate(stateDir, state, "candidate staging failed"); rollbackErr != nil {
				logger.Error("self-update failed to restore previous binary after staging failure", "error", rollbackErr)
			}
		}
		return err
	}
	return nil
}

// ReplaceBinaryAtPath downloads and verifies a signed daemon artifact before
// atomically replacing destination. Process restart and health verification are
// deliberately left to the caller.
func ReplaceBinaryAtPath(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType, destination string, logger *slog.Logger) error {
	return replaceBinaryAtPath(
		downloadURL,
		targetVersion,
		expectedChecksum,
		signedManifest,
		daemonType,
		destination,
		logger,
		updateauth.VerifyDaemonManifest,
	)
}

func replaceBinaryAtPath(downloadURL, targetVersion, expectedChecksum, signedManifest, daemonType, destination string, logger *slog.Logger, verifyManifest daemonManifestVerifier) error {
	logger.Info("starting self-update",
		"target_version", targetVersion,
		"download_url", downloadURL,
		"arch", runtime.GOARCH,
	)

	expectedChecksum = strings.ToLower(strings.TrimSpace(expectedChecksum))
	if expectedChecksum == "" {
		logger.Error("self-update rejected missing checksum")
		return fmt.Errorf("missing update checksum")
	}
	if signedManifest == "" {
		logger.Error("self-update rejected missing signed manifest")
		return fmt.Errorf("missing signed update manifest")
	}
	updateURL, err := url.Parse(downloadURL)
	if err != nil {
		logger.Error("self-update rejected invalid download URL", "error", err)
		return fmt.Errorf("parse update download URL: %w", err)
	}
	artifactName := path.Base(updateURL.Path)
	tag := path.Base(path.Dir(updateURL.Path))
	if _, err := verifyManifest(signedManifest, updateauth.DaemonExpectation{
		DaemonType:   daemonType,
		Version:      targetVersion,
		Tag:          tag,
		Arch:         updateauth.NormalizeArch(runtime.GOARCH),
		ArtifactName: artifactName,
		DownloadURL:  downloadURL,
		SHA256:       expectedChecksum,
	}); err != nil {
		logger.Error("self-update rejected untrusted manifest", "error", err)
		return fmt.Errorf("verify signed update manifest: %w", err)
	}

	// Partial downloads of an update interrupted by a crash or power loss are never resumed.
	sweepUpdateLeftovers(filepath.Dir(destination), time.Now())
	// Download to temp file in the same directory (for atomic rename)
	tmpFile, err := os.CreateTemp(filepath.Dir(destination), ".daemon-update-*")
	if err != nil {
		logger.Error("self-update failed to create temp file", "error", err)
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		tmpFile.Close()
		os.Remove(tmpPath) // cleanup on failure; on success we already renamed
	}()

	// Download binary
	client := &http.Client{Timeout: 5 * time.Minute}
	logger.Info("downloading daemon update", "target_version", targetVersion)
	resp, err := client.Get(downloadURL)
	if err != nil {
		logger.Error("self-update download failed", "error", err)
		return fmt.Errorf("download binary: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		logger.Error("self-update download returned unexpected status", "status", resp.StatusCode)
		return fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	// Write + compute checksum simultaneously
	hasher := sha256.New()
	writer := io.MultiWriter(tmpFile, hasher)
	written, err := io.Copy(writer, io.LimitReader(resp.Body, maxDaemonArtifactBytes+1))
	if err != nil {
		logger.Error("self-update failed while writing downloaded binary", "error", err)
		return fmt.Errorf("write binary: %w", err)
	}
	if written > maxDaemonArtifactBytes {
		logger.Error("self-update download exceeds the artifact size limit", "limit_bytes", maxDaemonArtifactBytes)
		return fmt.Errorf("downloaded binary exceeds %d bytes", maxDaemonArtifactBytes)
	}
	// Verify checksum
	actualChecksum := hex.EncodeToString(hasher.Sum(nil))
	if actualChecksum != expectedChecksum {
		logger.Error("self-update checksum mismatch", "expected", expectedChecksum, "actual", actualChecksum)
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, actualChecksum)
	}
	logger.Info("self-update checksum verified", "checksum", actualChecksum)

	// Set final permissions and make both bytes and mode durable before rename.
	if err := tmpFile.Chmod(0755); err != nil {
		logger.Error("self-update failed to chmod new binary", "error", err)
		return fmt.Errorf("chmod: %w", err)
	}
	if err := tmpFile.Sync(); err != nil {
		logger.Error("self-update failed to sync new binary", "error", err)
		return fmt.Errorf("sync binary: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("close binary: %w", err)
	}
	logger.Info("daemon update downloaded", "target_version", targetVersion)

	// Atomic replace: rename temp file over the current binary
	if err := os.Rename(tmpPath, destination); err != nil {
		logger.Error("self-update failed to replace binary", "error", err, "path", destination)
		return fmt.Errorf("replace binary: %w", err)
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		logger.Error("self-update failed to sync replaced binary", "error", err, "path", destination)
		return fmt.Errorf("sync replaced binary: %w", err)
	}

	logger.Info("binary replaced successfully",
		"target_version", targetVersion,
		"path", destination,
	)

	return nil
}
