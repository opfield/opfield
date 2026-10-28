//go:build !linux

package daemon

import (
	"net"
)

func resetSocket(connection net.Conn) error {
	return setSocketLinger(connection, 0)
}
