package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"sort"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/netaccept"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

// egressSocketName is the daemon's egress socket, next to the control socket in the shared directory
// (egress.sock in the runtime directory of the container).
const egressSocketName = "egress.sock"

// egressOwnerKinds are the links a connector listens for on a link network.
var egressOwnerKinds = map[string]bool{
	"managed_storage_binding":  true,
	"managed_database_binding": true,
	"container_link":           true,
}

// egressManager holds the egress listeners: one per link, on the connector's own address on the link's network.
// Each connection a workload of that network opens is carried through the daemon's egress socket, which looks up the
// link's grant and decides where the connection goes. A listener that fails never affects another.
type egressManager struct {
	socketPath string
	// openRelay opens the relayed stream of a link (openRelayStream; replaced in tests).
	openRelay func(ctx context.Context, socketPath, ownerKind, bindingID string) (net.Conn, error)
	failures  *storageRelayFailureLog
	mu        sync.Mutex
	listeners map[string]*egressListener
	closed    bool
	// sessions carries every session (sessions.go), shared with the ingress bindings of the same connector.
	sessions *sessionSet
	// orphans are sessions handed over from a replaced connector whose listener this one does not hold: they go on
	// until they end, and close with the connector.
	orphans map[net.Conn]struct{}
}

type egressListener struct {
	manager  *egressManager
	listener net.Listener
	mu       sync.Mutex
	config   securelink.EgressConfig
	prefix   netip.Prefix
	tls      *tls.Config
	sessions int
	active   map[net.Conn]struct{}
	closed   bool
}

func newEgressManager(socketPath string) *egressManager {
	return &egressManager{
		socketPath: socketPath,
		openRelay:  openRelayStream,
		failures:   &storageRelayFailureLog{now: time.Now, logf: log.Printf, subject: "link connection"},
		listeners:  map[string]*egressListener{},
		sessions:   newSessionSet(),
		orphans:    map[net.Conn]struct{}{},
	}
}

// sync makes the listeners those of configs. Only a malformed request (two listeners with one id) is refused as a
// whole; every other failure is the status of its own listener.
func (m *egressManager) sync(configs []securelink.EgressConfig) ([]securelink.EgressStatus, error) {
	desired := make(map[string]securelink.EgressConfig, len(configs))
	for _, config := range configs {
		if _, duplicate := desired[config.ID]; duplicate {
			return nil, fmt.Errorf("duplicate secure-link egress %s", config.ID)
		}
		desired[config.ID] = config
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New(securelink.ShuttingDownError)
	}
	var released []*egressListener
	for id, current := range m.listeners {
		if _, keep := desired[id]; !keep {
			released = append(released, current)
			delete(m.listeners, id)
		}
	}
	// A link that moved to another id on the same socket (an Availability placement taking the route over) keeps
	// the listener and the connections it carries.
	for id, config := range desired {
		if m.listeners[id] != nil {
			continue
		}
		for index, previous := range released {
			if previous != nil && previous.sameSocket(config) && previous.currentConfig().OwnerKind == config.OwnerKind {
				// The generation belonged to the previous id's route.
				previous.mu.Lock()
				previous.config.Generation = 0
				previous.mu.Unlock()
				m.listeners[id] = previous
				released[index] = nil
				break
			}
		}
	}
	for _, previous := range released {
		if previous != nil {
			previous.close()
		}
	}
	statuses := make([]securelink.EgressStatus, 0, len(desired))
	for id, config := range desired {
		statuses = append(statuses, m.apply(id, config))
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].ID < statuses[j].ID })
	return statuses, nil
}

// apply brings one listener to config and returns its status. Callers hold m.mu.
func (m *egressManager) apply(id string, config securelink.EgressConfig) securelink.EgressStatus {
	failed := func(err error) securelink.EgressStatus {
		return securelink.EgressStatus{ID: id, Generation: config.Generation, State: securelink.EgressError, Error: err.Error()}
	}
	current := m.listeners[id]
	if current != nil {
		running := current.currentConfig()
		if config.Generation < running.Generation {
			// An older sync arriving late: the listener keeps what it serves.
			status := failed(errors.New("stale secure-link egress generation"))
			status.Generation = running.Generation
			return status
		}
	}
	prefix, tlsConfig, err := validateEgressConfig(config)
	if err != nil {
		if current != nil {
			current.close()
			delete(m.listeners, id)
		}
		return failed(err)
	}
	if current != nil && current.sameSocket(config) {
		current.update(config, prefix, tlsConfig)
		return securelink.EgressStatus{ID: id, Generation: config.Generation, State: securelink.EgressListening}
	}
	if current != nil {
		current.close()
		delete(m.listeners, id)
	}
	listener, err := listenReusePort(net.JoinHostPort(config.ListenHost, fmt.Sprintf("%d", config.ListenPort)))
	if err != nil {
		return failed(fmt.Errorf("listen for secure-link egress: %w", err))
	}
	created := &egressListener{manager: m, listener: listener, config: config, prefix: prefix, tls: tlsConfig, active: map[net.Conn]struct{}{}}
	m.listeners[id] = created
	go netaccept.Serve(listener, nil, created.serve)
	return securelink.EgressStatus{ID: id, Generation: config.Generation, State: securelink.EgressListening}
}

func validateEgressConfig(config securelink.EgressConfig) (netip.Prefix, *tls.Config, error) {
	if !bindingIDPattern.MatchString(config.ID) {
		return netip.Prefix{}, nil, errors.New("invalid secure-link egress id")
	}
	if !egressOwnerKinds[config.OwnerKind] {
		return netip.Prefix{}, nil, errors.New("invalid secure-link egress owner kind")
	}
	listen, err := netip.ParseAddr(config.ListenHost)
	if err != nil || !listen.Is4() || listen.IsUnspecified() || listen.IsLoopback() || listen.IsMulticast() {
		return netip.Prefix{}, nil, errors.New("invalid secure-link egress listen address")
	}
	prefix, err := netip.ParsePrefix(config.AllowedPrefix)
	if err != nil || !prefix.Addr().Is4() || prefix.Bits() < 8 || !prefix.Masked().Contains(listen) {
		return netip.Prefix{}, nil, errors.New("invalid secure-link egress network prefix")
	}
	if config.ListenPort == 0 {
		return netip.Prefix{}, nil, errors.New("invalid secure-link egress port")
	}
	if config.MaxSessions < 0 {
		return netip.Prefix{}, nil, errors.New("invalid secure-link egress session limit")
	}
	if (config.TLSCAPEM == "") != (config.TLSServerName == "") {
		return netip.Prefix{}, nil, errors.New("secure-link egress TLS needs both a CA and a server name")
	}
	tlsConfig, err := relayTLSConfig(config.TLSCAPEM, config.TLSServerName)
	if err != nil {
		return netip.Prefix{}, nil, err
	}
	return prefix.Masked(), tlsConfig, nil
}

// drain stops accepting on every egress listener (a replacement listens on the same addresses) and returns the
// sessions still open; they finish on their own. The manager takes no sync after it.
func (m *egressManager) drain() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for _, listener := range m.listeners {
		_ = listener.listener.Close()
	}
	return m.activeLocked()
}

// active counts the egress sessions the connector carries.
func (m *egressManager) active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activeLocked()
}

func (m *egressManager) activeLocked() int {
	active := len(m.orphans) / 2
	for _, listener := range m.listeners {
		listener.mu.Lock()
		active += listener.sessions
		listener.mu.Unlock()
	}
	return active
}

func (m *egressManager) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for id, listener := range m.listeners {
		listener.close()
		delete(m.listeners, id)
	}
	for connection := range m.orphans {
		_ = connection.Close()
	}
}

// adopt carries on an egress session a replaced connector handed over, in its listener (counted, and closed with it),
// or on its own when this connector does not hold the listener.
func (m *egressManager) adopt(pipe *handover.RestoredPipe) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		pipe.Cut()
		return
	}
	listener := m.listeners[pipe.Labels[sessionLabelID]]
	if listener != nil && !listener.adopt(pipe.Conns) {
		listener = nil
	}
	if listener == nil {
		for _, connection := range pipe.Conns {
			m.orphans[connection] = struct{}{}
		}
	}
	m.mu.Unlock()
	go func() {
		relayed := pipe.Conns[1]
		defer func() {
			if listener != nil {
				listener.release(pipe.Conns[0])
				listener.track(relayed, false)
			} else {
				m.mu.Lock()
				delete(m.orphans, pipe.Conns[0])
				delete(m.orphans, relayed)
				m.mu.Unlock()
			}
			for _, connection := range pipe.Conns {
				_ = connection.Close()
			}
		}()
		if encoded := pipe.Labels[sessionLabelTLS]; encoded != "" {
			// A TLS session the replaced connector carried itself: its records go on from its state, the ones it wrote
			// in part first.
			session, err := restoreRelayTLS(relayed, encoded)
			if err == nil {
				err = session.flushHandedOver(30 * time.Second)
			}
			if err != nil {
				log.Printf("a handed over TLS session could not be carried on: %v", err)
				pipe.Cut()
				return
			}
			pipe.Conns[1] = session
		}
		m.sessions.resume(pipe)
	}()
}

func (l *egressListener) currentConfig() securelink.EgressConfig {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.config
}

// sameSocket reports a config the running listening socket serves: the same address and port.
func (l *egressListener) sameSocket(config securelink.EgressConfig) bool {
	current := l.currentConfig()
	return current.ListenHost == config.ListenHost && current.ListenPort == config.ListenPort
}

// update applies a config of the same socket in place: the connections it opens from now on follow it.
func (l *egressListener) update(config securelink.EgressConfig, prefix netip.Prefix, tlsConfig *tls.Config) {
	l.mu.Lock()
	l.config, l.prefix, l.tls = config, prefix, tlsConfig
	l.mu.Unlock()
}

// peerAllowed reports a peer inside the link network, other than the network's gateway: that address is the host
// itself, and a host process is no workload of the link.
func peerAllowed(prefix netip.Prefix, remote net.Addr) bool {
	tcp, ok := remote.(*net.TCPAddr)
	if !ok {
		return false
	}
	address, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return false
	}
	address = address.Unmap()
	return prefix.Contains(address) && address != prefix.Addr() && address != prefix.Addr().Next()
}

// acquire admits a new connection of a workload: from the link network, within the session limit. A refusal names
// its reason (none for a closed listener).
func (l *egressListener) acquire(connection net.Conn) (securelink.EgressConfig, *tls.Config, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return securelink.EgressConfig{}, nil, false, nil
	}
	if !peerAllowed(l.prefix, connection.RemoteAddr()) {
		return securelink.EgressConfig{}, nil, false, fmt.Errorf("link %s: a peer outside the link network was refused", l.config.ID)
	}
	if l.config.MaxSessions > 0 && l.sessions >= l.config.MaxSessions {
		return securelink.EgressConfig{}, nil, false, fmt.Errorf("link %s: the listener carries its %d concurrent connections", l.config.ID, l.config.MaxSessions)
	}
	l.sessions++
	l.active[connection] = struct{}{}
	return l.config, l.tls, true, nil
}

// adopt counts a session handed over from a replaced connector (its workload's connection and its relayed side), past
// the session limit if need be: it was admitted already.
func (l *egressListener) adopt(connections [2]net.Conn) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.sessions++
	l.active[connections[0]] = struct{}{}
	l.active[connections[1]] = struct{}{}
	return true
}

func (l *egressListener) release(connection net.Conn) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, tracked := l.active[connection]; tracked {
		delete(l.active, connection)
		l.sessions--
	}
}

// track adds or removes the relayed side of a session, which a closing listener closes too.
func (l *egressListener) track(connection net.Conn, add bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if add {
		if l.closed {
			return false
		}
		l.active[connection] = struct{}{}
	} else {
		delete(l.active, connection)
	}
	return true
}

func (l *egressListener) serve(local net.Conn) {
	defer local.Close()
	started := l.manager.sessions.begin()
	defer started()
	config, tlsConfig, admitted, refusal := l.acquire(local)
	if !admitted {
		// Logged like a relay refusal, once per reason and interval: the connection never reaches the daemon.
		if refusal != nil {
			l.manager.failures.record(refusal)
		}
		return
	}
	defer l.release(local)
	ctx, cancel := context.WithTimeout(context.Background(), targetDialTimeout)
	remote, err := l.manager.openRelay(ctx, l.manager.socketPath, config.OwnerKind, config.ID)
	cancel()
	if err != nil {
		l.manager.failures.record(fmt.Errorf("link %s: %w", config.ID, err))
		return
	}
	defer remote.Close()
	if !l.track(remote, true) {
		return
	}
	defer l.track(remote, false)
	remote, err = clientTLS(context.Background(), remote, tlsConfig, true)
	if err != nil {
		l.manager.failures.record(fmt.Errorf("link %s: TLS: %w", config.ID, err))
		return
	}
	// A session whose TLS the connector originates moves with its record state (tls_relay.go), unless crypto/tls
	// carries it (TLS 1.2, ChaCha20): a handover leaves that one out.
	l.manager.sessions.pipe(local, remote, egressLabels(config.ID), started)
}

func (l *egressListener) close() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	connections := make([]net.Conn, 0, len(l.active))
	for connection := range l.active {
		connections = append(connections, connection)
	}
	l.mu.Unlock()
	_ = l.listener.Close()
	for _, connection := range connections {
		_ = connection.Close()
	}
}
