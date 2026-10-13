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
