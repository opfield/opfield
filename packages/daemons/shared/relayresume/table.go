package relayresume

import (
	crand "crypto/rand"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// TargetKey names a target session: the relay-vouched route and source of
// the tunnel (IncomingTunnel.route) and the source's session id.
type TargetKey struct {
	RouteID    string
	SourceKind string
	SourceID   string
	SessionID  [SessionIDLen]byte
}

type tombstone struct {
	reject  byte
	expires time.Time
}

// TargetTable holds a process's target sessions and their tombstones.
type TargetTable struct {
	budget *WindowBudget
	nonce  [NonceLen]byte

	mu        sync.Mutex
	sessions  map[TargetKey]*Session
	tombs     map[TargetKey]tombstone
	lastSweep time.Time

	refused atomic.Uint64
	// handedOver: this process handed its streams to the next one (live
	// handover); a RESUME that reaches it is dropped without an answer, so
	// the source tries again and finds the next process.
	handedOver atomic.Bool

	// OnEnd observes target sessions that ended (optional, no locks held).
	OnEnd func(key TargetKey, s *Session, err error)
}

// NewTargetTable creates the target side of a process with a fresh nonce: a
// restarted process refuses resumes of sessions it never owned.
func NewTargetTable(budget *WindowBudget) *TargetTable {
	if budget == nil {
		budget = NewWindowBudget(0)
	}
	t := &TargetTable{budget: budget, sessions: map[TargetKey]*Session{}, tombs: map[TargetKey]tombstone{}}
	if _, err := crand.Read(t.nonce[:]); err != nil {
		panic(err)
	}
	return t
}

// AcceptRequest describes an incoming tunnel the relay admitted.
type AcceptRequest struct {
	RouteID    string
	SourceKind string
	SourceID   string
	RelayID    string // the relay of the registration the tunnel came through
	// Keys returns the route's current or previous key; nil: the route is
	// not resumable here (the tunnel is raw).
	Keys Keys
	// Authorize rechecks the route on every resume.
	Authorize func() error
}

// AcceptKind is how an incoming tunnel is served.
type AcceptKind int

const (
	// AcceptLegacy: a raw tunnel, served as before. Stream replays the frame
	// that was read to decide.
	AcceptLegacy AcceptKind = iota
	// AcceptHello: a new resumable stream. Dial the backend, then Establish
	// (or send the relay Error frame as before when the dial fails).
	AcceptHello
	// AcceptResumed: an existing stream moved onto this tunnel; no dial.
	AcceptResumed
	// AcceptRefused: the tunnel ends (resume refused or a broken stream).
	AcceptRefused
)

// Accepted is the decision for one incoming tunnel.
type Accepted struct {
	Kind AcceptKind
	// Stream: the tunnel (AcceptLegacy: its first frame is replayed).
	Stream Stream
	// PathDone closes once the session gave this tunnel up and its stream
	// ended (AcceptResumed, AcceptRefused, and AcceptHello after Establish).
	PathDone <-chan struct{}
	Session  *Session
	Reject   byte
	Err      error

	table *TargetTable
	req   AcceptRequest
	op    OpenedPath
	hello Record
	rest  []byte
}

type firstRead struct {
	frame *relayv1.TunnelFrame
	err   error
}

// Accept reads the first frame of an admitted tunnel (at most
// FirstRecordTimeout) and decides how it is served (the first-record rule).
func (t *TargetTable) Accept(op OpenedPath, req AcceptRequest) *Accepted {
	if req.Keys == nil {
		return &Accepted{Kind: AcceptLegacy, Stream: op.Stream}
	}
	read := make(chan firstRead, 1)
	go func() {
		frame, err := op.Stream.Recv()
		read <- firstRead{frame, err}
	}()
	timer := time.NewTimer(FirstRecordTimeout)
	var first firstRead
	select {
	case first = <-read:
		timer.Stop()
	case <-timer.C:
		// A raw source of a server-speaks-first protocol (version skew).
		return &Accepted{Kind: AcceptLegacy, Stream: &replayStream{Stream: op.Stream, pending: read}}
	}
	if first.err != nil {
		return &Accepted{Kind: AcceptRefused, Err: first.err, PathDone: closedChan()}
	}
	legacy := &Accepted{Kind: AcceptLegacy, Stream: &replayStream{Stream: op.Stream, first: first.frame, have: true}}
	data := first.frame.GetData().GetData()
	if len(data) == 0 {
		return legacy
	}
	record, rest, err := ParseRecord(data)
	if err != nil {
		return legacy
	}
	switch record.Type {
	case TypeHello:
		key := req.Keys(record.KeyID)
		if key == nil || !VerifyHello(&record, req.RouteID, req.RelayID, key) {
			// Not ours (a raw client whose bytes look like HELLO cannot
			// produce the MAC), or a source with a key this side does not
			// hold: raw, and a resumable source resets the stream itself.
			return legacy
		}
		return &Accepted{Kind: AcceptHello, table: t, req: req, op: op, hello: record, rest: rest}
	case TypeResume:
		if len(rest) != 0 {
			return legacy
		}
		if t.handedOver.Load() {
			// Neither unknown nor refused: the stream lives on in the next
			// process.
			return dropResume(op)
		}
		return t.resume(op, req, &record)
	}
	return legacy
}

// dropResume ends a RESUME's tunnel without an answer: a failed attempt, so
// the source tries again.
func dropResume(op OpenedPath) *Accepted {
	if op.Cancel != nil {
		op.Cancel()
	}
	return &Accepted{Kind: AcceptRefused, PathDone: closedChan()}
}

func (t *TargetTable) resume(op OpenedPath, req AcceptRequest, record *Record) *Accepted {
	key := TargetKey{RouteID: req.RouteID, SourceKind: req.SourceKind, SourceID: req.SourceID, SessionID: record.SessionID}
	t.mu.Lock()
	t.sweepLocked(time.Now())
	session := t.sessions[key]
	tomb, tombed := t.tombs[key]
	// Handed over since Accept looked: the stream may have left the table
	// already, and the next process answers for it.
	handedOver := t.handedOver.Load()
	t.mu.Unlock()
	if handedOver {
		return dropResume(op)
	}
	if session == nil {
		code := RejectUnknown
		if tombed {
			code = tomb.reject
		}
		t.refused.Add(1)
		return &Accepted{Kind: AcceptRefused, Reject: code, PathDone: rejectPath(op, record.SessionID, code)}
	}
	session.mu.Lock()
	if session.sealed || session.detached {
		// Read out for a handover: the answer would carry this process's
		// offsets, which the next one may not have (Session.sealed).
		session.mu.Unlock()
		return dropResume(op)
	}
	session.core.cfg.Keys = req.Keys
	session.core.cfg.Authorize = req.Authorize
	path := NewPath(nil, req.RelayID, op.MaxFrame)
	run := session.attach(path, op)
	verdict := session.core.AcceptResume(path, record, time.Now())
	session.afterLocked(false)
	session.mu.Unlock()
	if !verdict.Accepted {
		t.refused.Add(1)
		return &Accepted{Kind: AcceptRefused, Reject: verdict.Reject, Session: session, PathDone: run.done}
	}
	return &Accepted{Kind: AcceptResumed, Session: session, PathDone: run.done}
}

// Establish starts the new stream after the backend dial succeeded: it
// answers HELLO_ACK and registers the session. tag is the caller's (the
// endpoint owner), returned by Session.Tag.
func (a *Accepted) Establish() (*Session, error) { return a.EstablishTagged(nil) }

// EstablishTagged is Establish with a caller tag.
func (a *Accepted) EstablishTagged(tag any) (*Session, error) {
	if a.Kind != AcceptHello || a.Session != nil {
		return nil, errors.New("relayresume: nothing to establish")
	}
	t := a.table
	key := TargetKey{RouteID: a.req.RouteID, SourceKind: a.req.SourceKind, SourceID: a.req.SourceID, SessionID: a.hello.SessionID}
	t.mu.Lock()
	if _, exists := t.sessions[key]; exists {
		t.mu.Unlock()
		return nil, errors.New("relayresume: duplicate session")
	}
	if _, exists := t.tombs[key]; exists {
		t.mu.Unlock()
		return nil, errors.New("relayresume: replayed session")
	}
	path := NewPath(nil, a.req.RelayID, a.op.MaxFrame)
	core := NewTarget(Config{RouteID: a.req.RouteID, Keys: a.req.Keys, TargetNonce: t.nonce, Authorize: a.req.Authorize, Budget: t.budget},
		path, &a.hello, a.hello.KeyID, a.req.Keys(a.hello.KeyID), a.rest, time.Now())
	s := newSession(core, a.req.RouteID, a.op.MaxFrame)
	s.tag = tag
	t.registerLocked(key, s)
	t.mu.Unlock()
	s.mu.Lock()
	run := s.attach(path, a.op)
	s.afterLocked(false)
	s.mu.Unlock()
	a.Session = s
	a.PathDone = run.done
	return s, nil
}

// registerLocked adds s under key (t.mu held) and watches it end.
func (t *TargetTable) registerLocked(key TargetKey, s *Session) {
	s.table, s.tableKey = t, key
	t.sessions[key] = s
	s.onChange = func(s *Session) {
		if s.core.State().Terminal() && s.onChange != nil {
			s.onChange = nil
			go t.ended(key, s)
		}
	}
}

// Restore takes over a target stream another process handed over
// (SessionState of RoleTarget): suspended, it waits for its source's RESUME
// until TargetSuspendTimeout after its freeze, as after a path failure. Its
// RESUME is checked with the keys and the authorization of the tunnel it
// arrives on. tag is the caller's, as for EstablishTagged.
func (t *TargetTable) Restore(st *SessionState, tag any) (*Session, error) {
	if st.Role != RoleTarget {
		return nil, errors.New("relayresume: not a target stream")
	}
	core, err := restoreCore(Config{Budget: t.budget}, st, time.Now())
	if err != nil {
		return nil, err
	}
	key := TargetKey{RouteID: st.RouteID, SourceKind: st.SourceKind, SourceID: st.SourceID, SessionID: st.SessionID}
	t.mu.Lock()
	if _, exists := t.sessions[key]; exists {
		t.mu.Unlock()
		core.closeAll()
		return nil, errors.New("relayresume: duplicate session")
	}
	s := newSession(core, st.RouteID, st.MaxFrame)
	s.tag = tag
	s.partial = append([]byte(nil), st.Unwritten...)
	s.restoredFrozenAt = core.suspendDeadline.Add(-TargetSuspendTimeout)
	t.registerLocked(key, s)
	t.mu.Unlock()
	s.mu.Lock()
	s.afterLocked(false)
	s.mu.Unlock()
	return s, nil
}

// Refuse answers a later RESUME of a handed over stream this process does not
// take over (its route was revoked meanwhile: RejectUnauthorized) as if the
// stream had ended here, so its source stops at once instead of retrying.
func (t *TargetTable) Refuse(st *SessionState, reject byte) {
	if st.Role != RoleTarget {
		return
	}
	key := TargetKey{RouteID: st.RouteID, SourceKind: st.SourceKind, SourceID: st.SourceID, SessionID: st.SessionID}
	t.mu.Lock()
	t.tombs[key] = tombstone{reject: reject, expires: time.Now().Add(TombstoneTTL)}
	t.mu.Unlock()
}

// Tombstone is how a stream that ended answers a later RESUME, for the next
// process: a source whose CLOSE echo was lost with the handover learns there
// that its stream finished, not that it is unknown.
type Tombstone struct {
	Key     TargetKey
	Reject  byte
	Expires time.Time
}

// HandoverTombstones lists the table's tombstones, with the streams that
// ended and are not buried yet.
func (t *TargetTable) HandoverTombstones() []Tombstone {
	t.mu.Lock()
	now := time.Now()
	var tombs []Tombstone
	for key, tomb := range t.tombs {
		if now.Before(tomb.expires) {
			tombs = append(tombs, Tombstone{Key: key, Reject: tomb.reject, Expires: tomb.expires})
		}
	}
	sessions := make(map[TargetKey]*Session, len(t.sessions))
	for key, s := range t.sessions {
		sessions[key] = s
	}
	t.mu.Unlock()
	for key, s := range sessions {
		s.mu.Lock()
		state, err := s.core.State(), s.core.Err()
		s.mu.Unlock()
		if !state.Terminal() {
			continue
		}
		reject := RejectReset
		switch {
		case state == StateFinished:
			reject = RejectFinished
		case errors.Is(err, ErrRevoked):
			reject = RejectUnauthorized
		}
		tombs = append(tombs, Tombstone{Key: key, Reject: reject, Expires: now.Add(TombstoneTTL)})
	}
	return tombs
}

// RestoreTombstones takes over the tombstones the previous process handed over.
func (t *TargetTable) RestoreTombstones(tombs []Tombstone) {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, tomb := range tombs {
		if _, live := t.sessions[tomb.Key]; live || !now.Before(tomb.Expires) || tomb.Reject == 0 {
			continue
		}
		expires := tomb.Expires
		if limit := now.Add(TombstoneTTL); expires.After(limit) {
			expires = limit
		}
		t.tombs[tomb.Key] = tombstone{reject: tomb.Reject, expires: expires}
	}
}

// HandOver marks the table's streams as handed to the next process: from now
// on a RESUME reaching this one is dropped without an answer.
func (t *TargetTable) HandOver() { t.handedOver.Store(true) }

// forget drops a stream another process took over, without a tombstone.
func (t *TargetTable) forget(key TargetKey, s *Session) {
	t.mu.Lock()
	if t.sessions[key] == s {
		delete(t.sessions, key)
	}
	t.mu.Unlock()
}

func (t *TargetTable) ended(key TargetKey, s *Session) {
	s.mu.Lock()
	state, err := s.core.State(), s.core.Err()
	s.mu.Unlock()
	reject := RejectReset
	switch {
	case state == StateFinished:
		reject = RejectFinished
	case errors.Is(err, ErrRevoked):
		// A later resume (its REJ answer may have been lost with the path)
		// learns why the stream ended.
		reject = RejectUnauthorized
	}
	t.mu.Lock()
	if t.sessions[key] == s {
		delete(t.sessions, key)
	}
	t.tombs[key] = tombstone{reject: reject, expires: time.Now().Add(TombstoneTTL)}
	t.mu.Unlock()
	if t.OnEnd != nil {
		t.OnEnd(key, s, err)
	}
}

func (t *TargetTable) sweepLocked(now time.Time) {
	if now.Sub(t.lastSweep) < 10*time.Second {
		return
	}
	t.lastSweep = now
	for key, tomb := range t.tombs {
		if now.After(tomb.expires) {
			delete(t.tombs, key)
		}
	}
}

// Prune resets the sessions keep refuses (their route or endpoint is no
// longer assigned to this daemon).
func (t *TargetTable) Prune(keep func(TargetKey, *Session) bool) {
	t.mu.Lock()
	var gone []*Session
	for key, s := range t.sessions {
		if !keep(key, s) {
			gone = append(gone, s)
		}
	}
	t.mu.Unlock()
	for _, s := range gone {
		s.abortWith(RstRevoked, "route is no longer assigned", ErrRevoked)
	}
}

// RequestMigrate asks the sources of the sessions running through relayID
// to move (the target's own lane to that relay is going away).
func (t *TargetTable) RequestMigrate(relayID string, reason byte) {
	for _, s := range t.Sessions() {
		s.mu.Lock()
		if p := s.core.Current(); p != nil && p.RelayID() == relayID {
			s.core.RequestMigrate(reason)
			s.afterLocked(false)
		}
		s.mu.Unlock()
	}
}

// Sessions is a snapshot of the live target sessions.
func (t *TargetTable) Sessions() []*Session {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]*Session, 0, len(t.sessions))
	for _, s := range t.sessions {
		out = append(out, s)
	}
	return out
}

// TargetStats are the target-side counters.
type TargetStats struct {
	Sessions  uint64
	Suspended uint64
	Refused   uint64
}

// Stats snapshots the counters.
func (t *TargetTable) Stats() TargetStats {
	stats := TargetStats{Refused: t.refused.Load()}
	for _, s := range t.Sessions() {
		stats.Sessions++
		if state := s.State(); state == StateSuspended {
			stats.Suspended++
		}
	}
	return stats
}

// rejectPath answers RESUME_REJ on a tunnel no session takes and ends it.
func rejectPath(op OpenedPath, sessionID [SessionIDLen]byte, code byte) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		frame := mustRecord(&Record{Type: TypeResumeRej, SessionID: sessionID, Code: code})
		if err := op.Stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: frame}}}); err == nil && op.CloseSend != nil {
			_ = op.CloseSend()
			ended := make(chan struct{})
			go func() {
				defer close(ended)
				for {
					if _, err := op.Stream.Recv(); err != nil {
						return
					}
				}
			}()
			select {
			case <-ended:
			case <-time.After(CloseLingerTimeout):
			}
		}
		if op.Cancel != nil {
			op.Cancel()
		}
	}()
	return done
}

func closedChan() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

// replayStream serves a raw tunnel whose first frame was already read.
type replayStream struct {
	Stream
	mu      sync.Mutex
	first   *relayv1.TunnelFrame
	have    bool
	pending chan firstRead
}

// CloseSend half-closes the underlying client stream (relaybridge.AwaitEnd).
func (r *replayStream) CloseSend() error {
	if closer, ok := r.Stream.(interface{ CloseSend() error }); ok {
		return closer.CloseSend()
	}
	return nil
}

func (r *replayStream) Recv() (*relayv1.TunnelFrame, error) {
	r.mu.Lock()
	if r.pending != nil {
		read := <-r.pending
		r.pending = nil
		r.mu.Unlock()
		return read.frame, read.err
	}
	if r.have {
		r.have = false
		frame := r.first
		r.first = nil
		r.mu.Unlock()
		return frame, nil
	}
	r.mu.Unlock()
	return r.Stream.Recv()
}
