package handover

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// Every update reports what it did to the connections the daemon carried (the
// measure for the stand and the field): the stopping process records what it
// handed over and what it cut, the next one adds what resumed, and reports the
// result to Opfield in its health reports until the next update.

const (
	// pendingReportFile is written by the stopping process for the next one.
	pendingReportFile = "update-connections.json"
	// lastReportFile is the final report of the last update.
	lastReportFile = "update-connections-last.json"
	// settleLimit bounds the wait for the handed over streams: a source has
	// UnplannedBudget to find a path, a target TargetSuspendTimeout.
	settleLimit = relayresume.TargetSuspendTimeout + 5*time.Second
)

// settleProof is how long the counts wait after the last stream resumed, and
// settleTick how often they look (variables for tests).
var (
	settleProof = time.Second
	settleTick  = 250 * time.Millisecond
)

// Report is what one update did to the daemon's connections.
type Report struct {
	FromVersion string         `json:"fromVersion"`
	ToVersion   string         `json:"toVersion,omitempty"`
	StartedAt   time.Time      `json:"startedAt"`
	FinishedAt  time.Time      `json:"finishedAt,omitzero"`
	Handover    bool           `json:"handover"`
	HandedOver  int            `json:"handedOver"`
	Kept        int            `json:"kept"`
	Cut         map[string]int `json:"cut,omitempty"`
	PauseP50    time.Duration  `json:"pauseP50,omitempty"`
	PauseP99    time.Duration  `json:"pauseP99,omitempty"`
	PauseMax    time.Duration  `json:"pauseMax,omitempty"`
	// Counted: Cut holds every connection the update did not hand over,
	// counted before the drain that closes the idle ones. Processes of
	// 2.11.4-rc.7 and earlier counted after it (CutUncounted).
	Counted bool `json:"counted,omitempty"`
}

// AddCut counts n connections cut under class.
func (r *Report) AddCut(class string, n int) {
	if n <= 0 || class == "" {
		return
	}
	if r.Cut == nil {
		r.Cut = map[string]int{}
	}
	r.Cut[class] += n
}

// WritePending records what the stopping process did, for the next one.
func WritePending(stateDir string, report Report) error {
	return writeReport(filepath.Join(stateDir, pendingReportFile), report)
}

func writeReport(path string, report Report) error {
	data, err := json.Marshal(report)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(path, data, 0o600)
}

func readReport(path string) (*Report, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var report Report
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, err
	}
	return &report, nil
}

// Tracker settles, in the next process, the update the previous one reported:
// it waits until every stream taken over resumed or ended, then keeps the
// final report.
type Tracker struct {
	stateDir string

	mu       sync.Mutex
	pending  *Report
	sessions []*relayresume.Session
	// lost are the sessions whose local connection failed before the counts
	// were final (CutLocalClosed); closed those whose local side ended its
	// connection itself before they resumed: neither kept nor cut (P-1).
	lost    map[*relayresume.Session]bool
	closed  map[*relayresume.Session]bool
	tracked map[*relayresume.Session]bool
	kept    int
	cut     map[string]int
	// later are the cuts CutAfter added before the counts were final.
	later   map[string]int
	last    *Report
	settled chan struct{}
}

// NewTracker starts a tracker for a process of version: it takes the report
// the previous process left (none for a fresh start or an older binary) and
// the final report of the last update.
func NewTracker(stateDir, version string) *Tracker {
	t := &Tracker{stateDir: stateDir, cut: map[string]int{}, settled: make(chan struct{})}
	if last, err := readReport(filepath.Join(stateDir, lastReportFile)); err == nil {
		t.last = last
	}
	path := filepath.Join(stateDir, pendingReportFile)
	pending, err := readReport(path)
	lifecycle.NotePreviousUpdateReport(!errors.Is(err, os.ErrNotExist))
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(path)
	}
	if err == nil && time.Since(pending.StartedAt) < 30*time.Minute {
		pending.ToVersion = version
		markUncounted(pending)
		t.pending = pending
	} else {
		close(t.settled)
	}
	return t
}

// markUncounted turns the cut of an older process's report that handed
// nothing over into CutUncounted: that process counted only the connections
// still open after its drain, which had closed the idle ones (a service
// restart of 22 connections reported one). Such an update cut every
// connection of the daemon; the count is a lower bound.
func markUncounted(report *Report) {
	if report.Counted || report.Handover || len(report.Cut) == 0 {
		return
	}
	total := 0
	for _, n := range report.Cut {
		total += n
	}
	report.Cut = map[string]int{CutUncounted: total}
}

// Track follows a stream taken over until it resumed or ended.
func (t *Tracker) Track(session *relayresume.Session) {
	t.mu.Lock()
	t.sessions = append(t.sessions, session)
	if t.tracked == nil {
		t.tracked = map[*relayresume.Session]bool{}
	}
	t.tracked[session] = true
	t.mu.Unlock()
}

// localEnded hears that the local connection of a bridged session ended (err
// nil: its end of stream). For a stream taken over whose counts are not final
// yet, a failure at any time means the update did not keep the connection: a
// stream that resumed carries nothing to a local connection that is gone
// (stand rc.7 F-1, a truncated download reported kept). An end of stream
// before the stream resumed is the local side closing its connection itself
// during the pause (a short-lived client that was done): it is not kept, and
// not counted as cut either (P-1).
func (t *Tracker) localEnded(session *relayresume.Session, err error) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pending == nil || !t.tracked[session] {
		return
	}
	if err == nil {
		if _, resumed, _ := session.HandoverPause(); !resumed {
			if t.closed == nil {
				t.closed = map[*relayresume.Session]bool{}
			}
			t.closed[session] = true
		}
		return
	}
	if t.lost == nil {
		t.lost = map[*relayresume.Session]bool{}
	}
	t.lost[session] = true
}

// Kept counts n connections taken over that carry on without a stream to
// resume (pipes).
func (t *Tracker) Kept(n int) {
	t.mu.Lock()
	t.kept += n
	t.mu.Unlock()
}

// Cut counts n connections taken over that this process ended.
func (t *Tracker) Cut(class string, n int) {
	if n <= 0 {
		return
	}
	t.mu.Lock()
	t.cut[class] += n
	t.mu.Unlock()
}

// CutAfter counts n connections of class that a consequence of an update cut
// after the update itself (a replaced connector removed at its retirement
// limit): they join the last update's report, which becomes a new final
// report (FinishedAt now) for Opfield to take again. It reports false when
// there is no report to join: the daemon has not been updated since it
// reports them.
func (t *Tracker) CutAfter(class string, n int) bool {
	if t == nil || n <= 0 || class == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pending != nil {
		if t.later == nil {
			t.later = map[string]int{}
		}
		t.later[class] += n
		return true
	}
	if t.last == nil {
		return false
	}
	report := *t.last
	report.Cut = map[string]int{}
	for existing, count := range t.last.Cut {
		report.Cut[existing] = count
	}
	report.AddCut(class, n)
	report.FinishedAt = time.Now()
	t.last = &report
	_ = writeReport(filepath.Join(t.stateDir, lastReportFile), report)
	return true
}

// Settle waits until every stream taken over resumed or ended (at most
// settleLimit), then keeps the final report. Run it once, after the
// restore.
func (t *Tracker) Settle() {
	t.mu.Lock()
	pending := t.pending
	t.mu.Unlock()
	if pending == nil {
		return
	}
	deadline := time.Now().Add(settleLimit)
	var settledAt time.Time
	// endedAt: when a look first saw a stream end before it resumed.
	endedAt := map[*relayresume.Session]time.Time{}
	for {
		t.mu.Lock()
		sessions := slices.Clone(t.sessions)
		t.mu.Unlock()
		open := 0
		now := time.Now()
		for _, session := range sessions {
			_, resumed, ended := session.HandoverPause()
			switch {
			case resumed:
			case ended:
				if _, seen := endedAt[session]; !seen {
					endedAt[session] = now
				}
			default:
				open++
			}
		}
		if open > 0 {
			settledAt = time.Time{}
		} else if settledAt.IsZero() {
			// A local connection that is gone shows when the resumed stream
			// first writes to it: the counts become final a moment later.
			settledAt = now
		}
		if (open == 0 && (len(sessions) == 0 || now.Sub(settledAt) >= settleProof)) || now.After(deadline) {
			t.finish(pending, sessions, endedAt)
			return
		}
		time.Sleep(settleTick)
	}
}

func (t *Tracker) finish(pending *Report, sessions []*relayresume.Session, endedAt map[*relayresume.Session]time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var pauses []time.Duration
	lost, failed, uncounted := 0, 0, 0
	now := time.Now()
	for _, session := range sessions {
		pause, resumed, ended := session.HandoverPause()
		at, seen := endedAt[session]
		if !seen {
			at = now
		}
		switch {
		case !resumed && ended && endedByPeer(session.State(), session.Err(), at.Sub(pending.StartedAt)):
			// The far end ended it (its own update cut it, in the same batch):
			// that node's report counts it, not this one's (stand rc.11 O-1).
			uncounted++
		case t.lost[session]:
			lost++
		case t.closed[session]:
			// Closed by its local side: neither kept nor cut.
			uncounted++
		case resumed:
			pauses = append(pauses, pause)
		default:
			// Ended, or still waiting at the settle limit.
			failed++
		}
	}
	report := *pending
	report.Cut = map[string]int{}
	for class, n := range pending.Cut {
		report.Cut[class] = n
	}
	report.Kept = t.kept + len(pauses)
	for class, n := range t.cut {
		report.AddCut(class, n)
	}
	report.AddCut(CutResumeFailed, failed)
	report.AddCut(CutLocalClosed, lost)
	// What the previous process handed over and this one never saw (a
	// snapshot that did not come over) is cut too.
	accounted := report.Kept + failed + lost + uncounted
	for _, n := range t.cut {
		accounted += n
	}
	report.AddCut(CutResumeFailed, report.HandedOver-accounted)
	for class, n := range t.later {
		report.AddCut(class, n)
	}
	if len(pauses) > 0 {
		slices.Sort(pauses)
		report.PauseP50 = pauses[len(pauses)/2]
		report.PauseP99 = pauses[min(len(pauses)-1, len(pauses)*99/100)]
		report.PauseMax = pauses[len(pauses)-1]
	}
	report.FinishedAt = time.Now()
	t.last = &report
	t.pending = nil
	_ = writeReport(filepath.Join(t.stateDir, lastReportFile), report)
	close(t.settled)
}

// endedByPeer reports a stream taken over that its far end ended before it
// resumed (state and err: how it ended; after: how long after the update
// started it ended): it finished, the peer reset it, or the peer refused its
// resume because it had reset or finished it there (a connection the peer's
// own update cut). A peer that does not know the stream at all lost it too:
// its own update left it out of its handover (storage-1's TLS DB links in a
// mixed batch, stand rc.12 F-1), and a peer that ended it itself answers from
// its tombstone (relayresume.TombstoneTTL) instead. A refusal for any other
// reason, or a peer that gave up waiting for this side (suspend timeout),
// stays this update's cut. A refusal for a reset or an unknown stream carries
// no reason: once the peer could have given up waiting
// (relayresume.TargetSuspendTimeout after the update started, before the
// streams froze), it is this update's cut too.
func endedByPeer(state relayresume.State, err error, after time.Duration) bool {
	if state == relayresume.StateFinished {
		return true
	}
	var reset *relayresume.ResetError
	if !errors.As(err, &reset) {
		return false
	}
	switch reset.Reject {
	case relayresume.RejectFinished:
		return true
	case relayresume.RejectReset, relayresume.RejectUnknown:
		return after < relayresume.TargetSuspendTimeout
	case 0:
		return reset.Remote && reset.Code != relayresume.RstSuspendTimeout && reset.Code != relayresume.RstProtocol &&
			reset.Code != relayresume.RstLegacyPeer && reset.Code != relayresume.RstWindowViolation
	}
	return false
}

// Last is the final report of the last update (nil: none yet).
func (t *Tracker) Last() *Report {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last
}

// Proto is the report for Opfield.
func (r *Report) Proto() *pb.DaemonUpdateConnectionReport {
	if r == nil {
		return nil
	}
	report := &pb.DaemonUpdateConnectionReport{
		FromVersion: r.FromVersion, ToVersion: r.ToVersion, StartedAtUnixMs: r.StartedAt.UnixMilli(), Handover: r.Handover,
		HandedOver: uint32(max(r.HandedOver, 0)), Kept: uint32(max(r.Kept, 0)), Cut: cutProto(r.Cut),
		PauseP50Ms: uint32(r.PauseP50.Milliseconds()), PauseP99Ms: uint32(r.PauseP99.Milliseconds()), PauseMaxMs: uint32(r.PauseMax.Milliseconds()),
	}
	if !r.FinishedAt.IsZero() {
		report.FinishedAtUnixMs = r.FinishedAt.UnixMilli()
	}
	return report
}

// Status is the health report's view: what an update now would keep and cut,
// and the last update.
func Status(available bool, kept int, cut map[string]int, last *Report) *pb.DaemonUpdateConnections {
	return &pb.DaemonUpdateConnections{HandoverAvailable: available, Kept: uint32(max(kept, 0)), Cut: cutProto(cut), LastUpdate: last.Proto()}
}

func cutProto(cut map[string]int) map[string]uint32 {
	if len(cut) == 0 {
		return nil
	}
	result := make(map[string]uint32, len(cut))
	for class, n := range cut {
		if n > 0 {
			result[class] = uint32(n)
		}
	}
	return result
}
