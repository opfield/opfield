package memberha

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
	"time"
)

// Member proxy for direct publication (AS3). The published port of a member
// is served by the daemon; the engine listens only on the set's private
// bridge. A new connection is admitted only while admit() holds (the member
// serves: the promoted holder with a fresh relay gate view naming it, or a
// manual pair's primary), and every proxied session is closed as soon as
// admit() stops holding.

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
	sessions map[*proxySession]struct{}
	closed   bool
	stop     chan struct{}
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

// Start listens and serves until Close.
func (p *Proxy) Start() error {
	listener, err := net.Listen("tcp", p.address)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.listener = listener
	p.mu.Unlock()
	go p.acceptLoop(listener)
	go p.sweepLoop()
	return nil
}

// Addr is the bound address (tests use port 0).
func (p *Proxy) Addr() net.Addr {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.listener == nil {
		return nil
	}
	return p.listener.Addr()
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
			if !p.admit() {
				p.CloseAll()
			}
		}
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
	listener := p.listener
	close(p.stop)
	p.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
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

// AttachProxy serves a member's published port (the daemon supplies the
// address and the dial to the engine on the private bridge).
func (m *Manager) AttachProxy(setID, address string, dial func(ctx context.Context) (net.Conn, error)) error {
	m.mu.Lock()
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
