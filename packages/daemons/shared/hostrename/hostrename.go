// Package hostrename moves the host directories of the pre-Opfield names
// (state root, lease fence, builder directories, ...; see legacycompat)
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
	// Conflict: both names hold non-empty directories that do not merge
	// (an entry of the same name in both, see mergeNewEntries), or the old
	// name is something else than a directory. Nothing was changed; the old
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
// move a crash interrupted. See Outcome for the results. A directory found
// only under its new name gets no old name (a host installed with the Opfield
// names), unless a move of this package left it there.
func Move(p Pair) (Outcome, error) {
	return MoveLinked(p, false)
}

// MoveLinked is Move for a caller that knows its node had the old names: a
// directory found only under its new name gets the old name as a link too (a
// move an older release interrupted after its rename).
func MoveLinked(p Pair, linkOld bool) (Outcome, error) {
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
	return moveLocked(p, false, 0, linkOld)
}

// hadLegacyNames reports whether this host ran components under the
// pre-Opfield names: the shared state root exists under its old name (a
// directory, or the link a move left). A host installed with 2.12.1 or later
// has none (replaceable in tests).
var hadLegacyNames = func() bool {
	_, err := os.Lstat(StateRoot.Old)
	return err == nil
}

// EnsureRunDir makes the directory exist for a tmpfs path pair (under /run,
// recreated at every boot by whichever component starts first, possibly an
// older one that only knows the old name) and returns the path to use. When
// neither exists it creates the new one (mode, owner unchanged) and, on a host
// that ran components under the pre-Opfield names, links the old name to it;
// when only an older component created the old one, it is moved like Move
// does, so every component of either release meets in one directory. A host
// installed with the Opfield names gets no old name.
func EnsureRunDir(p Pair, mode os.FileMode) (string, error) {
	return EnsureRunDirLinked(p, mode, hadLegacyNames())
}

// EnsureRunDirLinked is EnsureRunDir with the caller deciding whether a new
// directory gets the old name as a link (a component that knows its node had
// the old names).
func EnsureRunDirLinked(p Pair, mode os.FileMode, linkOld bool) (string, error) {
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
	if _, err := moveLocked(p, true, mode, linkOld); err != nil && !errors.Is(err, ErrConflict) {
		return "", err
	}
	return Resolve(p), nil
}

// moveLocked runs with the parent locked. create makes the new directory when
// neither name exists, and linkOld links the old name to a directory it
// created. Otherwise the old name becomes a link only when a move put the
// directory under the new name (this call, or one a crash interrupted, which
// left its link under the staging name): a host that never had the old name
// does not get it.
func moveLocked(p Pair, create bool, mode os.FileMode, linkOld bool) (Outcome, error) {
	staging := p.stagingPath()
	moved := false
	linkDue := false
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
			// The link of an interrupted move. Once the directory is under
			// the new name the move only lacks the old name's link.
			if !oldExists && newExists {
				linkDue = true
			}
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
			create = false
			continue
		case !oldExists && newExists:
			if !moved && !linkDue && !linkOld {
				// Only the new name, and no move of ours put it there: a host
				// installed with the Opfield names.
				return Done, nil
			}
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
				// The old name existed: it stays, as the link.
				linkDue = true
				continue
			}
			// A component of the new release created entries under the new
			// name first (the app's host move binds
			// /var/lib/opfield/sandbox-workspaces on a host whose node daemon
			// still has /var/lib/gateway): carry them into the old directory,
			// which then moves as a whole. Two entries of the same name are a
			// conflict unless they merge (see mergeNewEntries); then nothing
			// changes.
			if err := mergeNewEntries(p, false); err != nil {
				return Conflict, err
			}
			if err := mergeNewEntries(p, true); err != nil {
				return Conflict, err
			}
			continue
		}
	}
	return Conflict, fmt.Errorf("move of %s did not settle", p.Old)
}

// mergeStep runs before every change a merge makes; tests stop a merge there
// to cover each state a crash can leave.
var mergeStep = func() error { return nil }

// mergeNewEntries carries every entry of the new directory into the old one,
// which the move renames to the new name afterwards. It only renames whole
// entries and never empties a directory of the new side that something may
// use (a bind mount source of a running container keeps its inode):
//   - an entry the old directory lacks is renamed into it;
//   - an entry the old directory has as an empty directory replaces it;
//   - a directory both have: the old one's entries move into the new one
//     (recursively, by the same rules, files of the same name are a
//     conflict), the emptied old one is removed and the new one renamed in.
//
// With apply false it only checks that the merge can finish and changes
// nothing; a conflict leaves both directories as they are. Every step is one
// rename or one removal of an empty directory, so a crash leaves a state the
// next call finishes the same way.
func mergeNewEntries(p Pair, apply bool) error {
	entries, err := os.ReadDir(p.New)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		newPath := filepath.Join(p.New, entry.Name())
		oldPath := filepath.Join(p.Old, entry.Name())
		newInfo, err := os.Lstat(newPath)
		if err != nil {
			return err
		}
		oldInfo, err := os.Lstat(oldPath)
		switch {
		case errors.Is(err, os.ErrNotExist):
		case err != nil:
			return err
		case isRealDir(oldInfo) && isRealDir(newInfo):
			if err := mergeDirInto(oldPath, newPath, apply); err != nil {
				return err
			}
			if err := removeEmpty(oldPath, apply); err != nil {
				return err
			}
		case isRealDir(oldInfo):
			if empty, _ := dirEmpty(oldPath); !empty {
				return fmt.Errorf("%w: %s and %s", ErrConflict, oldPath, newPath)
			}
			if err := removeEmpty(oldPath, apply); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%w: %s and %s", ErrConflict, oldPath, newPath)
		}
		if apply {
			if err := mergeStep(); err != nil {
				return err
			}
			if err := renameNoReplace(newPath, oldPath); err != nil {
				return fmt.Errorf("move %s into %s: %w", newPath, p.Old, err)
			}
		}
	}
	if apply {
		syncDir(p.New)
		syncDir(p.Old)
	}
	return nil
}

// mergeDirInto moves the entries of the directory src into the directory dst
// (see mergeNewEntries); src is left empty.
func mergeDirInto(src, dst string, apply bool) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		from := filepath.Join(src, entry.Name())
		to := filepath.Join(dst, entry.Name())
		fromInfo, err := os.Lstat(from)
		if err != nil {
			return err
		}
		toInfo, err := os.Lstat(to)
		switch {
		case errors.Is(err, os.ErrNotExist):
			if apply {
				if err := mergeStep(); err != nil {
					return err
				}
				if err := renameNoReplace(from, to); err != nil {
					return fmt.Errorf("move %s to %s: %w", from, to, err)
				}
			}
		case err != nil:
			return err
		case isRealDir(fromInfo) && isRealDir(toInfo):
			if err := mergeDirInto(from, to, apply); err != nil {
				return err
			}
			if err := removeEmpty(from, apply); err != nil {
				return err
			}
		case isRealDir(fromInfo):
			if empty, _ := dirEmpty(from); !empty {
				return fmt.Errorf("%w: %s and %s", ErrConflict, from, to)
			}
			if err := removeEmpty(from, apply); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%w: %s and %s", ErrConflict, from, to)
		}
	}
	if apply {
		syncDir(dst)
	}
	return nil
}

func removeEmpty(path string, apply bool) error {
	if !apply {
		return nil
	}
	if err := mergeStep(); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func isRealDir(info os.FileInfo) bool { return info.IsDir() && info.Mode()&os.ModeSymlink == 0 }

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
		// The staging link stays until the old name links: a crash after the
		// rename leaves it as the mark of a move to finish.
		if err := os.Rename(p.Old, p.New); err != nil {
			_ = os.Remove(staging)
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

// renameIfAbsent is renameNoReplace for file systems without it: the check
// and the rename run under the parent lock, which every component of this
// package takes.
func renameIfAbsent(a, b string) error {
	if _, err := os.Lstat(b); err == nil {
		return os.ErrExist
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(a, b)
}
