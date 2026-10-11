package docker

import (
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// answerAt makes relay answer every source open with err at once (nil: serve them again).
func answerAt(relay *miniRelay, err error) {
	if err == nil {
		relay.hold.Store(nil)
		return
	}
	release := make(chan struct{})
	close(release)
	relay.hold.Store(&openHold{release: release, err: err})
}

// Stand 2.12 R-3: the local relay refuses new proxy tunnels for its pressure, and a policy snapshot moves every
// stream to a new assignment generation while the only other relays do not serve the endpoint under it yet. The
// demotion survives the snapshot, and the streams re-pathing (each stays on its relay under the new grant, or would
// leave it) reach the demoted relay about once a second instead of on every attempt; once another relay serves, new
// connections go there, not to the demoted relay.
func TestSnapshotDuringDemotionKeepsItAndPacesTheDemotedRelay(t *testing.T) {
	pair := newPoolPair(t)
	_, sessions := pair.openStreams(6)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 6})

	answerAt(pair.relays[poolLocal], status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: database_reserve"))
	_, demoting := pair.open()
	if demoting.router.targetID != poolUK {
		t.Fatalf("the connection the local relay refused went to %s, want the near standby", demoting.router.targetID)
	}
	if !pair.source.relayPenalties.Demoted(poolLocal) {
		t.Fatal("the refusal did not demote the local relay")
	}

	notRegistered := status.Error(codes.Unavailable, "target endpoint is not registered")
	answerAt(pair.relays[poolUK], notRegistered)
	answerAt(pair.relays[poolNL], notRegistered)
	pair.relays[poolLocal].opens.Store(0)
	started := time.Now()
	pair.apply(2, generation(2, "active", poolLocal, poolUK, poolNL), generation(1, "draining", poolLocal, poolUK, poolNL))
	time.Sleep(8 * time.Second)
	reached := pair.relays[poolLocal].opens.Load()
	// Unpaced, each of the seven streams tried the local relay on every attempt (backoff 250 ms doubling to 2 s):
	// about 35 opens in these 8 s. Paced: one per second, plus slack for a slow host.
	if limit := int64(time.Since(started)/time.Second) + 3; reached > limit {
		t.Fatalf("the demoted relay took %d opens in %s, want at most %d", reached, time.Since(started).Round(time.Second), limit)
	}
	if reached == 0 {
		t.Fatal("the demoted relay was never probed")
	}
	if !pair.source.relayPenalties.Demoted(poolLocal) {
		t.Fatal("the snapshot ended the demotion")
	}

	answerAt(pair.relays[poolUK], nil)
	_, next := pair.open()
	if next.router.targetID != poolUK {
		t.Fatalf("a new connection went to %s while the local relay is demoted, want the near standby", next.router.targetID)
	}
}
