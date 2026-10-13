// Package hostrename moves the host directories of the pre-Opfield names
// (/var/lib/gateway, /run/gateway-lease-watchdog, /etc/gateway-builder, ...)
// to their Opfield names, and resolves which of the two a component uses now.
//
// A move renames the old directory to the new name and leaves the old name as
// a symlink to it, so a component of an older release (a 2.12.0 daemon the
// launcher rolled back to, a lease watchdog that has not updated yet, a
// customer configuration) still finds everything under the old path. Moves are
// idempotent and crash-safe: every intermediate state is recognised and
// finished by the next call. Components of this package that run at the same
// time serialise on an flock of the parent directory.
//
// Resolve picks the path to use without moving anything: the old path while it
// is still a real directory (the move has not run, or both names exist and the
// old one is what older components use), else the new path.
package hostrename

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Pair is one host path under its pre-Opfield and its Opfield name. Both must
// be absolute and share the parent directory (a rename never crosses file
// systems).
type Pair struct {
	Old string
	New string
}

// Host paths shared by more than one component.
var (
	// StateRoot holds the host identity shared by every daemon of a host
	// (host-identity) and the cloud-init hosting markers.
	StateRoot = Pair{Old: "/var/lib/gateway", New: "/var/lib/opfield"}
)

// HostIdentity is the identity file inside StateRoot.
const HostIdentityName = "host-identity"

// Outcome is what Move found or did.
type Outcome int

const (
	// Absent: neither name exists; nothing to move.
	Absent Outcome = iota
	// Moved: the directory is under the new name now, the old name links to it.
	Moved
	// Done: it already was.
	Done
	// Conflict: both names hold different, non-empty directories (or the old
	// name is something else than a directory). Nothing was changed; the old
	// one stays in use (Resolve returns it) and the conflict is reported as a
	// legacy name.
	Conflict
)

func (o Outcome) String() string {
	switch o {
	case Absent:
		return "absent"
	case Moved:
		return "moved"
	case Done:
		return "done"
	default:
		return "conflict"
	}
}

// exchangeFn is exchange; tests replace it to cover file systems without it.
var exchangeFn = exchange

// ErrConflict is returned with Conflict.
var ErrConflict = errors.New("both the old and the new host directory exist")

func (p Pair) validate() error {
	if !filepath.IsAbs(p.Old) || !filepath.IsAbs(p.New) || filepath.Dir(p.Old) != filepath.Dir(p.New) || p.Old == p.New {
		return fmt.Errorf("invalid host rename %q -> %q", p.Old, p.New)
	}
	return nil
}

// linkTarget is what the old name points at: the new name relative to the
// shared parent.
func (p Pair) linkTarget() string { return filepath.Base(p.New) }

// stagingPath is where a move keeps its link (and, between the two renames of
// an exchange, the directory itself).
func (p Pair) stagingPath() string {
	return filepath.Join(filepath.Dir(p.Old), "."+filepath.Base(p.Old)+".opfield-move")
}

// Join returns the path of name inside the directory Resolve picks.
func (p Pair) Join(name string) string { return filepath.Join(Resolve(p), name) }

// Resolve returns the path a component uses now: Old while it is a real
// directory (or any other non-symlink entry), else New. It never changes
// anything.
func Resolve(p Pair) string {
	if info, err := os.Lstat(p.Old); err == nil && info.Mode()&os.ModeSymlink == 0 {
		return p.Old
	}
	return p.New
}

// Legacy reports whether the old name is still a real directory: the move has
// not happened (or hit a conflict). A daemon reports these.
func Legacy(p Pair) bool {
	info, err := os.Lstat(p.Old)
	return err == nil && info.Mode()&os.ModeSymlink == 0
}

// Move moves p.Old to p.New and leaves p.Old as a symlink to it. It finishes a
// move a crash interrupted. See Outcome for the results.
func Move(p Pair) (Outcome, error) {
	if err := p.validate(); err != nil {
		return Conflict, err
	}
	unlock, err := lockParent(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Absent, nil
		}
		return Conflict, err
	}
	defer unlock()
	return moveLocked(p, false, 0)
}

// EnsureRunDir makes the directory exist for a tmpfs path pair (under /run,
// recreated at every boot by whichever component starts first, possibly an
// older one that only knows the old name) and returns the path to use. When
// neither exists it creates the new one (mode, owner unchanged) and links the
// old name to it; when only an older component created the old one, it is
// moved like Move does, so every component of either release meets in one
// directory.
func EnsureRunDir(p Pair, mode os.FileMode) (string, error) {
	if err := p.validate(); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p.New), 0o755); err != nil {
		return "", err
	}
	unlock, err := lockParent(p)
	if err != nil {
		return "", err
	}
	defer unlock()
	if _, err := moveLocked(p, true, mode); err != nil && !errors.Is(err, ErrConflict) {
		return "", err
	}
	return Resolve(p), nil
}

// moveLocked runs with the parent locked. create makes the new directory when
// neither name exists.
func moveLocked(p Pair, create bool, mode os.FileMode) (Outcome, error) {
	staging := p.stagingPath()
	moved := false
	// A few rounds: each one either finishes or makes progress (an older
	// component may create the old name between two steps).
	for round := 0; round < 6; round++ {
		oldInfo, oldErr := os.Lstat(p.Old)
		newInfo, newErr := os.Lstat(p.New)
		stagingInfo, stagingErr := os.Lstat(staging)
		if oldErr != nil && !errors.Is(oldErr, os.ErrNotExist) {
			return Conflict, oldErr
		}
		if newErr != nil && !errors.Is(newErr, os.ErrNotExist) {
			return Conflict, newErr
		}
		oldExists, newExists := oldErr == nil, newErr == nil
		// A crash between the two renames of an exchange left the directory
		// under the staging name and the old name as a (dangling) link to the
		// new one: finish the move first.
		if stagingErr == nil && stagingInfo.IsDir() && stagingInfo.Mode()&os.ModeSymlink == 0 {
			if !newExists {
				if err := os.Rename(staging, p.New); err != nil {
					return Conflict, fmt.Errorf("finish interrupted move of %s: %w", p.Old, err)
				}
				syncDir(filepath.Dir(p.New))
				moved = true
				continue
			}
			// Both the staged directory and the new one exist: keep the new one
			// when the staged one is empty, else leave both for the operator.
			if empty, _ := dirEmpty(staging); empty {
				_ = os.Remove(staging)
				continue
			}
			return Conflict, fmt.Errorf("%w: %s and %s", ErrConflict, staging, p.New)
		}
		if stagingErr == nil {
			// A stale link from an interrupted fallback move.
			_ = os.Remove(staging)
		}
		switch {
		case !oldExists && !newExists:
			if !create {
				return Absent, nil
			}
			if err := os.Mkdir(p.New, mode); err != nil && !errors.Is(err, os.ErrExist) {
				return Conflict, err
			}
			if err := os.Chmod(p.New, mode); err != nil {
				return Conflict, err
			}
			continue
		case !oldExists && newExists:
			// New in place: (re)create the old name as a link to it.
			if err := placeLink(p, staging); err != nil {
				if errors.Is(err, os.ErrExist) || errors.Is(err, syscall.EISDIR) || errors.Is(err, syscall.ENOTEMPTY) {
					continue // an older component created the old name meanwhile
				}
				return Conflict, err
			}
			if moved {
				return Moved, nil
			}
			return Done, nil
		case oldInfo.Mode()&os.ModeSymlink != 0:
			if !newExists {
				// The old name links somewhere the new one does not exist:
				// either the first half of an exchange whose staged directory
				// is gone, or something we did not make. Leave it.
				if target, _ := os.Readlink(p.Old); target == p.linkTarget() || target == p.New {
					return Conflict, fmt.Errorf("%s links to the missing %s", p.Old, p.New)
				}
				return Absent, nil
			}
			if sameFile(p.Old, p.New) {
				if newInfo.Mode()&os.ModeSymlink != 0 {
					// Each name links to the other or both to a third place:
					// not ours to fix.
					return Conflict, fmt.Errorf("%w: %s and %s are both links", ErrConflict, p.Old, p.New)
				}
				if moved {
					return Moved, nil
				}
				return Done, nil
			}
			return Conflict, fmt.Errorf("%w: %s links elsewhere than %s", ErrConflict, p.Old, p.New)
		case !oldInfo.IsDir():
			return Conflict, fmt.Errorf("%w: %s is not a directory", ErrConflict, p.Old)
		case !newExists:
			if err := renameWithLink(p, staging); err != nil {
				return Conflict, err
			}
			moved = true
			continue
		case newInfo.Mode()&os.ModeSymlink != 0:
			// The new name links to the old directory (a component chose the
			// other direction): drop that link, the move puts the directory
			// there.
			if !sameFile(p.New, p.Old) {
				return Conflict, fmt.Errorf("%w: %s links elsewhere than %s", ErrConflict, p.New, p.Old)
			}
			if err := os.Remove(p.New); err != nil {
				return Conflict, err
			}
			continue
		default:
			// Two real directories. The empty one is a leftover of a component
			// that created its name while the other one already held the data.
			if empty, _ := dirEmpty(p.New); empty {
				if err := os.Remove(p.New); err != nil && !errors.Is(err, os.ErrNotExist) {
					return Conflict, err
				}
				continue
			}
			if empty, _ := dirEmpty(p.Old); empty {
				if err := os.Remove(p.Old); err != nil && !errors.Is(err, os.ErrNotExist) {
					return Conflict, err
				}
				continue
			}
			return Conflict, fmt.Errorf("%w: %s and %s", ErrConflict, p.Old, p.New)
		}
	}
	return Conflict, fmt.Errorf("move of %s did not settle", p.Old)
}

// renameWithLink moves the directory at p.Old to p.New and leaves p.Old as a
// link. With RENAME_EXCHANGE the old name is never missing: it turns into the
// link (dangling for an instant) in one step, so an older component that
// creates its directory when it is missing cannot create a second one. File
// systems without exchange get a plain rename and the link right after.
func renameWithLink(p Pair, staging string) error {
	_ = os.Remove(staging)
	if err := os.Symlink(p.linkTarget(), staging); err != nil {
		return err
	}
	switch err := exchangeFn(staging, p.Old); {
	case err == nil:
		// staging is the directory now, p.Old the link.
		syncDir(filepath.Dir(p.Old))
		if err := os.Rename(staging, p.New); err != nil {
			return fmt.Errorf("move %s to %s: %w", p.Old, p.New, err)
		}
		syncDir(filepath.Dir(p.New))
		return nil
	case errors.Is(err, errExchangeUnsupported):
		_ = os.Remove(staging)
		if err := os.Rename(p.Old, p.New); err != nil {
			return fmt.Errorf("move %s to %s: %w", p.Old, p.New, err)
		}
		syncDir(filepath.Dir(p.New))
		return placeLink(p, staging)
	default:
		_ = os.Remove(staging)
		return err
	}
}

// placeLink creates p.Old as a link to p.New without a moment where p.Old is a
// half-written entry: the link is made under the staging name and renamed.
func placeLink(p Pair, staging string) error {
	_ = os.Remove(staging)
	if err := os.Symlink(p.linkTarget(), staging); err != nil {
		return err
	}
	if _, err := os.Lstat(p.Old); err == nil {
		_ = os.Remove(staging)
		return os.ErrExist
	}
	if err := os.Rename(staging, p.Old); err != nil {
		_ = os.Remove(staging)
		return err
	}
	syncDir(filepath.Dir(p.Old))
	return nil
}

func sameFile(a, b string) bool {
	left, err := os.Stat(a)
	if err != nil {
		return false
	}
	right, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(left, right)
}

func dirEmpty(path string) (bool, error) {
	dir, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer dir.Close()
	_, err = dir.Readdirnames(1)
	if errors.Is(err, io.EOF) {
		return true, nil
	}
	return false, err
}

func syncDir(path string) {
	if dir, err := os.Open(path); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
}

// lockParent serialises the components of this package that rename names in
// the same parent directory (an flock on the directory itself: no lock file).
func lockParent(p Pair) (func(), error) {
	dir, err := os.Open(filepath.Dir(p.New))
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(dir.Fd()), syscall.LOCK_EX); err != nil {
		dir.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(dir.Fd()), syscall.LOCK_UN)
		_ = dir.Close()
	}, nil
}

// WithLock runs fn while the parent of p is locked against moves, for a
// component that creates a file under Resolve(p) and must not race a move (a
// first host identity).
func WithLock(p Pair, fn func() error) error {
	if err := p.validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p.New), 0o755); err != nil {
		return err
	}
	unlock, err := lockParent(p)
	if err != nil {
		return err
	}
	defer unlock()
	return fn()
}

// IsOldName reports whether path is p.Old or below it.
func (p Pair) IsOldName(path string) bool {
	path = filepath.Clean(path)
	return path == p.Old || strings.HasPrefix(path, p.Old+string(filepath.Separator))
}

// ToNew maps a path under p.Old to the same path under p.New (unchanged
// otherwise).
func (p Pair) ToNew(path string) string {
	if !p.IsOldName(path) {
		return path
	}
	return p.New + strings.TrimPrefix(filepath.Clean(path), p.Old)
}
