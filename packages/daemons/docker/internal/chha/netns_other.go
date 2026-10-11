//go:build !linux

package chha

import (
	"errors"
	"net"
)

// ListenInNetns needs Linux network namespaces.
func ListenInNetns(int, string) (net.Listener, error) {
	return nil, errors.New("container network namespaces need Linux")
}
