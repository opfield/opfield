package docker

import (
	"errors"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"net"
	"strconv"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

// The registry proxy's listening socket goes to the next daemon process on a restart or update (listenerkeep), like
// the link sockets: the pulls and pushes dockerd starts meanwhile wait in its backlog instead of being refused. A pull
// or push in flight passes this process (its TLS ends here) and is cut, as before.

// registryProxyKeepName names the proxy's listening socket in the listener keeper.
func registryProxyKeepName() string {
	return legacycompat.RegistryProxyHandoverPrefix + registryProxyAddress + "/" + strconv.Itoa(registryProxyPort)
}

// adoptKeptListener takes over the socket the previous process kept, for the first sync that starts the proxy. A
// node whose proxy does not start again within keptListenerAdoptionWindow closes it.
func (m *dockerRegistryProxyManager) adoptKeptListener() {
	file, ok := listenerkeep.Take(registryProxyKeepName())
	if !ok {
		return
	}
	m.mu.Lock()
	m.adopted = file
	m.mu.Unlock()
	time.AfterFunc(keptListenerAdoptionWindow, m.releaseAdopted)
}

func (m *dockerRegistryProxyManager) releaseAdopted() {
	m.mu.Lock()
	file := m.adopted
	m.adopted = nil
	m.mu.Unlock()
	if file != nil {
		_ = file.Close()
		_ = listenerkeep.Drop(registryProxyKeepName())
	}
}

// listenKept opens the proxy's listening socket: the one the previous process kept while it is still the proxy's
// address, else a new one, kept for the next process. It returns the keeper name ("" when not kept).
func (m *dockerRegistryProxyManager) listenKept() (*net.TCPListener, string, error) {
	name := registryProxyKeepName()
	m.mu.Lock()
	file := m.adopted
	m.adopted = nil
	m.mu.Unlock()
	address := &net.TCPAddr{IP: net.ParseIP(registryProxyAddress).To4(), Port: registryProxyPort}
	if file != nil {
		listener, err := net.FileListener(file)
		_ = file.Close()
		if err == nil {
			if tcp, ok := listener.(*net.TCPListener); ok && listenerTCPAddress(tcp).IP.Equal(address.IP) && listenerTCPAddress(tcp).Port == address.Port {
				return tcp, name, nil
			}
			_ = listener.Close()
		}
		_ = listenerkeep.Drop(name)
	}
	// A copy the keeper still holds (a launcher without a keeper left it in systemd's store) is closed first; its
	// close is asynchronous, so a bind refused meanwhile is retried briefly.
	_ = listenerkeep.DropStale(name)
	deadline := time.Now().Add(listenerRebindWait)
	for {
		listener, err := net.ListenTCP("tcp4", address)
		if err == nil {
			return listener, keepListener(listener, name), nil
		}
		if !errors.Is(err, syscall.EADDRINUSE) || time.Now().After(deadline) {
			return nil, "", err
		}
		time.Sleep(listenerRebindTick)
	}
}

// suspendForHandover stops the proxy accepting for the next process: the keeper's copy keeps the socket and its
// backlog. A socket without a keeper's copy keeps accepting: closing it would only refuse pulls earlier.
func (m *dockerRegistryProxyManager) suspendForHandover() bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	m.handingOver = true
	listener, keptName := m.listener, m.keptName
	if keptName != "" {
		m.listener, m.keptName = nil, ""
	}
	m.mu.Unlock()
	if listener == nil || keptName == "" {
		return false
	}
	// Only this process's descriptor closes; the server's Serve returns.
	_ = listener.Close()
	return true
}
