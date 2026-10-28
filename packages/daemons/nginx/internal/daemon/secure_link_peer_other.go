//go:build !linux

package daemon

import (
	"errors"
	"net"
)

type unixPeerIdentity struct {
	pid int
	uid int
	gid int
}

func unixPeerCredentials(net.Conn) (unixPeerIdentity, error) {
	return unixPeerIdentity{}, errors.New("secure-link peer credentials require Linux")
}

func isManagedNginxProcess(peerPID, masterPID int, nginxBinary string) bool {
	return false
}

func managedNginxWorkerUID(masterPID int, nginxBinary string) (int, error) {
	return 0, errors.New("managed nginx worker identity requires Linux")
}

func managedNginxWorkerGID(masterPID int, nginxBinary string) (int, error) {
	return 0, errors.New("managed nginx worker identity requires Linux")
}
