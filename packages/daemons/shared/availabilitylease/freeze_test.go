package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

func newDetectorNode(t *testing.T) (*Node, *manualClock) {
	t.Helper()
	clock := &manualClock{now: 500 * time.Second}
	node, err := NewNode(Config{ID: "me", Clock: clock, Store: NewMemoryStore(), Signer: fakeSigner{id: "me"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	return node, clock
}

// peerFrame feeds one batch from sender whose clock reads peer, received now.
// echoAt > 0 makes the sender echo this node's clock as it was at echoAt and
// held for age: a batch answering one of ours.
func peerFrame(n *Node, sender string, peer time.Duration, origin uint64, echoAt, age time.Duration) {
	batch := &pb.LeaseBatch{SenderId: sender, SenderClockMs: uint64(peer.Milliseconds()), SenderClockOrigin: origin}
	if echoAt > 0 {
		batch.EchoClockMs, batch.EchoClockOrigin, batch.EchoAgeMs = uint64(echoAt.Milliseconds()), n.clockOrigin, uint64(age.Milliseconds())
	}
	n.run(func(now time.Duration) { n.observePeerClock(sender, batch, now) })
}

// detectorRun advances the local clock and a peer clock by step for total,
// with the peer clock rate relative to ours and a per-frame delay. Every
// frame answers a frame of ours sent 20 ms before it was sealed.
type detectorRun struct {
	n     *Node
	local *manualClock
	peer  time.Duration
}

func (r *detectorRun) run(t *testing.T, total, step time.Duration, rate float64, delay func(i int) time.Duration) {
	t.Helper()
	for i, elapsed := 0, time.Duration(0); elapsed < total; i, elapsed = i+1, elapsed+step {
		r.local.now += step
		r.peer += time.Duration(float64(step) * rate)
		// A delayed frame was sealed earlier on the peer's clock and echoes
		// what it had of ours back then.
		late := delay(i)
		peerFrame(r.n, "relay", r.peer-late, 7, r.local.now-late-20*time.Millisecond, 0)
	}
}

func noDelay(int) time.Duration { return 0 }

func TestFreezeDetectorToleratesDelayJitterAndDrift(t *testing.T) {
	cases := map[string]struct {
		rate  float64
		delay func(int) time.Duration
	}{
		"steady with jitter": {1, func(i int) time.Duration { return time.Duration(i%7) * 40 * time.Millisecond }},
		"one frame delayed 5 s, then prompt ones": {1, func(i int) time.Duration {
			if i == 20 {
				return 5 * time.Second
			}
			return 0
		}},
		"every frame of the window late by 1.8 s, then prompt": {1, func(i int) time.Duration {
			if i < 40 {
				return 1800 * time.Millisecond
			}
			return 0
		}},
		"peer clock 0.5% fast": {1.005, noDelay},
		"peer clock 0.5% slow": {0.995, noDelay},
		"peer clock 0.9% fast": {1.009, noDelay},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			n, clock := newDetectorNode(t)
			r := &detectorRun{n: n, local: clock, peer: 10_000 * time.Second}
			r.run(t, 3*time.Minute, time.Second, tc.rate, tc.delay)
			if freezes := n.DrainFreezes(); len(freezes) != 0 {
				t.Fatalf("no freeze happened, detected %+v", freezes)
			}
		})
	}
}

func TestFreezeDetectorFindsALocalFreezeFromOnePeer(t *testing.T) {
	n, clock := newDetectorNode(t)
	r := &detectorRun{n: n, local: clock, peer: 10_000 * time.Second}
	r.run(t, 20*time.Second, time.Second, 1, noDelay)
	before := clock.now
	// This host is frozen for 100 s: its clock stands still, the peer's runs.
	r.peer += 100 * time.Second
	r.run(t, time.Second, time.Second, 1, noDelay)
	freezes := n.DrainFreezes()
	if len(freezes) != 1 {
		t.Fatalf("want one freeze, have %+v", freezes)
	}
	freeze := freezes[0]
	if freeze.Peer != "relay" || freeze.Since != before || freeze.Frozen < 99*time.Second || freeze.Frozen > 101*time.Second {
		t.Fatalf("freeze = %+v, want about 100 s since %s", freeze, before)
	}
	// Frames that follow are measured against the post-freeze clock.
	r.run(t, time.Minute, time.Second, 1, noDelay)
	if freezes := n.DrainFreezes(); len(freezes) != 0 {
		t.Fatalf("the same freeze was reported again: %+v", freezes)
	}
	// A second freeze is a new one.
	r.peer += 5 * time.Second
	r.run(t, time.Second, time.Second, 1, noDelay)
	if freezes := n.DrainFreezes(); len(freezes) != 1 || freezes[0].Frozen < 4*time.Second {
		t.Fatalf("second freeze not detected: %+v", freezes)
	}
}

func TestFreezeDetectorIgnoresPeerSideJumps(t *testing.T) {
	n, clock := newDetectorNode(t)
	r := &detectorRun{n: n, local: clock, peer: 10_000 * time.Second}
	r.run(t, 20*time.Second, time.Second, 1, noDelay)
	// The peer froze: its clock lags ours afterwards.
	r.peer -= 60 * time.Second
	r.run(t, 10*time.Second, time.Second, 1, noDelay)
	// The peer rebooted: a new clock origin that reads far ahead.
	for i := 0; i < 10; i++ {
		clock.now += time.Second
		peerFrame(n, "relay", 900_000*time.Second+time.Duration(i)*time.Second, 8, clock.now-20*time.Millisecond, 0)
	}
	// Frames without a clock (older senders) are ignored.
	n.run(func(now time.Duration) { n.observePeerClock("old", &pb.LeaseBatch{SenderId: "old"}, now) })
	if freezes := n.DrainFreezes(); len(freezes) != 0 {
		t.Fatalf("a peer-side jump was taken for a local freeze: %+v", freezes)
	}
}

func TestFreezeDetectedByOnePeerIsExplainedForTheOthers(t *testing.T) {
	n, clock := newDetectorNode(t)
	relay, voter := 10_000*time.Second, 77_000*time.Second
	for i := 0; i < 20; i++ {
		clock.now += time.Second
		relay += time.Second
		voter += time.Second
		peerFrame(n, "relay", relay, 1, clock.now-20*time.Millisecond, 0)
		peerFrame(n, "voter", voter, 2, clock.now-20*time.Millisecond, 0)
	}
	lastSent := clock.now - 20*time.Millisecond
	// Frozen for 90 s; the relay's beacon arrives first, the voter's frame
	// 12 s of local time later. Both echo the last frame of ours they had.
	relay += 90 * time.Second
	voter += 90 * time.Second
	clock.now += 100 * time.Millisecond
	relay += 100 * time.Millisecond
	peerFrame(n, "relay", relay, 1, lastSent, 90*time.Second)
	if freezes := n.DrainFreezes(); len(freezes) != 1 || freezes[0].Peer != "relay" {
		t.Fatalf("relay frame did not reveal the freeze: %+v", freezes)
	}
	clock.now += 12 * time.Second
	voter += 12*time.Second + 100*time.Millisecond
	peerFrame(n, "voter", voter, 2, lastSent, 102*time.Second)
	if freezes := n.DrainFreezes(); len(freezes) != 0 {
		t.Fatalf("the voter's first frame after the freeze was taken for a second freeze: %+v", freezes)
	}
}

// A stream that stalls and then delivers a burst of old frames, or a replay
// of genuine old frames, only raises offsets: frames that do not answer a
// recent frame of ours never form the reference.
func TestFreezeDetectorIgnoresStaleBurstsAndReplays(t *testing.T) {
	n, clock := newDetectorNode(t)
	peer := 10_000 * time.Second
	// Nothing heard for longer than the window, then 20 s worth of frames
	// queued during a stall arrive within half a second, echoing old frames
	// of ours, then fresh ones.
	clock.now += 2 * freezeWindow
	stallStart := peer
	for i := 0; i < 20; i++ {
		clock.now += 25 * time.Millisecond
		peerFrame(n, "relay", stallStart+time.Duration(i)*time.Second, 7, clock.now-40*time.Second+time.Duration(i)*time.Second, 0)
	}
	peer = stallStart + 40*time.Second
	for i := 0; i < 30; i++ {
		clock.now += time.Second
		peer += time.Second
		peerFrame(n, "relay", peer, 7, clock.now-20*time.Millisecond, 0)
	}
	// A replay of those old frames later on.
	for i := 0; i < 20; i++ {
		clock.now += 10 * time.Millisecond
		peerFrame(n, "relay", stallStart+time.Duration(i)*time.Second, 7, clock.now-80*time.Second, 0)
	}
	peer += time.Second
	clock.now += time.Second
	peerFrame(n, "relay", peer, 7, clock.now-20*time.Millisecond, 0)
	if freezes := n.DrainFreezes(); len(freezes) != 0 {
		t.Fatalf("stale or replayed frames were taken for a freeze: %+v", freezes)
	}
}

func TestSuspendWatchReportsOnlyBoottimeGrowth(t *testing.T) {
	gap, ok := time.Duration(0), true
	watch := NewSuspendWatchFrom(func() (time.Duration, bool) { return gap, ok })
	if got := watch.Check(); got != 0 {
		t.Fatalf("steady clocks reported %s", got)
	}
	gap += 40 * time.Second
	if got := watch.Check(); got != 40*time.Second {
		t.Fatalf("a 40 s suspend reported %s", got)
	}
	gap += 200 * time.Millisecond
	if got := watch.Check(); got != 0 {
		t.Fatalf("a sub-threshold gap reported %s", got)
	}
	ok = false
	if got := watch.Check(); got != 0 {
		t.Fatalf("unreadable clocks reported %s", got)
	}
}
