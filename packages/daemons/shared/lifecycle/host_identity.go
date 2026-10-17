package lifecycle

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"github.com/opfield/opfield/daemon-shared/hostrename"
)

// loadOrCreateHostIdentity reads the host identity at path (see
// HostIdentityPathFor for the default), creating it when no daemon of the
// host has one yet.
func loadOrCreateHostIdentity(path string) (string, error) {
	if !isDefaultHostIdentityPath(path) {
		if identity, found, err := readHostIdentity(path); found || err != nil {
			return identity, err
		}
		return createHostIdentity(path)
	}
	if identity, found, err := readHostIdentity(HostIdentityPathFor(path)); found || err != nil {
		return identity, err
	}
	// The shared identity seems missing: look again under both names while
	// holding the lock a move of the directory takes, so a move in progress
	// cannot make it look missing. A second identity would turn this host
	// into a new one for Opfield.
	var identity string
	err := hostrename.WithLock(hostrename.StateRoot, func() error {
		for _, candidate := range []string{
			hostrename.StateRoot.New + "/" + hostrename.HostIdentityName,
			// legacy-name: legacycompat.StateRoot/host-identity until the shared state directory moved — remove once every node reports none
			hostrename.StateRoot.Old + "/" + hostrename.HostIdentityName,
		} {
			found, ok, err := readHostIdentity(candidate)
			if err != nil {
				return err
			}
			if ok {
				identity = found
				return nil
			}
		}
		created, err := createHostIdentity(HostIdentityPathFor(path))
		identity = created
		return err
	})
	return identity, err
}

func readHostIdentity(path string) (string, bool, error) {
	encoded, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read host identity: %w", err)
	}
	identity := strings.TrimSpace(string(encoded))
	if _, parseErr := uuid.Parse(identity); parseErr != nil {
		return "", false, fmt.Errorf("invalid persisted host identity: %w", parseErr)
	}
	return identity, true, nil
}

func createHostIdentity(path string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create host identity directory: %w", err)
	}
	identity := uuid.NewString()
	file, err := os.CreateTemp(filepath.Dir(path), ".host-identity-*")
	if err != nil {
		return "", fmt.Errorf("create host identity: %w", err)
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err := file.WriteString(identity + "\n"); err != nil {
		file.Close()
		return "", fmt.Errorf("write host identity: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close host identity: %w", err)
	}
	// Publish complete contents without replacing a concurrent daemon's identity.
	if err := os.Link(temporary, path); err != nil {
		if existing, found, readErr := readHostIdentity(path); readErr == nil && found {
			return existing, nil
		}
		return "", fmt.Errorf("persist host identity: %w", err)
	}
	return identity, nil
}
