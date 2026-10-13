package relaylane

import (
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/slowstart"
)

// A lane is rotated when its own sending side collapsed, when the relay says
// its side did, or when its round trip under bulk data grew far beyond the
// one it learned on; not for a round trip measured on small writes.
func TestReason(t *testing.T) {
	ms := func(d int) uint32 { return uint32(d * 1000) }
	trigger := &Trigger{}
	state := func(sent, received uint64, rttMs, rcvRTTMs int) slowstart.State {
		return slowstart.State{SlowStartThreshold: slowstart.InfiniteThreshold, BytesAcked: sent, BytesReceived: received,
			RTTUs: ms(rttMs), RcvRTTUs: ms(rcvRTTMs)}
	}
	if why := trigger.Reason(state(1000, 1000, 1, 1), true); why != "" {
		t.Fatalf("first look: %q", why)
	}
	// A LAN download: the lane learns the receiver's 1 ms, not its own 40 ms (delayed acks of its small writes).
	if why := trigger.Reason(state(2000, 1000+BulkBytes, 40, 1), true); why != "" || trigger.bulkRTT != time.Millisecond {
		t.Fatalf("LAN bulk: %q, learned %v", why, trigger.bulkRTT)
	}
	if why := trigger.Reason(state(3000, 2000+BulkBytes, 60, 60), true); why != "" {
		t.Fatalf("small writes: %q", why)
	}
	if why := trigger.Reason(state(4000, 2000+3*BulkBytes, 90, 60), true); why != "" {
		t.Fatalf("one look after the round trip grew: %q", why)
	}
	if why := trigger.Reason(state(5000, 2000+5*BulkBytes, 90, 60), true); why != "round_trip_grew" {
		t.Fatalf("download after the round trip grew: %q", why)
	}
	// An upload under a threshold the lane learned on the LAN (large enough not to be slow at 60 ms).
	learnedState := func(sent uint64, rttMs int) slowstart.State {
		return slowstart.State{SlowStartThreshold: 2400, BytesAcked: sent, BytesReceived: 1000, RTTUs: ms(rttMs), MSS: 1448}
	}
	upload := &Trigger{}
	upload.Reason(learnedState(1000, 1), true)
	upload.Reason(learnedState(1000+BulkBytes, 1), true)
	upload.Reason(learnedState(1000+3*BulkBytes, 60), true)
	if why := upload.Reason(learnedState(1000+5*BulkBytes, 60), true); why != "round_trip_grew" {
		t.Fatalf("upload after the round trip grew: %q", why)
	}
	if why := idleLooks(&Trigger{}, slowstart.State{SlowStartThreshold: 7, BytesAcked: CarriedBytes, RTTUs: ms(60)}); why != "collapsed" {
		t.Fatalf("collapsed sender: %q", why)
	}
	if why := idleLooks(&Trigger{}, slowstart.State{SlowStartThreshold: 7, BytesAcked: CarriedBytes, RTTUs: ms(1)}); why != "" {
		t.Fatalf("a small threshold on a LAN: %q", why)
	}
	// A threshold learned on the LAN (411 segments) on a 150 ms leg: rotated while the lane sends bulk data, not while
	// it idles; a large one (CUBIC after a loss at the path's rate) stays.
	lanState := func(sent uint64, ssthresh uint32) slowstart.State {
		return slowstart.State{SlowStartThreshold: ssthresh, BytesAcked: sent, RTTUs: ms(150), MSS: 1448}
	}
	slow := &Trigger{}
	slow.Reason(lanState(1000, 411), true)
	if why := slow.Reason(lanState(2000, 411), true); why != "" {
		t.Fatalf("idle lane with a small threshold: %q", why)
	}
	if why := slow.Reason(lanState(2000+BulkBytes, 411), true); why != "slow_threshold" {
		t.Fatalf("bulk under a LAN threshold: %q", why)
	}
	fresh := &Trigger{}
	fresh.Reason(lanState(1000, 2400), true)
	if why := fresh.Reason(lanState(1000+BulkBytes, 2400), true); why != "" {
		t.Fatalf("bulk under a path-sized threshold: %q", why)
	}
	// A lane that never carried bulk data on the LAN: its first bulk at 150 ms is measured against the shortest round
	// trip it showed (2 ms).
	quiet := &Trigger{}
	quiet.Reason(state(1000, 1000, 2, 0), true)
	quiet.Reason(state(1100, 1100, 150, 0), true)
	quiet.Reason(state(1200, 1100+BulkBytes, 150, 150), true)
	if why := quiet.Reason(state(1300, 1100+2*BulkBytes, 150, 150), true); why != "round_trip_grew" {
		t.Fatalf("first bulk after the round trip grew: %q", why)
	}
	far := &Trigger{}
	far.Reason(state(1000, 1000, 150, 0), true)
	far.Reason(state(1100, 1000+BulkBytes, 150, 150), true)
	if why := far.Reason(state(1200, 1000+2*BulkBytes, 150, 150), true); why != "" {
		t.Fatalf("a lane that always ran at 150 ms: %q", why)
	}
	hinted := &Trigger{}
	hinted.NoteHeader(map[string][]string{connector.LaneRenewHeader: {"1"}})
	if why := hinted.Reason(slowstart.State{}, false); why != "relay_collapsed" {
		t.Fatalf("relay's word: %q", why)
	}
	hinted.ClearHint()
	if why := hinted.Reason(slowstart.State{}, false); why != "" {
		t.Fatalf("after ClearHint: %q", why)
	}
}

// idleLooks looks at an idle lane (no bytes moving) until it is idle long enough and returns the last reason.
func idleLooks(trigger *Trigger, state slowstart.State) string {
	why := ""
	for range IdleChecks + 1 {
		why = trigger.Reason(state, true)
	}
	return why
}

// A busy LAN lane after an ordinary loss (stand rc.9: 110 MB/s to the local relay, cwnd and ssthresh 26, srtt 5-19 ms
// from the host's queues) is never rotated: not while it delivers, and not once it idles, since its threshold is worth
// line rate at its path's round trip. Not on the relay's word while it delivers either.
func TestBusyLANLaneWithALossIsNotRotated(t *testing.T) {
	const perCheck = 110 << 20 / 4
	lane := func(sent uint64, srttMs int) slowstart.State {
		return slowstart.State{SlowStartThreshold: 26, BytesAcked: sent, RTTUs: uint32(srttMs * 1000), MinRTTUs: 180,
			MSS: 1448, DeliveryRate: 110 << 20}
	}
	trigger := &Trigger{}
	sent := uint64(1 << 30)
	for i, srtt := range []int{5, 8, 12, 19, 15, 10, 8} {
		sent += perCheck
		if why := trigger.Reason(lane(sent, srtt), true); why != "" {
			t.Fatalf("look %d at srtt %d ms while moving 110 MB/s: %q", i, srtt, why)
		}
	}
	trigger.NoteHeader(map[string][]string{connector.LaneRenewHeader: {"1"}})
	sent += perCheck
	if why := trigger.Reason(lane(sent, 15), true); why != "" {
		t.Fatalf("relay's word while the lane delivers: %q", why)
	}
	trigger.ClearHint()
	idle := lane(sent, 15)
	idle.DeliveryRate, idle.LastDataSentMs = 0, 5000
	if why := idleLooks(trigger, idle); why != "" {
		t.Fatalf("the same lane idle: %q", why)
	}
	// Without the kernel's minimum the lane's shortest smoothed round trip stands in.
	noMin := &Trigger{}
	noMin.Reason(slowstart.State{SlowStartThreshold: 26, BytesAcked: 1000, RTTUs: 400, MSS: 1448}, true)
	if why := idleLooks(noMin, slowstart.State{SlowStartThreshold: 26, BytesAcked: 1000, RTTUs: 15_000, MSS: 1448}); why != "" {
		t.Fatalf("idle LAN lane without the kernel's minimum: %q", why)
	}
}

// An idle lane on a far path left with a tiny threshold by a retransmission timeout is rotated: its next transfer
// would start slow. Not before it has been idle for IdleChecks looks.
func TestIdleLaneAfterTimeoutIsRotated(t *testing.T) {
	far := slowstart.State{SlowStartThreshold: 4, BytesAcked: 5 << 20, RTTUs: 62_000, MinRTTUs: 60_000, MSS: 1448,
		DeliveryRate: 300 << 10, LastDataSentMs: 3000}
	trigger := &Trigger{}
	for i := range IdleChecks - 1 {
		if why := trigger.Reason(far, true); why != "" {
			t.Fatalf("look %d, not idle long enough: %q", i, why)
		}
	}
	if why := trigger.Reason(far, true); why != "collapsed" {
		t.Fatalf("idle far lane after a timeout: %q", why)
	}
}

// A far lane whose round trip grew (learned on 1 ms, now 60 ms) and that moves a download at a few MB/s is rotated on
// the second look; the same growth at line rate is not.
func TestFarLaneAfterRoundTripGrowthIsRotated(t *testing.T) {
	look := func(trigger *Trigger, received uint64, rcvRTTMs int) string {
		return trigger.Reason(slowstart.State{SlowStartThreshold: slowstart.InfiniteThreshold, BytesAcked: 1000,
			BytesReceived: received, RTTUs: 40_000, RcvRTTUs: uint32(rcvRTTMs * 1000), MSS: 1448}, true)
	}
	slow := &Trigger{}
	look(slow, 1000, 1)
	look(slow, 1000+2*BulkBytes, 1)
	if why := look(slow, 1000+4*BulkBytes, 60); why != "" {
		t.Fatalf("first look at 60 ms: %q", why)
	}
	if why := look(slow, 1000+6*BulkBytes, 60); why != "round_trip_grew" {
		t.Fatalf("download at 2 MB/s after the round trip grew: %q", why)
	}
	fast := &Trigger{}
	look(fast, 1000, 1)
	look(fast, 1000+2*BulkBytes, 1)
	received := uint64(1000 + 2*BulkBytes)
	for i := range 4 {
		received += 2 * BusyBytes
		if why := look(fast, received, 60); why != "" {
			t.Fatalf("look %d, download at line rate after the round trip grew: %q", i, why)
		}
	}
}

// Inside Every a lane rotates again only when that moves no stream carrying data, and not before EveryCheap (stand
// rc.9 F-4).
func TestMayRotate(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cheap := func() bool { return true }
	costly := func() bool { return false }
	switch {
	case !MayRotate(time.Time{}, now, costly):
		t.Fatal("a lane never rotated")
	case !MayRotate(now.Add(-Every), now, costly):
		t.Fatal("a lane rotated Every ago")
	case MayRotate(now.Add(-EveryCheap+time.Second), now, cheap):
		t.Fatal("a cheap lane before EveryCheap")
	case !MayRotate(now.Add(-EveryCheap), now, cheap):
		t.Fatal("a cheap lane after EveryCheap")
	case MayRotate(now.Add(-5*time.Minute), now, costly):
		t.Fatal("a lane moving busy streams inside Every")
	}
}

// An idle lane whose round trip grew to a far path (srtt 61 ms, the kernel's minimum still the LAN's) with a
// threshold learned on the LAN is rotated before its next transfer starts.
func TestIdleLaneAfterRoundTripGrowthIsRotated(t *testing.T) {
	grown := slowstart.State{SlowStartThreshold: 300, BytesAcked: 5 << 20, RTTUs: 61_000, MinRTTUs: 900, MSS: 1448}
	if why := idleLooks(&Trigger{}, grown); why != "collapsed" {
		t.Fatalf("idle lane after the round trip grew: %q", why)
	}
	fresh := grown
	fresh.SlowStartThreshold = slowstart.InfiniteThreshold
	if why := idleLooks(&Trigger{}, fresh); why != "" {
		t.Fatalf("idle grown lane that never left a slow start: %q", why)
	}
}

// A lane connection that only carried its handshake and keepalives is not replaced while idle, whatever its state
// says (stand rc.10 O-3: idle lanes to far relays, replaced with tunnels_left 0, were replaced again every 30 s); once
// it carried bulk data and its state is stale it is.
func TestFreshIdleLaneIsNotRotatedUntilItCarriedData(t *testing.T) {
	// A replacement on a 60 ms path whose keepalive was lost once (a timeout left a threshold of 5 segments).
	fresh := slowstart.State{SlowStartThreshold: 5, BytesAcked: 80 << 10, BytesReceived: 60 << 10, RTTUs: 61_000,
		MinRTTUs: 60_000, MSS: 1448, LastDataSentMs: 4000}
	trigger := &Trigger{}
	for i := range 40 {
		fresh.BytesAcked += 100
		if why := trigger.Reason(fresh, true); why != "" {
			t.Fatalf("look %d of an idle lane that never carried data: %q", i, why)
		}
	}
	// It carries a transfer, and is left with a small threshold: rotated once idle.
	carried := fresh
	carried.BytesReceived += 4 * BulkBytes
	carried.SlowStartThreshold = slowstart.InfiniteThreshold
	carried.RcvRTTUs = 61_000
	if why := trigger.Reason(carried, true); why != "" {
		t.Fatalf("a look with bulk data: %q", why)
	}
	carried.SlowStartThreshold = 5
	if why := idleLooks(trigger, carried); why != "collapsed" {
		t.Fatalf("idle stale lane after it carried data: %q", why)
	}
}

// An upload on a lane whose sender is in its first slow start, or set its threshold during this transfer, is not
// moved to a new connection when the round trip is far above the one the lane learned on: a new connection would start
// the same way (stand rc.10 O-4: the first Route Secure Link PUT at farboth150 moved a second in, 8.5 MB/s).
func TestUploadInAFreshSlowStartIsNotMovedAfterGrowth(t *testing.T) {
	look := func(trigger *Trigger, sent uint64, ssthresh uint32, rttMs int) string {
		return trigger.Reason(slowstart.State{SlowStartThreshold: ssthresh, BytesAcked: sent, BytesReceived: 1000,
			RTTUs: uint32(rttMs * 1000), MinRTTUs: 300, MSS: 1448}, true)
	}
	trigger := &Trigger{}
	look(trigger, 1000, slowstart.InfiniteThreshold, 1)
	sent := uint64(1000)
	for i := range 8 {
		sent += 2 * BulkBytes
		if why := look(trigger, sent, slowstart.InfiniteThreshold, 300); why != "" {
			t.Fatalf("look %d in the first slow start at 300 ms: %q", i, why)
		}
	}
	// HyStart ends the slow start at the path's rate: learned here, not a reason either.
	for i, ssthresh := range []uint32{4000, 4000, 4000} {
		sent += 2 * BulkBytes
		if why := look(trigger, sent, ssthresh, 300+i); why != "" {
			t.Fatalf("look %d after the threshold was set at 300 ms: %q", i, why)
		}
	}
}

// A lane whose round trip grew from the LAN's to 150 ms and whose sender
// collapsed then (a threshold of 17 segments) is rotated before the next
// upload, also when it never carried bulk data, and not while it receives a
// download; a fresh lane dialed on the longer path is not (stand rc.11 F-1,
// rc.10 O-3).
func TestStaleSenderAfterGrowthIsRotatedBeforeTheUpload(t *testing.T) {
	lan := slowstart.State{SlowStartThreshold: slowstart.InfiniteThreshold, BytesAcked: 60 << 10, BytesReceived: 50 << 10,
		RTTUs: 900, MinRTTUs: 300, MSS: 1448}
	trigger := &Trigger{}
	trigger.Reason(lan, true)
	grown := lan
	grown.SlowStartThreshold, grown.RTTUs, grown.MinRTTUs = 17, 157_000, 400
	// A download runs on the lane meanwhile: not moved.
	for i := range IdleChecks + 2 {
		grown.BytesReceived += 2 * BulkBytes
		if why := trigger.Reason(grown, true); why != "" {
			t.Fatalf("look %d while the lane receives a download: %q", i, why)
		}
	}
	// The download ended: rotated at the next look, before the upload.
	if why := trigger.Reason(grown, true); why != "collapsed" {
		t.Fatalf("stale sender after the round trip grew: %q", why)
	}
	// The kernel's minimum alone (the trigger never saw the LAN round trip).
	kernelOnly := grown
	if why := idleLooks(&Trigger{}, kernelOnly); why != "collapsed" {
		t.Fatalf("stale sender, LAN minimum from the kernel: %q", why)
	}
	// A replacement dialed on the 150 ms path whose keepalive timed out once.
	far := grown
	far.MinRTTUs, far.BytesAcked, far.BytesReceived = 150_000, 60<<10, 50<<10
	fresh := &Trigger{}
	for i := range 40 {
		if why := fresh.Reason(far, true); why != "" {
			t.Fatalf("look %d of a fresh lane on the far path: %q", i, why)
		}
	}
}
