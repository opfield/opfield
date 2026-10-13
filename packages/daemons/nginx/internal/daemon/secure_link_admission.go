package daemon

import (
	"errors"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/logepisode"
)

// secureLinkSetupLimit bounds the connections of one listener manager that
// were accepted but have not reached their relay tunnel yet (authorizing,
// waiting for a lane, opening the tunnel). Established connections do not
// count: nginx bounds those itself.
const secureLinkSetupLimit = 1024

// secureLinkSetupLinkLimit is one link's share of those slots. A connection of
// a link whose target is down holds its slot through the relay retries for
// seconds: without a share, one such link under load shed the connections of
// every other link of the node.
const secureLinkSetupLinkLimit = secureLinkSetupLimit / 4

const (
	// secureLinkAuthorizeTimeout bounds a peer check.
	secureLinkAuthorizeTimeout = 2 * time.Second
	// secureLinkFirstByteWait bounds the wait for a connection's first bytes
	// before it is handed on anyway (a peer that speaks second).
	secureLinkFirstByteWait = 2 * time.Second
)

// setupLimiter is a non-blocking counting limiter.
type setupLimiter struct {
	inFlight atomic.Int64
	// limit overrides secureLinkSetupLimit when positive (tests).
	limit atomic.Int64
}

func (l *setupLimiter) tryAcquire() bool {
	return l.tryAcquireUpTo(secureLinkSetupLimit)
}

// tryAcquireUpTo is tryAcquire with defaultLimit in place of secureLinkSetupLimit.
func (l *setupLimiter) tryAcquireUpTo(defaultLimit int64) bool {
	limit := l.limit.Load()
	if limit <= 0 {
		limit = defaultLimit
	}
	if l.inFlight.Add(1) > limit {
		l.inFlight.Add(-1)
		return false
	}
	return true
}

func (l *setupLimiter) release() {
	l.inFlight.Add(-1)
}

// releaseOnce returns a function that releases one acquired slot, once.
func (l *setupLimiter) releaseOnce() func() {
	var once sync.Once
	return func() { once.Do(l.release) }
}

// admitSetup takes a setup slot of the node and one of the link for a new connection of binding. A connection over
// either limit is closed at once (nginx sees a fast upstream error), counted and reported to shedLog.
func (m *sourceLinkManager) admitSetup(id string, binding *sourceLinkBinding, connection net.Conn) bool {
	scope := ""
	switch {
	case !m.setup.tryAcquire():
		scope = "node"
	case !binding.setup.tryAcquireUpTo(secureLinkSetupLinkLimit):
		m.setup.release()
		scope = "link"
	default:
		return true
	}
	total := m.shed.Add(1)
	_ = connection.Close()
	if m.shedLog != nil {
		m.shedLog(id, "stage", "setup_limit", "limit", scope, "shed_total", total)
	}
	return false
}

// secureLinkShedLog reports the connections of a link that the setup limit closed with the link's other outcomes
// (openSecureLink): one line when the link starts failing, then a summary while it goes on (L-1).
func (p *NginxPlugin) secureLinkShedLog(logName string) func(string, ...any) {
	return func(linkID string, attrs ...any) {
		p.secureLinkOutcomes.Failed(p.logger, logepisode.Subject{Name: logName + " connections", IDAttr: "link_id", ID: linkID},
			append(attrs, "error", "setup limit reached")...)
	}
}

// secureLinkEstablished tells the accept side that a connection reached its
// relay tunnel: it no longer counts against the setup limit, and a stopping
// daemon no longer waits for it to get there (HandOverSecureLinks).
func secureLinkEstablished(connection net.Conn) {
	tracked, ok := connection.(*trackedConn)
	if !ok {
		return
	}
	tracked.opened.Store(true)
	if tracked.established != nil {
		tracked.established()
	}
}

// awaitFirstBytes waits up to wait for the peer's first bytes and keeps them
// for the opener. It reports false when the peer closed or failed before
// sending anything; a peer that sends nothing within wait is handed on.
func awaitFirstBytes(connection *trackedConn, wait time.Duration) bool {
	if err := connection.Conn.SetReadDeadline(time.Now().Add(wait)); err != nil {
		return true
	}
	buffer := make([]byte, 4096)
	n, err := connection.Conn.Read(buffer)
	_ = connection.Conn.SetReadDeadline(time.Time{})
	if n > 0 {
		connection.pending = buffer[:n]
		connection.lastRead.Store(time.Now().UnixNano())
		return true
	}
	return err != nil && errors.Is(err, os.ErrDeadlineExceeded)
}
