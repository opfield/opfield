//go:build linux

package loopbackpeer

import (
	"encoding/binary"
	"errors"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	sockDiagByFamily    = 20
	inetDiagNoCookie    = ^uint32(0)
	inetDiagReqV2Size   = 56
	inetDiagMsgStateOff = 1
	inetDiagMsgUIDOff   = 4 + 48 + 12
	inetDiagMsgInodeOff = inetDiagMsgUIDOff + 4
	tcpEstablished      = 1
)

// UID returns the owner uid of the peer socket of a loopback TCP connection: one exact sock_diag lookup of the
// peer's socket by its address pair (no dump of the socket table, no privilege needed).
func UID(connection net.Conn) (int, error) {
	local, localOK := connection.LocalAddr().(*net.TCPAddr)
	remote, remoteOK := connection.RemoteAddr().(*net.TCPAddr)
	if !localOK || !remoteOK || local.IP.To4() == nil || remote.IP.To4() == nil || !remote.IP.IsLoopback() {
		return 0, errNotLoopback
	}
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, unix.NETLINK_SOCK_DIAG)
	if err != nil {
		return 0, err
	}
	defer unix.Close(fd)
	request := make([]byte, unix.NLMSG_HDRLEN+inetDiagReqV2Size)
	native := binary.NativeEndian
	native.PutUint32(request[0:], uint32(len(request)))
	native.PutUint16(request[4:], sockDiagByFamily)
	native.PutUint16(request[6:], unix.NLM_F_REQUEST)
	native.PutUint32(request[8:], 1)
	body := request[unix.NLMSG_HDRLEN:]
	body[0] = unix.AF_INET
	body[1] = unix.IPPROTO_TCP
	native.PutUint32(body[4:], ^uint32(0))
	// The peer's socket: its own address is the connection's remote one.
	id := body[8:]
	binary.BigEndian.PutUint16(id[0:], uint16(remote.Port))
	binary.BigEndian.PutUint16(id[2:], uint16(local.Port))
	copy(id[4:8], remote.IP.To4())
	copy(id[20:24], local.IP.To4())
	native.PutUint32(id[40:], inetDiagNoCookie)
	native.PutUint32(id[44:], inetDiagNoCookie)
	if err := unix.Sendto(fd, request, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return 0, err
	}
	response := make([]byte, 8192)
	n, _, err := unix.Recvfrom(fd, response, 0)
	if err != nil {
		return 0, err
	}
	messages, err := syscall.ParseNetlinkMessage(response[:n])
	if err != nil {
		return 0, err
	}
	for _, message := range messages {
		switch message.Header.Type {
		case unix.NLMSG_ERROR:
			if len(message.Data) >= 4 {
				if code := int32(native.Uint32(message.Data)); code != 0 {
					return 0, syscall.Errno(-code)
				}
			}
			return 0, errors.New("loopback peer socket lookup failed")
		case sockDiagByFamily:
			return peerOwner(message.Data)
		}
	}
	return 0, errors.New("loopback peer socket not found")
}

// peerOwner reads the owner uid from an inet_diag_msg (linux/inet_diag.h: family, state, timer, retrans, a 48-byte
// sockid, expires, rqueue, wqueue, uid, inode). Only a live, established socket has an owner: a peer that wrote and
// closed before the lookup leaves a timewait mini-socket the kernel reports with uid 0 and inode 0, which would pass
// for root.
func peerOwner(data []byte) (int, error) {
	if len(data) < inetDiagMsgInodeOff+4 {
		return 0, errors.New("short loopback peer socket answer")
	}
	native := binary.NativeEndian
	if data[inetDiagMsgStateOff] != tcpEstablished {
		return 0, errors.New("loopback peer socket is not established")
	}
	if native.Uint32(data[inetDiagMsgInodeOff:]) == 0 {
		return 0, errors.New("loopback peer socket has no owner (closed)")
	}
	return int(native.Uint32(data[inetDiagMsgUIDOff:])), nil
}
