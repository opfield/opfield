package daemon

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

// Loopback TCP endpoints (2.11.4). nginx reaches a Secure Link source over a
// Unix socket in rc.10 and earlier. A Unix stream socket has no reset: when a
// stream is really cut (this daemon crashed, the node rebooted, every relay
// stayed away, a connector retired it) nginx reads a clean end of file, and a
// response without Content-Length or chunked framing (HTTP/1.0, streams) looks
// complete to it: the client got a silently truncated body. Over loopback TCP
// a cut ends with a reset (RST), so nginx logs an upstream error and aborts
// the client's response instead.
//
// Every link Opfield gives an address listens on its own loopback address
// (127.a.b.c, allocated uniquely per link by Opfield, one port for all), next
// to its Unix socket: the socket stays for configs rendered before the update,
// a rollback, and the daemon's own probes. The TCP listener follows the Unix
// one exactly (lease gate, rotation, handover to the next process).
//
// Any local process may connect to a loopback port, so a connection is served
// only when its peer socket belongs to the managed nginx workers' uid
// (sock_diag, loopbackpeer.UID).
//
// A served connection carries SO_LINGER 0 from its accept on: closing it, by
// this process or by the kernel when the process dies, resets it. Only a
// normal end clears it first: the remote side finished its response (half
// close passed on to nginx), nginx ended its side, or an idle keep-alive
// connection is let go.

// NginxSecureLinkLoopbackCapability tells Opfield that this daemon serves the
// loopback endpoints, so the configs of its routes may use them.
const NginxSecureLinkLoopbackCapability = "nginx_secure_link_loopback_tcp_v1"

// parseSecureLinkLoopbackAddress validates a loopback endpoint Opfield sent:
// an IPv4 loopback address other than 127.0.0.1 (shared with every other local
// service) and a non-zero port.
func parseSecureLinkLoopbackAddress(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	endpoint, err := netip.ParseAddrPort(value)
	if err != nil {
		return "", fmt.Errorf("invalid Secure Link loopback address %q", value)
	}
	address := endpoint.Addr()
	if !address.Is4() || !address.IsLoopback() || address == netip.AddrFrom4([4]byte{127, 0, 0, 1}) || endpoint.Port() == 0 {
		return "", fmt.Errorf("invalid Secure Link loopback address %q", value)
	}
	return endpoint.String(), nil
}

// loopbackKeepName is the listener keeper's name of a link's loopback
// listener: under the socket directory, so the release of unclaimed kept
// sockets covers it too. Keeper names carry no colon (systemd's descriptor
// names), so the port follows an underscore.
func (m *sourceLinkManager) loopbackKeepName(id, address string) string {
	return filepath.Join(m.socketDir, id+".loopback") + "#" + strings.ReplaceAll(address, ":", "_")
}

// listenLoopback returns the loopback listener of a link, the one the previous
// process kept when there is one (its backlog holds the connections made
// during the restart), and its keeper name ("" when not kept).
func (m *sourceLinkManager) listenLoopback(id, address string) (net.Listener, string, error) {
	if m.suspended.Load() {
		return nil, "", errors.New("secure-link sockets are being handed over to the next daemon process")
	}
	current := m.loopbackKeepName(id, address)
	if file, name, ok := takeKept(current); ok {
		listener, err := net.FileListener(file)
		_ = file.Close()
		if err == nil {
			if tcp, isTCP := listener.(*net.TCPListener); isTCP && tcp.Addr().String() == address {
				return listener, name, nil
			}
			_ = listener.Close()
		}
		_ = listenerkeep.Drop(name)
	} else {
		dropStaleKept(current)
	}
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return nil, "", fmt.Errorf("listen on proxy secure-link loopback address %s: %w", address, err)
	}
	return listener, keepLoopbackListener(listener, current), nil
}

// keepLoopbackListener hands a copy of a loopback listener to the listener
// keeper, so the next process takes it over; "" when there is no keeper.
func keepLoopbackListener(listener net.Listener, name string) string {
	tcp, ok := listener.(*net.TCPListener)
	if !ok || !listenerkeep.Available() {
		return ""
	}
	file, err := listenerFile(tcp, name)
	if err != nil {
		return ""
	}
	defer file.Close()
	if err := listenerkeep.Keep(name, file); err != nil {
		return ""
	}
	return name
}

// openLoopbackLocked starts the binding's loopback listener when it has an
// address and its Unix socket listens (the two open and close together).
// leaseMu is held.
func (b *sourceLinkBinding) openLoopbackLocked(m *sourceLinkManager, id string) error {
	if b.loopAddr == "" || b.loop != nil || b.unix == nil {
		return nil
	}
	listener, name, err := m.listenLoopback(id, b.loopAddr)
	if err != nil {
		return err
	}
	b.loop, b.loopKept = listener, name
	m.accept(id, b, listener, true)
	return nil
}

// closeLoopbackLocked stops the binding's loopback listener. keep leaves the
// keeper's copy for the next process (a handover); otherwise it is dropped and
// the address refuses connections. leaseMu is held.
func (b *sourceLinkBinding) closeLoopbackLocked(keep bool) {
	if !keep {
		if b.loop != nil {
			// Refused at once, although the keeper still holds a copy until the drop arrives.
			refuseNewConnections(b.loop)
		}
		if b.loopKept != "" {
			_ = listenerkeep.Drop(b.loopKept)
		}
		b.loopKept = ""
	}
	if b.loop != nil {
		_ = b.loop.Close()
		b.loop = nil
	}
}

// setLoopbackAddress applies a resync's loopback address to a binding that
// already exists.
func (b *sourceLinkBinding) setLoopbackAddress(m *sourceLinkManager, id, address string) error {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	if b.loopAddr != address {
		b.closeLoopbackLocked(false)
		b.loopAddr = address
	}
	select {
	case <-b.done:
		return nil
	default:
	}
	return b.openLoopbackLocked(m, id)
}

// takeLoopbackFrom moves the loopback listener of a binding a rotation retires
// to its successor, which serves the same address: a copy of the listening
// socket, so the address never refuses a connection meanwhile.
func (b *sourceLinkBinding) takeLoopbackFrom(m *sourceLinkManager, id string, previous *sourceLinkBinding) error {
	previous.leaseMu.Lock()
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	defer previous.leaseMu.Unlock()
	if previous.loop != nil && previous.loopAddr == b.loopAddr && b.unix != nil {
		listener, err := duplicateTCPListener(previous.loop)
		if err == nil {
			b.loop, b.loopKept = listener, previous.loopKept
			// Only the retired binding's own descriptor goes: the socket listens on in its successor.
			_ = previous.loop.Close()
			previous.loop, previous.loopKept = nil, ""
			m.accept(id, b, listener, true)
			return nil
		}
	}
	previous.closeLoopbackLocked(false)
	return b.openLoopbackLocked(m, id)
}

// secureLinkLoopbackReference matches a loopback endpoint an nginx upstream
// server directive names (Opfield renders 127.a.b.c:port, never 127.0.0.1).
var secureLinkLoopbackReference = regexp.MustCompile(`\bserver\s+(127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{1,5})\b`)

// isLoopbackConn reports a connection accepted on a binding's loopback
// listener (as opposed to its Unix socket or the legacy 127.0.0.1 listener).
func (b *sourceLinkBinding) isLoopbackConn(connection net.Conn) bool {
	local, ok := connection.LocalAddr().(*net.TCPAddr)
	if !ok {
		return false
	}
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	return b.loopAddr != "" && local.String() == b.loopAddr
}

// markGraceful records a normal end of a loopback connection: from here on
// closing it is a normal close (FIN), not a reset.
func (c *trackedConn) markGraceful() {
	if c.loopback.Load() && c.graceful.CompareAndSwap(false, true) {
		_ = setSocketLinger(c.Conn, -1)
	}
}

// Close closes the connection; a loopback connection that did not end
// normally is reset, whatever else still holds a copy of its socket, so nginx
// sees an upstream error instead of the end of the response. A connection the
// next process carries is left alone.
func (c *trackedConn) Close() error {
	if c.loopback.Load() && !c.graceful.Load() && !c.handedOver.Load() {
		_ = resetSocket(c.Conn)
	}
	return c.Conn.Close()
}

// readEnded marks a loopback connection whose nginx side ended (end of file):
// a normal end.
func (c *trackedConn) readEnded(err error) {
	if err != nil && errors.Is(err, io.EOF) {
		c.markGraceful()
	}
}

// rawSocket reaches the socket under a connection (a *net.TCPConn, or one the
// previous process handed over).
func rawSocket(connection net.Conn) (syscall.RawConn, error) {
	conn, ok := connection.(syscall.Conn)
	if !ok {
		return nil, errors.New("connection has no socket")
	}
	return conn.SyscallConn()
}

// setSocketLinger sets SO_LINGER: 0 resets the connection on close, a
// negative value restores the normal close.
func setSocketLinger(connection net.Conn, seconds int) error {
	raw, err := rawSocket(connection)
	if err != nil {
		return err
	}
	linger := syscall.Linger{}
	if seconds >= 0 {
		linger.Onoff, linger.Linger = 1, int32(seconds)
	}
	var setErr error
	if err := raw.Control(func(fd uintptr) {
		setErr = syscall.SetsockoptLinger(int(fd), syscall.SOL_SOCKET, syscall.SO_LINGER, &linger)
	}); err != nil {
		return err
	}
	return setErr
}
