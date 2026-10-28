//go:build linux

package daemon

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

type unixPeerIdentity struct {
	pid int
	uid int
	gid int
}

func unixPeerCredentials(connection net.Conn) (unixPeerIdentity, error) {
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return unixPeerIdentity{}, errors.New("secure-link peer is not a Unix connection")
	}
	rawConnection, err := unixConnection.SyscallConn()
	if err != nil {
		return unixPeerIdentity{}, err
	}
	var credentials *unix.Ucred
	var credentialError error
	if err := rawConnection.Control(func(fd uintptr) {
		credentials, credentialError = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return unixPeerIdentity{}, err
	}
	if credentialError != nil {
		return unixPeerIdentity{}, credentialError
	}
	if credentials == nil {
		return unixPeerIdentity{}, errors.New("secure-link peer credentials are unavailable")
	}
	return unixPeerIdentity{pid: int(credentials.Pid), uid: int(credentials.Uid), gid: int(credentials.Gid)}, nil
}

func processParentAndEffectiveUID(pid int) (int, int, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, 0, err
	}
	parentPID := 0
	effectiveUID := -1
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "PPid:" {
			parentPID, err = strconv.Atoi(fields[1])
			if err != nil {
				return 0, 0, err
			}
		}
		if len(fields) >= 3 && fields[0] == "Uid:" {
			effectiveUID, err = strconv.Atoi(fields[2])
			if err != nil {
				return 0, 0, err
			}
		}
	}
	if parentPID < 0 || effectiveUID < 0 {
		return 0, 0, errors.New("managed nginx process identity is incomplete")
	}
	return parentPID, effectiveUID, nil
}

func processExecutableMatches(pid int, expected string) bool {
	actual, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return false
	}
	actual = strings.TrimSuffix(actual, " (deleted)")
	return filepath.Clean(actual) == expected
}

func isManagedNginxProcess(peerPID, masterPID int, nginxBinary string) bool {
	if peerPID <= 0 || masterPID <= 0 || !processExecutableMatches(peerPID, nginxBinary) {
		return false
	}
	current := peerPID
	for range 64 {
		if current == masterPID {
			return true
		}
		parent, _, err := processParentAndEffectiveUID(current)
		if err != nil || parent <= 1 || parent == current {
			return false
		}
		current = parent
	}
	return false
}

func managedNginxWorkerUID(masterPID int, nginxBinary string) (int, error) {
	_, uid, err := managedNginxWorker(masterPID, nginxBinary)
	return uid, err
}

// managedNginxWorkerGID is the effective gid of a worker of the managed nginx master.
func managedNginxWorkerGID(masterPID int, nginxBinary string) (int, error) {
	pid, _, err := managedNginxWorker(masterPID, nginxBinary)
	if err != nil {
		return 0, err
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if fields := strings.Fields(line); len(fields) >= 3 && fields[0] == "Gid:" {
			return strconv.Atoi(fields[2])
		}
	}
	return 0, errors.New("managed nginx worker group is unknown")
}

// managedNginxWorker returns the PID and effective uid of a worker of the managed nginx master.
func managedNginxWorker(masterPID int, nginxBinary string) (int, int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, 0, err
	}
	for _, entry := range entries {
		pid, parseErr := strconv.Atoi(entry.Name())
		if parseErr != nil || pid == masterPID || !processExecutableMatches(pid, nginxBinary) {
			continue
		}
		parent, uid, identityErr := processParentAndEffectiveUID(pid)
		if identityErr == nil && parent == masterPID {
			return pid, uid, nil
		}
	}
	return 0, 0, errors.New("managed nginx worker process not found")
}
