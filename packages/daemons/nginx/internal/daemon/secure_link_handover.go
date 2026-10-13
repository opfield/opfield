package daemon

import (
	"net"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
)

// A restart or update of the nginx daemon hands its Secure Link sockets over
// to the next daemon process instead of closing them (B-13). The listener
// keeper (the daemon launcher, and systemd's file descriptor store) holds a
// copy of every listening socket, so the socket keeps accepting connections
// into its backlog while no daemon process runs; the next process adopts it
// and serves them.
//
// The next process can only start once this one exited (systemctl restart
// stops the unit before it starts it again), so the stopping process keeps
// accepting while it lets the requests it serves finish. It stops accepting
// only at the end, gives the requests it accepted last a short moment, and
// exits: a new connection waits in the backlog for the restart itself, not for
// the drain as well (1.7 s and two client timeouts at 50 rps).
//
// Until the sockets are handed over, a connection that sits idle between
// requests stays open: nginx reuses it, and this process serves it. Ending it
// gains nothing, since nginx's next connection reaches this process as well,
// and a connection ended at the moment nginx takes it from its keep-alive pool
// fails the request sent on it. nginx retries such a request on the next
// member of an Availability upstream, which lists every member twice (once as
// a backup) and tries each entry once: with the other member down, the retry
// takes the next pooled connection to the same socket, ended in the same pass,
// and the request fails with a 502. Ending idle connections on every tick of
// the restart hold (up to 8 s) did exactly that.
//
// Once the sockets are handed over, a connection is closed as soon as it
// answered and stayed silent briefly: nginx sends its next request on it only
// after the whole answer, and under load it does so faster than the idle quiet,
// so its connections stayed open until the exit cut them. A connection cut
// that way while it sits in nginx's keep-alive pool fails the retry of a
// request cut with it at once, and nginx tries each member of an Availability
// upstream (all of them sockets of this daemon) once per request: a 502.
// Ending them can still meet a request nginx sends at that moment, so a drain
// pass ends one per socket, the one silent longest: nginx takes the connection
// it pooled last first, a request meets at most one ended connection to a
// socket, and its retry gets a live one or a new connection that waits for the
// next process.
//
// A connection that has not reached its relay tunnel yet (its opener holds it
// because the target's daemon announced a restart, or a relay or the target is
// not back yet, or the relay has not answered the tunnel yet) has sent nothing
// to nginx, and nginx does not retry a single upstream: cutting it is a 502.
// The handover therefore waits for such connections to reach their target,
// serving and accepting meanwhile, up to the restart hold. A Route whose node
// restarts while this daemon updates (Update Nodes) is served once the node
// registered again instead of failing on this process's exit.
//
// A drain ends a connection with a shutdown, not a close: nginx sees it end at
// once, and the opener closes it when its tunnel ended. A close waits for the
// goroutines reading and writing the connection to let go of it, and a busy
// daemon on one CPU runs them tens of milliseconds later each: a drain pass
// closing a handful of connections took 0.1 s, and the bounded wait after the
// handover took 0.5-1 s instead of 0.3 s while new connections waited in the
// backlog.

const (
	// secureLinkHandoverDrain bounds how long a stopping daemon keeps serving
	// and accepting while the requests in flight finish.
	secureLinkHandoverDrain = 1500 * time.Millisecond
	// secureLinkHandoverFinish bounds the wait for the requests accepted just
	// before the sockets were handed over; new connections queue meanwhile.
	secureLinkHandoverFinish = 300 * time.Millisecond
	// secureLinkIdleQuiet is how long a served connection must have carried no
	// byte, with no request left unanswered, to count as idle between
	// requests.
	secureLinkIdleQuiet = 100 * time.Millisecond
	// secureLinkFinishQuiet is that silence once the sockets were handed over:
	// nginx is next to the socket, so a request it sends on the connection
	// arrives at once, and the silence only has to outlast a pause inside an
	// answer that arrives in several parts.
	secureLinkFinishQuiet = 25 * time.Millisecond
	secureLinkDrainTick   = 20 * time.Millisecond
)

// trackedConn records when bytes last moved in each direction, so a stopping
// daemon can tell a connection serving a request from one idle between
// requests.
type trackedConn struct {
	net.Conn
	accepted  int64
	lastRead  atomic.Int64
	lastWrite atomic.Int64
	// opened is set once the connection reached its relay tunnel
	// (secureLinkEstablished).
	opened atomic.Bool
	// ended is set once a drain ended the connection; its opener closes it.
	ended atomic.Bool
	// pending holds bytes read before the opener took over (awaitFirstBytes).
	pending []byte
	// established releases the connection's setup slot (secureLinkEstablished).
	established func()
	// resumable: the connection runs over a resumable stream, which an update
	// hands to the next process; handedOver: the next process carries it, so
	// nothing here ends it (live_handover.go).
	resumable  atomic.Bool
	handedOver atomic.Bool
	// loopback: accepted on a loopback TCP endpoint, so closing it resets it
	// unless graceful says it ended normally (secure_link_loopback.go).
	loopback atomic.Bool
	graceful atomic.Bool
}

func newTrackedConn(connection net.Conn) net.Conn {
	return &trackedConn{Conn: connection, accepted: time.Now().UnixNano()}
}

func (c *trackedConn) Read(buffer []byte) (int, error) {
	if len(c.pending) > 0 {
		n := copy(buffer, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	n, err := c.Conn.Read(buffer)
	if n > 0 {
		c.lastRead.Store(time.Now().UnixNano())
	}
	if err != nil {
		c.readEnded(err)
	}
	return n, err
}

func (c *trackedConn) Write(buffer []byte) (int, error) {
	n, err := c.Conn.Write(buffer)
	if n > 0 {
		c.lastWrite.Store(time.Now().UnixNano())
	}
	return n, err
}

// CloseWrite passes a relay half-close on to nginx.
func (c *trackedConn) CloseWrite() error {
	// The response ended normally: nginx reads its end, never a reset.
	c.markGraceful()
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

// end ends the connection for its peer at once, without waiting for the
// goroutines serving it: they see it end and close it. A connection the next
// process carries is not this one's to end.
func (c *trackedConn) end() {
	if c.handedOver.Load() {
		return
	}
	// An idle keep-alive connection let go: a normal end.
	c.markGraceful()
	if connection, ok := c.Conn.(interface {
		CloseRead() error
		CloseWrite() error
	}); ok {
		_ = connection.CloseWrite()
		_ = connection.CloseRead()
		return
	}
	_ = c.Conn.Close()
}

// idle reports a connection that answered its last request and carried no
// byte for quiet: nginx keeps it for its next request. A connection not served
// yet, or with a request read after the last answer, or still moving bytes,
// is busy.
func (c *trackedConn) idle(now time.Time, quiet time.Duration) bool {
	read, write := c.lastRead.Load(), c.lastWrite.Load()
	if write == 0 || read > write {
		return false
	}
	return now.UnixNano()-write >= quiet.Nanoseconds()
}

// keptListeners counts the Unix listeners this process kept for its
// successor.
func (m *sourceLinkManager) keptListeners() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	bindings := make([]*sourceLinkBinding, 0, len(m.bindings))
	for _, binding := range m.bindings {
		bindings = append(bindings, binding)
	}
	m.mu.Unlock()
	kept := 0
	for _, binding := range bindings {
		binding.leaseMu.Lock()
		if binding.unix != nil && binding.keptName != "" {
			kept++
		}
		if binding.loop != nil && binding.loopKept != "" {
			kept++
		}
		binding.leaseMu.Unlock()
	}
	return kept
}

// suspendForHandover stops accepting on every Unix listener this process kept
// for its successor, without closing the sockets themselves, and reports how
// many it handed over. Listeners that are not kept keep accepting: closing
// them would only refuse connections earlier. Nothing creates a socket at a
// path afterwards (listenUnixSocket), so the successor finds the kept ones.
func (m *sourceLinkManager) suspendForHandover() int {
	if m == nil {
		return 0
	}
	m.suspended.Store(true)
	m.mu.Lock()
	bindings := make([]*sourceLinkBinding, 0, len(m.bindings))
	for _, binding := range m.bindings {
		bindings = append(bindings, binding)
	}
	m.mu.Unlock()
	handed := 0
	for _, binding := range bindings {
		binding.leaseMu.Lock()
		if binding.unix != nil && binding.keptName != "" {
			if unixListener, ok := binding.unix.(*net.UnixListener); ok {
				unixListener.SetUnlinkOnClose(false)
			}
			// Only this process's descriptor closes; the keeper's copies keep
			// the socket, and its backlog, alive for the successor.
			_ = binding.unix.Close()
			binding.unix = nil
			handed++
		}
		if binding.loop != nil && binding.loopKept != "" {
			// Same for the loopback endpoint: the keeper's copy listens on.
			binding.closeLoopbackLocked(true)
			handed++
		}
		binding.leaseMu.Unlock()
	}
	return handed
}

// drainEnds tells what a drain does with a connection that answered and
// carried no byte for its quiet.
type drainEnds int

const (
	// endNone leaves it to nginx: before the handover nginx reuses it.
	endNone drainEnds = iota
	// endOldest ends, per socket and pass, the one silent longest.
	endOldest
	// endAll ends every one: the last pass before the exit.
	endAll
)

// drainForHandover waits, up to limit, for the requests this process is
// serving, and ends the connections that answered and carried no byte for
// quiet as ends tells. The connections skip selects are neither waited for
// nor ended (an update hands them over).
func (m *sourceLinkManager) drainForHandover(limit, quiet time.Duration, ends drainEnds, skip func(*trackedConn) bool) {
	if m == nil {
		return
	}
	deadline := time.Now().Add(limit)
	for {
		now := time.Now()
		waiting := 0
		m.mu.Lock()
		bindings := make([]*sourceLinkBinding, 0, len(m.bindings))
		for _, binding := range m.bindings {
			bindings = append(bindings, binding)
		}
		m.mu.Unlock()
		for _, binding := range bindings {
			binding.activeMu.Lock()
			var oldest *trackedConn
			for connection := range binding.active {
				tracked, ok := connection.(*trackedConn)
				if !ok {
					waiting++
					continue
				}
				if tracked.ended.Load() || (skip != nil && skip(tracked)) {
					continue
				}
				if !tracked.idle(now, quiet) {
					waiting++
					continue
				}
				switch ends {
				case endAll:
					tracked.ended.Store(true)
					tracked.end()
				case endOldest:
					// The others wait for a later pass.
					if oldest != nil {
						waiting++
						if tracked.lastWrite.Load() >= oldest.lastWrite.Load() {
							continue
						}
					}
					oldest = tracked
				}
			}
			if oldest != nil {
				oldest.ended.Store(true)
				oldest.end()
			}
			binding.activeMu.Unlock()
		}
		if waiting == 0 || !now.Before(deadline) {
			return
		}
		time.Sleep(secureLinkDrainTick)
	}
}

// opening counts the connections that have not reached their relay tunnel
// yet: their opener holds them for their target or sets the tunnel up.
func (m *sourceLinkManager) opening() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	bindings := make([]*sourceLinkBinding, 0, len(m.bindings))
	for _, binding := range m.bindings {
		bindings = append(bindings, binding)
	}
	m.mu.Unlock()
	opening := 0
	for _, binding := range bindings {
		binding.activeMu.Lock()
		for connection := range binding.active {
			if tracked, ok := connection.(*trackedConn); ok && !tracked.opened.Load() {
				opening++
			}
		}
		binding.activeMu.Unlock()
	}
	return opening
}

// HandOverSecureLinks runs when the daemon is asked to stop or exits for an
// update, before it disconnects from Opfield and the relays: the requests in
// flight finish on this process, which keeps accepting meanwhile, and then the
// Secure Link sockets go to the next daemon process. Without a listener keeper
// nothing changes: the sockets close with the process.
func (p *NginxPlugin) HandOverSecureLinks() {
	if p.relayStreams != nil {
		// What the stop or update ends from here on is its cut.
		p.relayStreams.BeginExit()
	}
	p.handoverOnce.Do(func() {
		if p.secureLinks.keptListeners()+p.registryLinks.keptListeners() == 0 {
			return
		}
		started := time.Now()
		// An update hands the resumable streams to the next process (live_handover.go): the drain neither waits
		// for them nor ends them.
		handingOver := exitingForUpdate() && handover.HandsOverNow(handoverKeeper)
		resumable := func(connection *trackedConn) bool { return handingOver && connection.resumable.Load() }
		drain := func(limit, quiet time.Duration, ends drainEnds, skip func(*trackedConn) bool) {
			done := make(chan struct{})
			go func() {
				p.registryLinks.drainForHandover(limit, quiet, ends, skip)
				close(done)
			}()
			p.secureLinks.drainForHandover(limit, quiet, ends, skip)
			<-done
		}
		drain(secureLinkHandoverDrain, secureLinkIdleQuiet, endNone, resumable)
		// The connections that have not reached their target yet get it once
		// it is back (its daemon registers again within a few seconds of a
		// restart) or the relay answered, and are answered by this process;
		// cutting them would fail their requests.
		for p.secureLinks.opening()+p.registryLinks.opening() > 0 && time.Since(started) < secureLinkRestartHold {
			time.Sleep(secureLinkDrainTick)
		}
		handed := p.secureLinks.suspendForHandover() + p.registryLinks.suspendForHandover()
		if p.logger != nil {
			p.logger.Info("handing Secure Link sockets over to the next daemon process", "sockets", handed)
		}
		result := p.handOverConnections()
		// What the update cuts is counted now: the drains below close it.
		cuts := p.updateCutsNow()
		drain(secureLinkHandoverFinish, secureLinkFinishQuiet, endOldest, nil)
		// The exit cuts what is still open. The connections that answered are
		// closed a tick before it, so nginx drops them from its keep-alive pool
		// and the retries of the requests the exit cuts open new connections,
		// which wait for the next process.
		drain(secureLinkDrainTick, 0, endAll, nil)
		p.recordUpdateConnections(started, result, cuts)
	})
}

// AnnounceRestart implements lifecycle.RestartAnnouncerPlugin: a daemon that
// exits for its staged update hands its sockets over the same way.
func (p *NginxPlugin) AnnounceRestart() {
	p.HandOverSecureLinks()
}
