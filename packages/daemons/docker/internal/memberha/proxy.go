package memberha

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
)

// Member proxy for direct publication (AS3). The published port of a member
// is served by the daemon; the engine listens only on the set's private
// bridge. The port listens only while admit() holds (the member serves: the
// promoted holder with a fresh relay gate view naming it, or a manual pair's
// primary): a member that does not serve has no listener at all, so a client
// with several hosts (libpq target_session_attrs, Redis and S3 clients) gets
// connection refused and moves to the next host at once. Copies never take
// clients. Every proxied session is closed as soon as admit() stops holding.

const (
	proxySweepInterval = 100 * time.Millisecond
	proxyDialTimeout   = 5 * time.Second
)

// Proxy is one member's published port.
type Proxy struct {
	address string
	admit   func() bool
	dial    func(ctx context.Context) (net.Conn, error)
	logger  *slog.Logger

	mu       sync.Mutex
	listener net.Listener
	// bound is the address the port was first bound to (port 0 resolved), so
	// it listens on the same port again after a member regained the role.
	bound      net.Addr
	bindFailed bool
	sessions   map[*proxySession]struct{}
	closed     bool
	stop       chan struct{}
}

type proxySession struct {
	client, upstream net.Conn
	once             sync.Once
}

func (s *proxySession) close() {
	s.once.Do(func() {
		_ = s.client.Close()
		if s.upstream != nil {
			_ = s.upstream.Close()
		}
	})
}

// NewProxy prepares a proxy; Start binds it.
func NewProxy(address string, admit func() bool, dial func(ctx context.Context) (net.Conn, error), logger *slog.Logger) *Proxy {
	if logger == nil {
		logger = slog.Default()
	}
	return &Proxy{address: address, admit: admit, dial: dial, logger: logger, sessions: map[*proxySession]struct{}{},
		stop: make(chan struct{})}
}

// Start binds the port once (a port taken by something else is an error
// here) and serves until Close: it listens while the member serves and is
// closed while it does not.
func (p *Proxy) Start() error {
	p.mu.Lock()
	err := p.listenLocked()
	if err == nil && !p.admit() {
		p.unlistenLocked()
	}
	p.mu.Unlock()
	if err != nil {
		return err
	}
	go p.sweepLoop()
	return nil
}

// listenLocked opens the port when it is not open.
func (p *Proxy) listenLocked() error {
	if p.listener != nil || p.closed {
		return nil
	}
	address := p.address
	if p.bound != nil {
		address = p.bound.String()
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	p.listener = listener
	if p.bound == nil {
		p.bound = listener.Addr()
	}
	go p.acceptLoop(listener)
	return nil
}

// unlistenLocked closes the port: new connections are refused by the kernel.
func (p *Proxy) unlistenLocked() {
	if p.listener != nil {
		_ = p.listener.Close()
		p.listener = nil
	}
}

// Listening reports whether the port accepts connections now.
func (p *Proxy) Listening() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.listener != nil
}

// Addr is the bound address (tests use port 0); it stays the same while the
// port is closed.
func (p *Proxy) Addr() net.Addr {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.bound
}

func (p *Proxy) acceptLoop(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			p.logger.Debug("availability member proxy accept failed", "error", err)
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go p.serve(conn)
	}
}

func (p *Proxy) serve(client net.Conn) {
	if !p.admit() {
		// Refused at once: a multi-host client moves to the next host.
		_ = client.Close()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), proxyDialTimeout)
	upstream, err := p.dial(ctx)
	cancel()
	if err != nil {
		_ = client.Close()
		return
	}
	session := &proxySession{client: client, upstream: upstream}
	p.mu.Lock()
	if p.closed || !p.admit() {
		p.mu.Unlock()
		session.close()
		return
	}
	p.sessions[session] = struct{}{}
	p.mu.Unlock()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
	session.close()
	p.mu.Lock()
	delete(p.sessions, session)
	p.mu.Unlock()
}

func (p *Proxy) sweepLoop() {
	ticker := time.NewTicker(proxySweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-ticker.C:
			p.Sync()
		}
	}
}

// Sync makes the port follow the member's admission now (the sweep runs it
// every proxySweepInterval): listening while it serves, closed with every
// session ended while it does not.
func (p *Proxy) Sync() {
	admitted := p.admit()
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	if !admitted {
		p.unlistenLocked()
		p.mu.Unlock()
		p.CloseAll()
		return
	}
	err := p.listenLocked()
	failedBefore := p.bindFailed
	p.bindFailed = err != nil
	address := p.address
	p.mu.Unlock()
	if err != nil && !failedBefore {
		p.logger.Warn("availability member proxy could not listen on the published port; retrying", "address", address, "error", err)
	}
}

// Sessions is the number of open proxied sessions.
func (p *Proxy) Sessions() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.sessions)
}

// CloseAll ends every proxied session.
func (p *Proxy) CloseAll() {
	p.mu.Lock()
	sessions := make([]*proxySession, 0, len(p.sessions))
	for session := range p.sessions {
		sessions = append(sessions, session)
	}
	p.mu.Unlock()
	for _, session := range sessions {
		session.close()
	}
}

// Close stops listening and ends every session.
func (p *Proxy) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.unlistenLocked()
	close(p.stop)
	p.mu.Unlock()
	p.CloseAll()
}

// ProxyAdmits is the member proxy's admission (AS3). Automatic mode: the
// member serves (its promotion is certified), holds with MayStart, and a
// fresh relay gate view names this node the holder; before the set's lease
// runs, the member that serves the single-node resource. Manual mode: the
// assigned primary while it serves.
func (m *Manager) ProxyAdmits(setID string) bool {
	m.mu.Lock()
	mem := m.members[setID]
	m.mu.Unlock()
	if mem == nil {
		return false
	}
	if mem.legacy.Load() {
		return true
	}
	if !mem.serving.Load() {
		return false
	}
	if mem.cfg.Mode == ModeManual {
		return true
	}
	status := m.deps.Lease.HolderStatus(mem.cfg.Key())
	if status.Role == RoleRetained {
		return true
	}
	if status.Role != RoleHolding || !status.MayStart {
		return false
	}
	return m.deps.Gates == nil || m.deps.Gates.OpenFor(mem.cfg.LeasePolicyID, mem.cfg.NodeID, m.deps.Clock.Wall())
}

// errUnpublished: the set's published ports belong to the single node the
// member turns back into (ReleasePublished).
var errUnpublished = errors.New("the set's published ports were handed back to the single node")

// ReleasePublished hands the set's published ports back to the single node
// the member turns into (a lift or a revert): every member proxy of the set
// stops listening, none attaches again until the member is forgotten or
// RestorePublished, and it returns once each address can be bound again (or
// ctx ends), so the single-node container can publish the same ports. It is
// idempotent and works the same after a daemon restart (the restarted member
// runtime attached its proxies again; a repeated lift releases them).
func (m *Manager) ReleasePublished(ctx context.Context, setID string) error {
	m.mu.Lock()
	m.unpublished[setID] = true
	addresses := []string{}
	for key, proxy := range m.proxies {
		if key == setID || strings.HasPrefix(key, setID+"/") {
			addresses = append(addresses, proxy.address)
			proxy.Close()
			delete(m.proxies, key)
		}
	}
	m.mu.Unlock()
	for _, address := range addresses {
		if err := waitPortFree(ctx, address); err != nil {
			return err
		}
	}
	return nil
}

// RestorePublished lets the set's member proxies attach again (a lift that
// failed: the member keeps serving as a member).
func (m *Manager) RestorePublished(setID string) {
	m.mu.Lock()
	delete(m.unpublished, setID)
	m.mu.Unlock()
}

// waitPortFree returns once address can be bound (it is closed again at
// once).
func waitPortFree(ctx context.Context, address string) error {
	for {
		listener, err := net.Listen("tcp", address)
		if err == nil {
			_ = listener.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the member proxy's port %s is still in use: %w", address, err)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// AttachProxy serves a member's published port (the daemon supplies the
// address and the dial to the engine on the private bridge).
func (m *Manager) AttachProxy(setID, address string, dial func(ctx context.Context) (net.Conn, error)) error {
	m.mu.Lock()
	if m.unpublished[setID] {
		m.mu.Unlock()
		return errUnpublished
	}
	if existing := m.proxies[setID]; existing != nil {
		m.mu.Unlock()
		if existing.address == address {
			return nil
		}
		existing.Close()
		m.mu.Lock()
	}
	proxy := NewProxy(address, func() bool { return m.ProxyAdmits(setID) }, dial, m.logger)
	m.proxies[setID] = proxy
	m.mu.Unlock()
	if err := proxy.Start(); err != nil {
		m.mu.Lock()
		delete(m.proxies, setID)
		m.mu.Unlock()
		return err
	}
	return nil
}

// DetachProxy stops a member's published port.
func (m *Manager) DetachProxy(setID string) {
	m.mu.Lock()
	proxy := m.proxies[setID]
	delete(m.proxies, setID)
	m.mu.Unlock()
	if proxy != nil {
		proxy.Close()
	}
}

// proxyKey names one of a set's published ports ("" is AttachProxy's).
func proxyKey(setID, name string) string {
	if name == "" {
		return setID
	}
	return setID + "/" + name
}

// AttachProxyPort serves one of several published ports of a member (an
// engine with more than one client protocol, e.g. ClickHouse HTTP and
// native). Admission is the member's (ProxyAdmits); a session of a port
// whose member stops serving is closed by the proxy's sweep.
func (m *Manager) AttachProxyPort(setID, name, address string, dial func(ctx context.Context) (net.Conn, error)) error {
	key := proxyKey(setID, name)
	m.mu.Lock()
	if m.unpublished[setID] {
		m.mu.Unlock()
		return errUnpublished
	}
	if existing := m.proxies[key]; existing != nil {
		m.mu.Unlock()
		if existing.address == address {
			return nil
		}
		existing.Close()
		m.mu.Lock()
	}
	proxy := NewProxy(address, func() bool { return m.ProxyAdmits(setID) }, dial, m.logger)
	m.proxies[key] = proxy
	m.mu.Unlock()
	if err := proxy.Start(); err != nil {
		m.mu.Lock()
		if m.proxies[key] == proxy {
			delete(m.proxies, key)
		}
		m.mu.Unlock()
		return err
	}
	return nil
}

// DetachProxyPort stops one named published port of a member.
func (m *Manager) DetachProxyPort(setID, name string) {
	key := proxyKey(setID, name)
	m.mu.Lock()
	proxy := m.proxies[key]
	delete(m.proxies, key)
	m.mu.Unlock()
	if proxy != nil {
		proxy.Close()
	}
}
