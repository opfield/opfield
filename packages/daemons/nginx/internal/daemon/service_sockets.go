package daemon

import (
	"errors"
	"net"
	"os"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

// The daemon's service sockets nginx reaches (the ingress health responder, maintenance access) go to the next
// daemon process on a restart or update like the Secure Link sockets: the listener keeper holds a copy, so a request
// nginx sends meanwhile waits in the backlog instead of failing.

// listenServiceSocket listens on a service socket at path with mode (nginx workers run as another user: 0666 for any
// local process, 0660 for the group its caller gives the socket): the socket the previous process kept there while
// the path still names it, else a new one, kept for the next process. It returns the keeper name ("" when not kept).
func listenServiceSocket(path string, mode os.FileMode) (net.Listener, string, error) {
	if current, err := listenerkeep.Name(path); err == nil {
		if file, name, ok := takeKept(current); ok {
			listener, err := net.FileListener(file)
			_ = file.Close()
			if unixListener, ok := listener.(*net.UnixListener); err == nil && ok {
				unixListener.SetUnlinkOnClose(false)
				if os.Chmod(path, mode) == nil {
					return unixListener, name, nil
				}
			}
			if listener != nil {
				_ = listener.Close()
			}
			_ = listenerkeep.Drop(name)
		} else {
			// Not handed over: a copy systemd may still keep of the socket about to be replaced goes.
			dropStaleKept(current)
		}
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, "", errors.New("refusing to replace a non-socket path")
		}
		if err := os.Remove(path); err != nil {
			return nil, "", err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, "", err
	}
	if err := os.Chmod(path, mode); err != nil {
		_ = listener.Close()
		_ = os.Remove(path)
		return nil, "", err
	}
	return listener, keepUnixListener(listener, path), nil
}

// releaseServiceSocket prepares a service socket for closing: handed over (the daemon gave its sockets to the next
// process), only this process's descriptor closes and the socket file stays; otherwise the socket goes for good.
// Call it before the listener closes.
func releaseServiceSocket(listener net.Listener, path, keptName string, handedOver bool) (removeAfterClose func()) {
	if unixListener, ok := listener.(*net.UnixListener); ok {
		unixListener.SetUnlinkOnClose(false)
	}
	if handedOver && keptName != "" {
		return func() {}
	}
	return func() {
		if keptName != "" {
			_ = listenerkeep.Drop(keptName)
		}
		_ = os.Remove(path)
	}
}

// socketsHandedOver reports a daemon that gave its sockets to the next process
// (a restart or update): its service sockets go along.
func (p *NginxPlugin) socketsHandedOver() bool {
	return p != nil && p.secureLinks != nil && p.secureLinks.suspended.Load()
}
