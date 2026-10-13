package naming

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ErrEntryConflict is returned by MoveEntries when both directories hold an entry of the same name.
var ErrEntryConflict = errors.New("both directories hold an entry of the same name")

// MoveEntries moves every entry of the directory legacy into the directory current and leaves a symlink to it under
// the old name, one entry at a time. It is for two directories that both exist and whose parent the daemon cannot
// write (a daemon running as its own user, whose /run directories the service manager creates under both names), so
// the directories themselves cannot be renamed.
//
// With RENAME_EXCHANGE neither name of an entry is ever missing: a symlink to the entry's new path is first made under
// the new path itself (it points at itself until the exchange), and the exchange swaps it with the entry in one step,
// so the old name turns into the link while the new name holds the entry. A crash between the two steps leaves that
// self-pointing link, which the next call recognises and uses. Without exchange support the entry is renamed and the
// link made right after.
//
// Entries already moved (the old name links to the new path) are skipped, so the call is idempotent.
func MoveEntries(legacy, current string) error {
	entries, err := os.ReadDir(legacy)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		source := filepath.Join(legacy, entry.Name())
		target := filepath.Join(current, entry.Name())
		if link, err := os.Readlink(source); err == nil && link == target {
			continue
		}
		if err := moveEntry(source, target); err != nil {
			return fmt.Errorf("move %s to %s: %w", source, target, err)
		}
	}
	syncDir(legacy)
	syncDir(current)
	return nil
}

func moveEntry(source, target string) error {
	if info, err := os.Lstat(target); err == nil {
		if link, linkErr := os.Readlink(target); linkErr != nil || link != target || info.Mode()&os.ModeSymlink == 0 {
			return ErrEntryConflict
		}
		// The placeholder of an exchange a crash interrupted: use it.
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err := os.Symlink(target, target); err != nil {
		return err
	}
	switch err := exchange(source, target); {
	case err == nil:
		return nil
	case errors.Is(err, errExchangeUnsupported):
		if err := os.Remove(target); err != nil {
			return err
		}
		if err := os.Rename(source, target); err != nil {
			return err
		}
		staging := source + ".opfield-link"
		_ = os.Remove(staging)
		if err := os.Symlink(target, staging); err != nil {
			return err
		}
		return os.Rename(staging, source)
	default:
		_ = os.Remove(target)
		return err
	}
}

func syncDir(path string) {
	if dir, err := os.Open(path); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
}
