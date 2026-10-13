package docker

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const (
	// egressAckWait bounds how long a grant-sync ACK waits for the egress reconcile; what is not ready by then is
	// reported pending and the reconcile finishes in the background. Gateway polls by sending the bundle again.
	egressAckWait = 10 * time.Second
	// egressFreshFor is how long a bundle with the same egress as the last applied one, all ready, is answered from
	// the published statuses without touching the connector.
	egressFreshFor = 30 * time.Second
	// egressSuccessorWait is how long the listener of an egress that left the bundle stays, with its connections,
	// for the binding that takes its socket over in a later bundle (an Availability re-key arriving in two syncs).
	egressSuccessorWait = 5 * time.Second
)

// Variables for tests.
var (
	egressAckWaitFor  = egressAckWait
	egressSuccessorTo = egressSuccessorWait
)

type egressOrphan struct {
	desired egressDesired
	until   time.Time
}

// egressRunner applies grant bundles' egress one at a time, in the background of the ACKs that wait for them.
type egressRunner struct {
	mu       sync.Mutex
	next     *egressRequest
	nextDone chan struct{}
	running  bool
	lastKey  string
	lastDone time.Time
}

type egressRequest struct {
	desired  map[string]egressDesired
	rejected map[string]egressStatus
	key      string
}

// syncEgress applies the egress of a grant bundle and returns every egress status, waiting at most egressAckWait. A
// bundle whose egress equals the last applied one, all ready, is answered at once.
func (m *dockerSecureLinkManager) syncEgress(bundle *pb.SyncRelayGrantsCommand) map[string]egressStatus {
	desired, rejected := desiredEgressFromBundle(bundle)
	request := &egressRequest{desired: desired, rejected: rejected, key: egressRequestKey(desired, rejected)}
	runner := &m.egressRun
	runner.mu.Lock()
	if !runner.running && runner.next == nil && request.key == runner.lastKey && time.Since(runner.lastDone) < egressFreshFor &&
		allEgressReady(m.egress.currentStatuses(), desired) {
		runner.mu.Unlock()
		return m.egress.currentStatuses()
	}
	runner.next = request
	if runner.nextDone == nil {
		runner.nextDone = make(chan struct{})
	}
	done := runner.nextDone
	if !runner.running {
		runner.running = true
		go m.runEgress()
	}
	runner.mu.Unlock()
	timer := time.NewTimer(egressAckWaitFor)
	defer timer.Stop()
	select {
	case <-done:
		return m.egress.currentStatuses()
	case <-timer.C:
		return egressStatusesWhileApplying(m.egress.currentStatuses(), request)
	}
}

// runEgress applies the latest requested egress until none is left; requests made meanwhile collapse into one. The
// runner is idle again (running false) in the same step that answers the last request: a bundle sent right after that
// answer (Gateway's next poll with the same bundle) is answered from the published statuses, not applied once more.
func (m *dockerSecureLinkManager) runEgress() {
	runner := &m.egressRun
	runner.mu.Lock()
	for {
		request, done := runner.next, runner.nextDone
		runner.next, runner.nextDone = nil, nil
		if request == nil {
			runner.running = false
			runner.mu.Unlock()
			return
		}
		runner.mu.Unlock()
		m.mu.Lock()
		m.setDesiredEgressLocked(request.desired, request.rejected, time.Now())
		ctx, cancel := context.WithTimeout(context.Background(), secureLinkEgressTimeout)
		m.reconcileEgressLocked(ctx)
		cancel()
		m.mu.Unlock()
		runner.mu.Lock()
		runner.lastKey, runner.lastDone = request.key, time.Now()
		if runner.next == nil {
			runner.running = false
		}
		close(done)
		if !runner.running {
			runner.mu.Unlock()
			return
		}
	}
}

// setDesiredEgressLocked takes a bundle's egress. An egress that left it keeps its listener (an orphan) until a
// later bundle names an egress of the same kind on the same socket, or egressSuccessorWait passes: an Availability
// re-key may remove the old binding one sync before it adds the new one, and the connector moves a listener to the
// new id, with its connections, only when both are in one sync. A successor in the same bundle needs no orphan.
func (m *dockerSecureLinkManager) setDesiredEgressLocked(desired map[string]egressDesired, rejected map[string]egressStatus, now time.Time) {
	if m.egress.orphans == nil {
		m.egress.orphans = map[string]egressOrphan{}
	}
	scheduled := false
	for id, previous := range m.egress.desired {
		if _, kept := desired[id]; kept || egressSuccessorOnSocket(desired, previous) {
			continue
		}
		m.egress.orphans[id] = egressOrphan{desired: previous, until: now.Add(egressSuccessorTo)}
		scheduled = true
	}
	for id, orphan := range m.egress.orphans {
		_, back := desired[id]
		if back || !now.Before(orphan.until) || egressSuccessorOnSocket(desired, orphan.desired) {
			delete(m.egress.orphans, id)
		}
	}
	m.egress.desired, m.egress.rejected = desired, rejected
	if scheduled {
		// The orphans that found no successor go with the next reconcile after their wait.
		time.AfterFunc(egressSuccessorTo+100*time.Millisecond, m.resyncEgress)
	}
}

func egressSuccessorOnSocket(desired map[string]egressDesired, previous egressDesired) bool {
	for _, candidate := range desired {
		if candidate.networkName == previous.networkName && candidate.listenPort == previous.listenPort && candidate.ownerKind == previous.ownerKind {
			return true
		}
	}
	return false
}

// egressStatusesWhileApplying is the ACK of a bundle whose reconcile still runs: an egress already ready at its
// route generation stays ready, every other one is pending.
func egressStatusesWhileApplying(published map[string]egressStatus, request *egressRequest) map[string]egressStatus {
	statuses := make(map[string]egressStatus, len(request.desired)+len(request.rejected))
	for id, status := range request.rejected {
		statuses[id] = status
	}
	for id, desired := range request.desired {
		if status, ok := published[id]; ok && status.State == egressStateReady && status.RouteGeneration == desired.generation {
			statuses[id] = status
			continue
		}
		statuses[id] = egressStatus{State: egressStatePending, Error: "the egress is being applied", RouteGeneration: desired.generation, network: desired.networkName}
	}
	return statuses
}

func allEgressReady(published map[string]egressStatus, desired map[string]egressDesired) bool {
	for id, entry := range desired {
		if status, ok := published[id]; !ok || status.State != egressStateReady || status.RouteGeneration != entry.generation {
			return false
		}
	}
	return true
}

// egressRequestKey identifies a bundle's egress: equal keys ask for the same listeners.
func egressRequestKey(desired map[string]egressDesired, rejected map[string]egressStatus) string {
	parts := make([]string, 0, len(desired)+len(rejected))
	for id, entry := range desired {
		parts = append(parts, fmt.Sprintf("%s=%+v", id, entry))
	}
	for id, status := range rejected {
		parts = append(parts, fmt.Sprintf("%s!%+v", id, status))
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}
