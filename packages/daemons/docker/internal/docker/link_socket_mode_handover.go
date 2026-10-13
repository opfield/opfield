package docker

import (
	"net"
	"os"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/netaccept"
)

// A switch of the daemon's user (root to non-root or back) hands the link Unix sockets (egress.sock,
// storage-relay.sock) to the next process like any restart, but the next process cannot use them as its own: a root
// daemon's socket belongs to uid 65532 with 0600, a non-root daemon's to its user and group with 0660, and a socket
// directory a root daemon left to uid 65532 is set aside (claimConnectorDirectory). The connectors of the previous
// mode still reach those sockets, and connections they made during the switch wait in their backlog. The next process
// serves them as previous listeners next to its own new socket until the connectors of the previous mode are retired,
// then drops them: no connection hangs, and nothing stays in the listener keeper.

// adoptKeptUnixListener takes over the Unix listener the previous daemon process kept for path, if the path still
// names that socket and the socket file fits this daemon (fits); a kept socket that does not fit is dropped.
func adoptKeptUnixListener(path string, fits func(os.FileInfo) bool) (*net.UnixListener, string) {
	current, name, previous := adoptKeptUnixListeners(path, fits)
	for _, listener := range previous {
		listener.close()
	}
	return current, name
}

// adoptKeptUnixListeners takes every listener the previous process kept for path: the one whose socket file is at
// path and fits this daemon is current; the others (another mode's socket, a file set aside with its directory) are
// previous, to be served until their clients are retired.
func adoptKeptUnixListeners(path string, fits func(os.FileInfo) bool) (*net.UnixListener, string, []previousUnixListener) {
	currentName, nameErr := listenerkeep.Name(path)
	var current *net.UnixListener
	var previous []previousUnixListener
	for _, name := range listenerkeep.Inherited(path) {
		if listenerkeep.NamePath(name) != path {
			continue
		}
		file, ok := listenerkeep.Take(name)
		if !ok {
			continue
		}
		listener, err := net.FileListener(file)
		_ = file.Close()
		unixListener, isUnix := listener.(*net.UnixListener)
		if err != nil || !isUnix {
			if listener != nil {
				_ = listener.Close()
			}
			_ = listenerkeep.Drop(name)
			continue
		}
		// Its file is the socket of the previous process: closing the listener must not remove it.
		unixListener.SetUnlinkOnClose(false)
		if nameErr == nil && name == currentName && current == nil {
			if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSocket != 0 && fits(info) {
				current = unixListener
				continue
			}
		}
		previous = append(previous, previousUnixListener{listener: unixListener, keptName: name})
	}
	if current == nil && nameErr == nil {
		// Not handed over: a copy systemd may still keep of the socket about to be replaced goes.
		_ = listenerkeep.DropStale(currentName)
	}
	if current == nil {
		currentName = ""
	}
	return current, currentName, previous
}

// previousUnixListener is a link socket of the daemon's previous mode, served until its clients are retired.
type previousUnixListener struct {
	listener *net.UnixListener
	keptName string
}

func (l previousUnixListener) close() {
	_ = l.listener.Close()
	_ = listenerkeep.Drop(l.keptName)
}

// previousUnixListeners serves the previous mode's link sockets of one kind.
type previousUnixListeners struct {
	mu        sync.Mutex
	listeners []previousUnixListener
}

// previousSocketLimit drops the previous mode's sockets that their retirement did not drop before.
var previousSocketLimit = func() time.Duration { return secureLinkConnectorRetireLimit + time.Minute }

// serve accepts on every previous listener with handle until retire.
func (s *previousUnixListeners) serve(listeners []previousUnixListener, handle func(net.Conn)) {
	if len(listeners) == 0 {
		return
	}
	s.mu.Lock()
	s.listeners = append(s.listeners, listeners...)
	s.mu.Unlock()
	for _, listener := range listeners {
		go netaccept.Serve(listener.listener, nil, handle)
	}
	time.AfterFunc(previousSocketLimit(), s.retire)
}

// retire stops serving the previous listeners and drops them from the listener keeper.
func (s *previousUnixListeners) retire() {
	s.mu.Lock()
	listeners := s.listeners
	s.listeners = nil
	s.mu.Unlock()
	for _, listener := range listeners {
		listener.close()
	}
}

// count reports the previous listeners still served (tests).
func (s *previousUnixListeners) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.listeners)
}
