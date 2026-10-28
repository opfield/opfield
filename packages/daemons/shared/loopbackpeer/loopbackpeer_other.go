//go:build !linux

package loopbackpeer

import (
	"errors"
	"net"
)

// UID needs sock_diag: elsewhere no loopback peer can be identified, and Restrict refuses every connection.
func UID(connection net.Conn) (int, error) {
	if _, ok := connection.RemoteAddr().(*net.TCPAddr); !ok {
		return 0, errNotLoopback
	}
	return 0, errors.New("loopback peer credentials require Linux")
}
