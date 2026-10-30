// Package loopbackpeer tells which local user is behind a loopback TCP connection. A loopback port carries no process
// credentials (SO_PEERCRED is for Unix sockets), but the kernel knows the owner of the peer's socket: one exact
// sock_diag lookup of that socket by its address pair answers it, without a dump of the socket table and without
// privilege.
//
// Any local process may connect to a port on 127.0.0.1, so a daemon's loopback listener that hands out something of
// value (a relay route, a registry credential) serves only the users it expects (Restrict). A host where the lookup
// does not work (no inet_diag, an unprivileged container, gVisor) cannot tell the users apart: there the listener
// serves every local user, as before the check existed, and the daemon reports it (Check).
package loopbackpeer

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

// Restrict returns a listener whose Accept returns only connections whose peer socket belongs to a user allowed
// accepts; any other connection is closed at once. refused (nil: none) hears about each refused peer, with uid -1
// when the owner could not be determined (an IPv6 or non-loopback peer, a closed peer). While the host cannot look
// up peers at all (Check fails), every connection is served unchecked and unchecked (nil: none) hears why.
func Restrict(listener net.Listener, allowed func(uid int) bool, refused func(uid int, remote net.Addr), unchecked func(err error)) net.Listener {
	return &restrictedListener{Listener: listener, allowed: allowed, refused: refused, unchecked: unchecked}
}

type restrictedListener struct {
	net.Listener
	allowed   func(uid int) bool
	refused   func(uid int, remote net.Addr)
	unchecked func(err error)
}

func (l *restrictedListener) Accept() (net.Conn, error) {
	for {
		connection, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if checkErr := Check(); checkErr != nil {
			if l.unchecked != nil {
				l.unchecked(checkErr)
			}
			return connection, nil
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

// checkRetry is how long a failed self-test stands before Check runs it again (a kernel module loaded later).
const checkRetry = time.Minute

var check struct {
	sync.Mutex
	done bool
	err  error
	at   time.Time
}

// selfTest is replaced in tests.
var selfTest = lookUpOwnConnection

// Check reports whether this host can tell the owner of a loopback peer: a lookup of a connection this process opens
// to itself must answer its own uid. A success holds for the life of the process; a failure is tested again after a
// minute. The error says why the lookup does not work (for the node's warning).
func Check() error {
	check.Lock()
	defer check.Unlock()
	if check.done && (check.err == nil || time.Since(check.at) < checkRetry) {
		return check.err
	}
	check.err, check.done, check.at = selfTest(), true, time.Now()
	return check.err
}

func lookUpOwnConnection() error {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("open a loopback listener: %w", err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			close(accepted)
			return
		}
		accepted <- connection
	}()
	client, err := net.DialTimeout("tcp4", listener.Addr().String(), 2*time.Second)
	if err != nil {
		return fmt.Errorf("connect to a loopback listener: %w", err)
	}
	defer client.Close()
	var server net.Conn
	select {
	case server = <-accepted:
	case <-time.After(2 * time.Second):
	}
	if server == nil {
		return errors.New("accept a loopback connection: timed out")
	}
	defer server.Close()
	uid, err := UID(server)
	if err != nil {
		return fmt.Errorf("sock_diag lookup of a loopback peer: %w", err)
	}
	if uid != os.Getuid() {
		return fmt.Errorf("sock_diag lookup answered uid %d for this process (uid %d)", uid, os.Getuid())
	}
	return nil
}

// resetCheck forgets the self-test result (tests).
func resetCheck() {
	check.Lock()
	defer check.Unlock()
	check.done, check.err = false, nil
}
