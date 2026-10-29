// Package loopbackpeer tells which local user is behind a loopback TCP connection. A loopback port carries no process
// credentials (SO_PEERCRED is for Unix sockets), but the kernel knows the owner of the peer's socket: one exact
// sock_diag lookup of that socket by its address pair answers it, without a dump of the socket table and without
// privilege.
//
// Any local process may connect to a port on 127.0.0.1, so a daemon's loopback listener that hands out something of
// value (a relay route, a registry credential) serves only the users it expects (Restrict).
package loopbackpeer

import (
	"errors"
	"net"
	"sync"
)

// Restrict returns a listener whose Accept returns only connections whose peer socket belongs to a user allowed
// accepts; any other connection is closed at once. refused (nil: none) hears about each refused peer, with uid -1
// when the owner could not be determined (an IPv6 or non-loopback peer, no sock_diag).
func Restrict(listener net.Listener, allowed func(uid int) bool, refused func(uid int, remote net.Addr)) net.Listener {
	return &restrictedListener{Listener: listener, allowed: allowed, refused: refused}
}

type restrictedListener struct {
	net.Listener
	allowed func(uid int) bool
	refused func(uid int, remote net.Addr)
}

func (l *restrictedListener) Accept() (net.Conn, error) {
	for {
		connection, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		uid, err := UID(connection)
		if err == nil && l.allowed(uid) {
			return connection, nil
		}
		if err != nil {
			uid = -1
		}
		remote := connection.RemoteAddr()
		_ = connection.Close()
		if l.refused != nil {
			l.refused(uid, remote)
		}
	}
}

// Users allows root and the given uids: root stands for the system services that reach a daemon's loopback listener
// (dockerd, BuildKit), the others for the daemon's own user and the users of the containers it starts.
func Users(uids ...int) func(uid int) bool {
	return func(uid int) bool {
		if uid == 0 {
			return true
		}
		for _, allowed := range uids {
			if uid == allowed {
				return true
			}
		}
		return false
	}
}

// RefusalLog reports refused peers through log at most once per uid, so a local process that keeps retrying does
// not flood the daemon's log.
func RefusalLog(log func(uid int, remote net.Addr)) func(uid int, remote net.Addr) {
	var mu sync.Mutex
	seen := map[int]bool{}
	return func(uid int, remote net.Addr) {
		mu.Lock()
		first := !seen[uid] && len(seen) < 64
		if first {
			seen[uid] = true
		}
		mu.Unlock()
		if first {
			log(uid, remote)
		}
	}
}

var errNotLoopback = errors.New("peer is not an IPv4 loopback connection")
