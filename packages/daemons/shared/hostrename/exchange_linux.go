package hostrename

import (
	"errors"

	"golang.org/x/sys/unix"
)

var errExchangeUnsupported = errors.New("rename exchange is not supported")

// exchange swaps two names atomically (renameat2 RENAME_EXCHANGE).
func exchange(a, b string) error {
	err := unix.Renameat2(unix.AT_FDCWD, a, unix.AT_FDCWD, b, unix.RENAME_EXCHANGE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EOPNOTSUPP) {
		return errExchangeUnsupported
	}
	return err
}

// renameNoReplace renames a to b and fails when b exists (renameat2
// RENAME_NOREPLACE), so a merge never replaces an entry another component
// created meanwhile.
func renameNoReplace(a, b string) error {
	err := unix.Renameat2(unix.AT_FDCWD, a, unix.AT_FDCWD, b, unix.RENAME_NOREPLACE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EOPNOTSUPP) {
		return renameIfAbsent(a, b)
	}
	return err
}
