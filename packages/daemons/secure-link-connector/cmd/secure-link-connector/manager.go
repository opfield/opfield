package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/netaccept"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

const targetDialTimeout = 10 * time.Second

var bindingIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type bindingManager struct {
	mu              sync.Mutex
	bindings        map[string]*bindingListener
	globalSessions  chan struct{}
	perBindingLimit int
	// peer is the address the ingress listeners accept connections from (ingress_peer.go).
	peer   ingressPeer
	closed bool
	// sessions carries every session (sessions.go); the egress manager of the same connector shares it.
	sessions *sessionSet
	// orphans are sessions handed over from a replaced connector whose binding this one does not hold: they go on
	// until they end, and close with the connector.
	orphans map[net.Conn]struct{}
}

type bindingListener struct {
	mu        sync.RWMutex
	config    securelink.BindingConfig
	listener  net.Listener
	sessions  chan struct{}
	activeMu  sync.Mutex
	active    map[net.Conn]struct{}
	done      chan struct{}
	closeOnce sync.Once
	peer      *ingressPeer
	// carrier carries the binding's sessions (the connector's sessionSet).
	carrier *sessionSet
}

func newBindingManager(globalLimit, perBindingLimit int) *bindingManager {
	var globalSessions chan struct{}
	if globalLimit > 0 {
		globalSessions = make(chan struct{}, globalLimit)
	}
	return &bindingManager{
		bindings:        map[string]*bindingListener{},
		globalSessions:  globalSessions,
		perBindingLimit: perBindingLimit,
		sessions:        newSessionSet(),
		orphans:         map[net.Conn]struct{}{},
	}
}

func (m *bindingManager) sync(configs []securelink.BindingConfig) ([]securelink.BindingStatus, error) {
	desired := make(map[string]securelink.BindingConfig, len(configs))
	for _, config := range configs {
		if err := validateBindingConfig(config); err != nil {
			return nil, err
		}
		if _, exists := desired[config.ID]; exists {
			return nil, fmt.Errorf("duplicate secure-link binding %s", config.ID)
		}
		desired[config.ID] = config
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errors.New(securelink.ShuttingDownError)
	}
	for id, config := range desired {
		if current := m.bindings[id]; current != nil {
			if err := current.validateUpdate(config); err != nil {
				return nil, err
			}
		}
	}
	staged := make(map[string]*bindingListener)
	for id, config := range desired {
		if m.bindings[id] != nil {
			continue
		}
		created, err := newBindingListener(config, m.globalSessions, m.perBindingLimit, &m.peer, m.sessions)
		if err != nil {
			for _, binding := range staged {
				binding.close()
			}
			return nil, err
		}
		staged[id] = created
	}
	for id, current := range m.bindings {
		if _, keep := desired[id]; keep {
			continue
		}
		current.close()
		delete(m.bindings, id)
	}
	for id, config := range desired {
		current := m.bindings[id]
		if current == nil {
			m.bindings[id] = staged[id]
			continue
		}
		current.applyUpdate(config)
	}
	statuses := make([]securelink.BindingStatus, 0, len(m.bindings))
	for id, binding := range m.bindings {
		statuses = append(statuses, binding.status(id))
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].ID < statuses[j].ID })
	return statuses, nil
}

// drain stops accepting on every ingress listener of a connector a replacement took over and returns the
// connections still open; they finish on their own. The manager takes no sync after it.
func (m *bindingManager) drain() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	active := 0
	for _, binding := range m.bindings {
		_ = binding.listener.Close()
		binding.activeMu.Lock()
		active += len(binding.active)
		binding.activeMu.Unlock()
	}
	return active
}

func (m *bindingManager) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	m.closed = true
	for id, binding := range m.bindings {
		binding.close()
		delete(m.bindings, id)
	}
	for connection := range m.orphans {
		_ = connection.Close()
	}
}

// active counts the connections of the ingress sessions the connector carries (two per session).
func (m *bindingManager) active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	active := len(m.orphans)
	for _, binding := range m.bindings {
		binding.activeMu.Lock()
		active += len(binding.active)
		binding.activeMu.Unlock()
	}
	return active
}

// adopt carries on an ingress session a replaced connector handed over, in its binding (closed with it), or on its
// own when this connector does not hold the binding.
func (m *bindingManager) adopt(pipe *handover.RestoredPipe) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		pipe.Cut()
		return
	}
	binding := m.bindings[pipe.Labels[sessionLabelID]]
	if binding == nil {
		for _, connection := range pipe.Conns {
			m.orphans[connection] = struct{}{}
		}
	} else {
		for _, connection := range pipe.Conns {
			binding.track(connection, true)
		}
	}
	m.mu.Unlock()
	go func() {
		defer func() {
			if binding != nil {
				for _, connection := range pipe.Conns {
					binding.track(connection, false)
				}
			} else {
				m.mu.Lock()
				for _, connection := range pipe.Conns {
					delete(m.orphans, connection)
				}
				m.mu.Unlock()
			}
			for _, connection := range pipe.Conns {
				_ = connection.Close()
			}
		}()
		m.sessions.resume(pipe)
	}()
}

func validateBindingConfig(config securelink.BindingConfig) error {
	if !bindingIDPattern.MatchString(config.ID) {
		return errors.New("invalid secure-link binding id")
	}
	listen, err := netip.ParseAddr(config.ListenHost)
	if err != nil || listen.IsUnspecified() || listen.IsLoopback() || listen.IsMulticast() {
		return errors.New("invalid secure-link management address")
	}
	target, err := netip.ParseAddr(config.TargetHost)
	if err != nil || target.IsUnspecified() || target.IsLoopback() || target.IsMulticast() {
		return errors.New("invalid secure-link target address")
	}
	if config.TargetPort == 0 {
		return errors.New("invalid secure-link target port")
	}
	return nil
}

func newBindingListener(config securelink.BindingConfig, globalSessions chan struct{}, perBindingLimit int, peer *ingressPeer, carrier *sessionSet) (*bindingListener, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort(config.ListenHost, "0"))
	if err != nil {
		return nil, fmt.Errorf("listen for secure-link binding: %w", err)
	}
	var sessions chan struct{}
	if perBindingLimit > 0 {
		sessions = make(chan struct{}, perBindingLimit)
	}
	binding := &bindingListener{
		config:   config,
		listener: listener,
		sessions: sessions,
		active:   map[net.Conn]struct{}{},
		done:     make(chan struct{}),
		peer:     peer,
		carrier:  carrier,
	}
	go binding.accept(globalSessions)
	return binding, nil
}

func (b *bindingListener) validateUpdate(config securelink.BindingConfig) error {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if config.Generation < b.config.Generation {
		return errors.New("stale secure-link binding generation")
	}
	if config.ListenHost != b.config.ListenHost {
		return errors.New("secure-link management address cannot change in place")
	}
	return nil
}

func (b *bindingListener) applyUpdate(config securelink.BindingConfig) {
	b.mu.Lock()
	b.config = config
	b.mu.Unlock()
}

func (b *bindingListener) status(id string) securelink.BindingStatus {
	b.mu.RLock()
	generation := b.config.Generation
	b.mu.RUnlock()
	address := b.listener.Addr().(*net.TCPAddr)
	return securelink.BindingStatus{ID: id, Generation: generation, Port: uint16(address.Port)}
}

// accept serves the binding until its listener closes. A transient accept error (out of file descriptors) backs off
// and retries: returning left the listener open but never accepting again (B-22).
func (b *bindingListener) accept(globalSessions chan struct{}) {
	var backoff netaccept.Backoff
	for {
		connection, err := b.listener.Accept()
		if err != nil {
			if backoff.Retry(err, b.done) {
				continue
			}
			return
		}
		backoff.Reset()
		if !b.peer.allows(connection.RemoteAddr()) {
			connection.Close()
			continue
		}
		if !acquireSession(globalSessions) {
			connection.Close()
			continue
		}
		if !acquireSession(b.sessions) {
			releaseSession(globalSessions)
			connection.Close()
			continue
		}
		b.track(connection, true)
		started := b.carrier.begin()
		go func() {
			defer func() {
				started()
				b.track(connection, false)
				releaseSession(b.sessions)
				releaseSession(globalSessions)
			}()
			b.proxy(connection, started)
		}()
	}
}

func acquireSession(sessions chan struct{}) bool {
	if sessions == nil {
		return true
	}
	select {
	case sessions <- struct{}{}:
		return true
	default:
		return false
	}
}

func releaseSession(sessions chan struct{}) {
	if sessions != nil {
		<-sessions
	}
}

// proxy carries a session to the binding's target until it ends or a handover passed it on.
func (b *bindingListener) proxy(source net.Conn, started func()) {
	defer source.Close()
	b.mu.RLock()
	targetAddress := net.JoinHostPort(b.config.TargetHost, fmt.Sprintf("%d", b.config.TargetPort))
	id := b.config.ID
	b.mu.RUnlock()
	ctx, cancel := context.WithTimeout(context.Background(), targetDialTimeout)
	defer cancel()
	target, err := (&net.Dialer{}).DialContext(ctx, "tcp", targetAddress)
	if err != nil {
		return
	}
	defer target.Close()
	b.track(target, true)
	defer b.track(target, false)
	b.carrier.pipe(source, target, ingressLabels(id, source), started)
}

func bridge(left, right net.Conn) {
	type copyResult struct {
		fromTarget bool
		err        error
	}
	results := make(chan copyResult, 2)
	copyOne := func(destination, source net.Conn, fromTarget bool) {
		_, err := io.Copy(destination, source)
		if err == nil {
			if closer, ok := destination.(interface{ CloseWrite() error }); ok {
				_ = closer.CloseWrite()
			}
		}
		results <- copyResult{fromTarget: fromTarget, err: err}
	}
	go copyOne(left, right, true)
	go copyOne(right, left, false)
	first := <-results
	if first.err != nil || first.fromTarget {
		left.Close()
		right.Close()
	}
	second := <-results
	if second.err != nil || second.fromTarget {
		left.Close()
		right.Close()
	}
}

func (b *bindingListener) track(connection net.Conn, add bool) {
	b.activeMu.Lock()
	defer b.activeMu.Unlock()
	if add {
		b.active[connection] = struct{}{}
	} else {
		delete(b.active, connection)
	}
}

func (b *bindingListener) close() {
	b.closeOnce.Do(func() {
		close(b.done)
		b.listener.Close()
		b.activeMu.Lock()
		for connection := range b.active {
			connection.Close()
		}
		b.activeMu.Unlock()
	})
}
