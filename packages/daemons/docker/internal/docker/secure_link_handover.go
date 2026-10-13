package docker

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

// A replaced secure-link connector hands the sessions it carries to the connector that replaced it (the connector's
// takeover.go): the sockets move between the two processes, the sessions never close, and the replaced connector is
// removed as soon as it carries nothing. The daemon starts it in place of the drain request when the retirement begins
// and counts the tunnels it dialed into the handed over sessions as the replacement's from then on: they are neither
// closed when idle nor cut at the retire limit. What a connector cannot pass on (a session whose TLS it originates,
// one still being set up), and every session of a connector of an earlier release, it finishes as a drained connector
// did before, up to the retire limit.

const (
	// connectorHandoverWait bounds a handover request: the connector waits for sessions being set up, stops every
	// session and passes them over.
	connectorHandoverWait = 40 * time.Second
	// connectorHandoverAttempts bounds the handovers one retirement asks for: the first, and later ones for sessions a
	// handover left because they were still being set up or did not stop in time.
	connectorHandoverAttempts = 3
	// connectorHandoverRetry spaces the handovers a retirement asks for.
	connectorHandoverRetry = 5 * time.Second
)

// connectorHandover is one retirement's handovers.
type connectorHandover struct {
	attempts int
	// unsupported: the connector is of a release that cannot hand over.
	unsupported bool
	// handedOver counts the sessions handed over so far.
	handedOver int
	// retry: the last handover left sessions a later one may take.
	retry bool
}

// due reports whether the retirement asks the connector for a handover now: none yet, or one more for what the last
// left.
func (h *connectorHandover) due() bool {
	return !h.unsupported && h.attempts < connectorHandoverAttempts && (h.attempts == 0 || h.retry)
}

// handoverSuccessor is the base name of the serving connector's control socket, when it replaced previous and shares
// its control directory (the place both connectors mount): the connector previous hands its sessions to.
// apart: a connector serves, but in another control directory (one a switch of the daemon's user set aside), which
// previous cannot reach: it never hands over.
func (m *dockerSecureLinkManager) handoverSuccessor(previous connectorRuntime) (id, socket string, ok, apart bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.handoverSuccessorLocked(previous)
}

func (m *dockerSecureLinkManager) handoverSuccessorLocked(previous connectorRuntime) (id, socket string, ok, apart bool) {
	if m.connectorID == "" || m.connectorID == previous.id || m.socketPath == "" || previous.socketPath == "" {
		return "", "", false, false
	}
	if filepath.Dir(m.socketPath) != filepath.Dir(previous.socketPath) {
		return "", "", false, true
	}
	return m.connectorID, filepath.Base(m.socketPath), true, false
}

// handOverRetiring asks the connector a retirement retires for a handover to the serving connector, if one replaced it:
// answered when the connector answered (it drains from then on, and active is what it still carries), stopped when
// another path ended the retirement (removed the connector). Without a replacement in its control directory it asks
// nothing.
func (m *dockerSecureLinkManager) handOverRetiring(handle *retirement, previous connectorRuntime, state *connectorHandover) (active int, answered, stopped bool) {
	if !state.due() {
		return 0, false, false
	}
	// Read before the retirement's lock: the manager's lock holder may stop the retirement, which takes that lock.
	successor, socket, ok, apart := m.handoverSuccessor(previous)
	if apart {
		state.unsupported = true
	}
	if !ok {
		return 0, false, false
	}
	active, sent, _ := handle.drain(func() (int, error) {
		var carried int
		answered, carried = m.handOverConnector(previous, successor, socket, state)
		return carried, nil
	})
	return active, answered && sent, !sent
}

// handOverConnector asks the connector at previous.socketPath to hand its sessions to the connector successor (whose
// control socket is named socket) and moves the tunnels it handed over to successor. It reports whether the connector
// answered (it drains from then on) and the sessions it still carries.
func (m *dockerSecureLinkManager) handOverConnector(previous connectorRuntime, successor, socket string, state *connectorHandover) (answered bool, active int) {
	ctx, cancel := context.WithTimeout(context.Background(), connectorHandoverWait)
	defer cancel()
	state.attempts++
	result, active, err := securelink.Handover(ctx, previous.socketPath, socket)
	if errors.Is(err, securelink.ErrHandoverUnsupported) {
		state.unsupported = true
		return false, 0
	}
	if err != nil {
		state.retry = false
		if m.plugin.logger != nil {
			m.plugin.logger.Warn("the replaced secure-link connector did not hand its sessions over; it finishes them itself",
				"connector", previous.id, "error", err)
		}
		return false, 0
	}
	moved := m.plugin.proxyTunnels.moveToConnector(result.Peers, successor)
	state.handedOver += result.HandedOver
	// Sessions still being set up or that did not stop in time may go with a later handover; a TLS session never does.
	state.retry = result.Left[securelink.HandoverLeftStarting] > 0 || result.Left[securelink.HandoverLeftBusy] > 0
	if m.plugin.logger != nil {
		args := []any{"connector", previous.id, "to", successor, "handed_over", result.HandedOver, "tunnels_moved", moved,
			"still_carried", active}
		if len(result.Left) > 0 {
			args = append(args, "left", result.Left)
		}
		if result.Error != "" {
			args = append(args, "error", result.Error)
		}
		if active > 0 {
			m.plugin.logger.Warn("the replaced secure-link connector handed its sessions over to its replacement; the rest it finishes itself, up to the retire limit", args...)
		} else {
			m.plugin.logger.Info("the replaced secure-link connector handed its sessions over to its replacement", args...)
		}
	}
	return true, active
}

// moveToConnector counts the tunnels whose connection peers names as the connector to's from now on and returns how
// many it moved.
func (s *proxyTunnelSet) moveToConnector(peers []securelink.HandoverPeer, to string) int {
	if len(peers) == 0 {
		return 0
	}
	wanted := make(map[[2]netip.AddrPort]bool, len(peers))
	for _, peer := range peers {
		daemon, daemonErr := netip.ParseAddrPort(peer.Daemon)
		connector, connectorErr := netip.ParseAddrPort(peer.Connector)
		if daemonErr == nil && connectorErr == nil {
			wanted[[2]netip.AddrPort{unmapAddrPort(daemon), unmapAddrPort(connector)}] = true
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	moved := 0
	for connection := range s.tunnels {
		through := connectorConnOf(connection)
		if through == nil {
			continue
		}
		local, localOK := addrPortOf(through.LocalAddr())
		remote, remoteOK := addrPortOf(through.RemoteAddr())
		if localOK && remoteOK && wanted[[2]netip.AddrPort{local, remote}] {
			through.moveTo(to)
			moved++
		}
	}
	return moved
}

func unmapAddrPort(address netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(address.Addr().Unmap(), address.Port())
}

func addrPortOf(address net.Addr) (netip.AddrPort, bool) {
	tcp, ok := address.(*net.TCPAddr)
	if !ok {
		return netip.AddrPort{}, false
	}
	ip, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return netip.AddrPort{}, false
	}
	return netip.AddrPortFrom(ip.Unmap(), uint16(tcp.Port)), true
}

// connectorConnOf returns the connection through a connector under connection's wrappers.
func connectorConnOf(connection net.Conn) *connectorConn {
	for depth := 0; connection != nil && depth < 16; depth++ {
		switch current := connection.(type) {
		case *connectorConn:
			return current
		case *drainConn:
			connection = current.Conn
		default:
			return nil
		}
	}
	return nil
}

// movedConnector is the connector a handover moved a connection to (nil: none).
type movedConnector struct {
	id atomic.Pointer[string]
}

func (c *connectorConn) moveTo(id string) {
	c.moved.id.Store(&id)
}

// connector is the connector that carries the connection: the one it was dialed through, or the one a handover moved
// it to.
func (c *connectorConn) connector() string {
	if moved := c.moved.id.Load(); moved != nil {
		return *moved
	}
	return c.connectorID
}
