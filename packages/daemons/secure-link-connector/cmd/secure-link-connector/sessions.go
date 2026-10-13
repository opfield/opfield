package main

import (
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

// Every session the connector carries is a pipe between two sockets (shared/handover): an ingress session between
// the daemon's connection and the target workload, an egress session between the workload's connection and the
// daemon's egress socket. A pipe can stop at a point where each byte is in one of its sockets or in the pending
// bytes it reports, so a replaced connector hands its sessions, sockets and pending bytes, to its replacement
// (takeover.go), which carries them on: for both ends a pause, not an end.

// Labels of a handed over session: what the replacement needs to carry it on.
const (
	sessionLabelKind = "kind"
	sessionLabelID   = "id"
	// sessionLabelPeer and sessionLabelLocal are the addresses of an ingress session's connection from the daemon:
	// the daemon's and the connector's.
	sessionLabelPeer  = "peer"
	sessionLabelLocal = "local"

	sessionKindIngress = "ingress"
	sessionKindEgress  = "egress"
)

// sessionSet is the connector's sessions: the registry a handover stops and reads, and the sessions still being set
// up (a target being dialed, a relayed stream being opened), which a handover waits for.
type sessionSet struct {
	registry *handover.Registry
	starting atomic.Int64
	mu       sync.Mutex
	// handedPeers collects the connections of the ingress sessions a handover passed on.
	handedPeers []securelink.HandoverPeer
	// handing: one handover at a time.
	handing sync.Mutex
}

func newSessionSet() *sessionSet {
	return &sessionSet{registry: handover.NewRegistry()}
}

// begin counts a session being set up until the returned func is called (once its pipe runs, or it failed).
func (s *sessionSet) begin() func() {
	s.starting.Add(1)
	var once sync.Once
	return func() { once.Do(func() { s.starting.Add(-1) }) }
}

// pipe carries a session until it ends, or until a handover passed it on: then it returns without touching either
// connection (closing this process's copies is all the caller does). started is called once the pipe is registered.
func (s *sessionSet) pipe(left, right net.Conn, labels handover.Labels, started func()) {
	s.carry(func() error {
		return s.registry.Pipe(left, right, pipeConfig(labels, right, started))
	}, labels)
}

// resume carries a session another connector handed over.
func (s *sessionSet) resume(pipe *handover.RestoredPipe) {
	s.carry(func() error {
		return s.registry.ResumePipe(pipe, pipeConfig(pipe.Labels, pipe.Conns[1], nil))
	}, pipe.Labels)
}

// pipeConfig is a session's pipe: it ends with its target (right), and a TLS session the connector carries itself
// passes its state on with a handover.
func pipeConfig(labels handover.Labels, right net.Conn, started func()) handover.PipeConfig {
	config := handover.PipeConfig{Labels: labels, EndWithRight: true, Started: started}
	if session, ok := right.(*relayTLS); ok {
		config.SnapshotLabels = func() handover.Labels { return session.snapshotLabels() }
	}
	return config
}

func (s *sessionSet) carry(run func() error, labels handover.Labels) {
	if errors.Is(run(), handover.ErrHandedOver) && labels[sessionLabelKind] == sessionKindIngress {
		s.mu.Lock()
		s.handedPeers = append(s.handedPeers, securelink.HandoverPeer{Daemon: labels[sessionLabelPeer], Connector: labels[sessionLabelLocal]})
		s.mu.Unlock()
	}
}

// takeHandedPeers returns the peers collected since the last call.
func (s *sessionSet) takeHandedPeers() []securelink.HandoverPeer {
	s.mu.Lock()
	defer s.mu.Unlock()
	peers := s.handedPeers
	s.handedPeers = nil
	return peers
}

func ingressLabels(id string, source net.Conn) handover.Labels {
	labels := handover.Labels{sessionLabelKind: sessionKindIngress, sessionLabelID: id}
	if peer := addressOf(source.RemoteAddr()); peer != "" {
		labels[sessionLabelPeer] = peer
	}
	if local := addressOf(source.LocalAddr()); local != "" {
		labels[sessionLabelLocal] = local
	}
	return labels
}

func egressLabels(id string) handover.Labels {
	return handover.Labels{sessionLabelKind: sessionKindEgress, sessionLabelID: id}
}

// addressOf is a TCP address as the daemon names it ("ip:port", IPv4 unmapped).
func addressOf(address net.Addr) string {
	tcp, ok := address.(*net.TCPAddr)
	if !ok {
		return ""
	}
	ip, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return ""
	}
	return netip.AddrPortFrom(ip.Unmap(), uint16(tcp.Port)).String()
}
