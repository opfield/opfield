package supervisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/updateauth"
)

const (
	// witnessArtifactMaxBytes bounds a witness download.
	witnessArtifactMaxBytes = 1 << 30
	// witnessArtifactRetention keeps an artifact no witness uses for 7 days
	// (a rollback or a re-placement may need it again).
	witnessArtifactRetention = 7 * 24 * time.Hour
)

// witnessFetcher fetches witness artifacts on demand into
// artifacts/<sha256>: the signed manifest (kind witness-binary, compiled
// update key) must name the artifact, and the download must match its
// sha256. Nothing is preinstalled.
type witnessFetcher struct {
	dir    string
	client *http.Client
	arch   string
	verify func(manifest string, expected updateauth.WitnessExpectation) error

	mu       sync.Mutex
	verified map[string]bool
}

func newWitnessFetcher(dir string) *witnessFetcher {
	return &witnessFetcher{
		dir: dir, client: &http.Client{Timeout: 10 * time.Minute}, arch: updateauth.NormalizeArch(""),
		verify: func(manifest string, expected updateauth.WitnessExpectation) error {
			_, err := updateauth.VerifyWitnessManifest(manifest, expected)
			return err
		},
		verified: map[string]bool{},
	}
}

func (f *witnessFetcher) fetch(ctx context.Context, artifact *pb.WitnessArtifact) (string, error) {
	sha := artifact.GetSha256()
	if !validSHA256(sha) {
		return "", errors.New("artifact sha256 is invalid")
	}
	// The manifest is checked every time, also for an artifact already on
	// disk: a spec cannot reuse a binary under another name.
	if err := f.verify(artifact.GetSignedManifest(), updateauth.WitnessExpectation{
		Component: artifact.GetComponent(), Version: artifact.GetVersion(), Arch: f.arch,
		DownloadURL: artifact.GetDownloadUrl(), SHA256: sha,
	}); err != nil {
		return "", err
	}
	path := filepath.Join(f.dir, sha)
	f.mu.Lock()
	known := f.verified[sha]
	f.mu.Unlock()
	if _, err := os.Stat(path); err == nil {
		if known {
			return path, nil
		}
		if sum, err := fileSHA256(path); err == nil && sum == sha {
			f.markVerified(sha)
			return path, nil
		}
		_ = os.Remove(path)
	}
	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		return "", err
	}
	_ = os.Chmod(f.dir, 0o755)
	if err := f.download(ctx, artifact.GetDownloadUrl(), path, sha); err != nil {
		return "", err
	}
	f.markVerified(sha)
	return path, nil
}

func (f *witnessFetcher) markVerified(sha string) {
	f.mu.Lock()
	f.verified[sha] = true
	f.mu.Unlock()
}

func (f *witnessFetcher) download(ctx context.Context, url, path, sha string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := f.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, response.StatusCode)
	}
	temporary, err := os.CreateTemp(f.dir, ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(response.Body, witnessArtifactMaxBytes+1))
	if err == nil && written > witnessArtifactMaxBytes {
		err = errors.New("artifact is too large")
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if sum := hex.EncodeToString(hash.Sum(nil)); sum != sha {
		return fmt.Errorf("artifact sha256 %s does not match the signed %s", sum, sha)
	}
	if err := os.Chmod(temporary.Name(), 0o755); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// collect removes artifacts no witness uses that were last used more than
// witnessArtifactRetention ago. Artifacts in use are touched, so their
// modification time is their last use.
func (f *witnessFetcher) collect(keep map[string]bool, now time.Time) {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(f.dir, name)
		if strings.HasPrefix(name, ".download-") {
			if info, err := entry.Info(); err == nil && now.Sub(info.ModTime()) > time.Hour {
				_ = os.Remove(path)
			}
			continue
		}
		if keep[name] {
			_ = os.Chtimes(path, now, now)
			continue
		}
		if info, err := entry.Info(); err == nil && now.Sub(info.ModTime()) > witnessArtifactRetention {
			_ = os.Remove(path)
			f.mu.Lock()
			delete(f.verified, name)
			f.mu.Unlock()
		}
	}
}
