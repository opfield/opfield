//go:build linux

package daemon

import (
	"net"
	"syscall"
	"unsafe"
)

// resetSocket aborts a TCP connection at once with a reset (connect with
// AF_UNSPEC disconnects the socket itself, so a copy of its descriptor held
// elsewhere does not delay it), and leaves SO_LINGER 0 for the close.
func resetSocket(connection net.Conn) error {
	raw, err := rawSocket(connection)
	if err != nil {
		return err
	}
	var resetErr error
	if err := raw.Control(func(fd uintptr) {
		_ = syscall.SetsockoptLinger(int(fd), syscall.SOL_SOCKET, syscall.SO_LINGER, &syscall.Linger{Onoff: 1})
		address := syscall.RawSockaddr{Family: syscall.AF_UNSPEC}
		if _, _, errno := syscall.Syscall(syscall.SYS_CONNECT, fd, uintptr(unsafe.Pointer(&address)), unsafe.Sizeof(address)); errno != 0 {
			resetErr = errno
		}
	}); err != nil {
		return err
	}
	return resetErr
}
