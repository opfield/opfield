package chha

import (
	"testing"
	"time"
)

func TestEligibility(t *testing.T) {
	sync := policy{synchronous: true, degradeAfter: 10 * time.Second, members: 2}
	async := policy{degradeAfter: 10 * time.Second, members: 2}
	healthy := sample{keeperQuorum: true, tables: 3, minActive: 2}
	cases := []struct {
		name   string
		p      policy
		v      Value
		mine   bool
		s      sample
		ok     bool
		reason string
	}{
		{"healthy sync", sync, Value{Quorum: 2}, false, healthy, true, ""},
		{"no keeper quorum", sync, Value{Quorum: 2}, false, sample{tables: 1}, false, "keeper_no_quorum"},
		{"readonly replica", sync, Value{Quorum: 2}, false, sample{keeperQuorum: true, readonly: 1}, false, "replicas_readonly"},
		{"databases syncing", sync, Value{Quorum: 2}, false, sample{keeperQuorum: true, dbSyncing: true}, false, "databases_syncing"},
		{"too far behind", async, Value{Quorum: 1}, false, sample{keeperQuorum: true, delay: 11 * time.Second}, false, "replication_delay"},
		{"degraded copy", sync, Value{Quorum: 1, Degraded: true}, false, healthy, false, "degraded"},
		{"degraded certifier", sync, Value{Quorum: 1, Degraded: true}, true, healthy, true, ""},
		{"async ignores degraded", async, Value{Quorum: 1}, false, sample{keeperQuorum: true, delay: 9 * time.Second}, true, ""},
	}
	for _, c := range cases {
		ok, reason := eligible(c.p, c.v, c.mine, c.s)
		if ok != c.ok || reason != c.reason {
			t.Errorf("%s: got %v %q, want %v %q", c.name, ok, reason, c.ok, c.reason)
		}
	}
}

// AS5 order: degraded is certified before the engine drops to quorum 1, and
// the engine runs quorum 2 again before healthy is certified.
func TestDegradeAndRestoreOrder(t *testing.T) {
	p := policy{synchronous: true, degradeAfter: 10 * time.Second, members: 2}
	var tracker degradeTracker
	value := Value{Quorum: 2}
	at := func(seconds int) time.Duration { return time.Duration(seconds) * time.Second }
	down := sample{keeperQuorum: true, tables: 2, minActive: 1, quorum: 2}
	if _, _, changed := tracker.next(p, value, down, at(100), time.Now()); changed {
		t.Fatal("degraded at once")
	}
	if engineQuorum(p, value, down, 0) != 2 {
		t.Fatal("the engine must keep quorum 2 until degraded is certified")
	}
	next, kind, changed := tracker.next(p, value, down, at(110), time.Now())
	if !changed || kind != "degraded" || !next.Degraded || next.Quorum != 1 {
		t.Fatalf("after degradeAfter: %+v %s %v", next, kind, changed)
	}
	value = next
	if engineQuorum(p, value, down, 0) != 1 {
		t.Fatal("certified degraded: the engine falls back to quorum 1")
	}
	up := sample{keeperQuorum: true, tables: 2, minActive: 2, quorum: 1}
	if _, _, changed := tracker.next(p, value, up, at(120), time.Now()); changed {
		t.Fatal("restored at once")
	}
	if engineQuorum(p, value, up, at(6)) != 2 {
		t.Fatal("before restoring, the engine runs quorum 2 again")
	}
	if _, _, changed := tracker.next(p, value, up, at(131), time.Now()); changed {
		t.Fatal("restored while the engine still ran quorum 1")
	}
	up.quorum = 2
	next, kind, changed = tracker.next(p, value, up, at(132), time.Now())
	if !changed || kind != "restored" || next.Degraded || next.Quorum != 2 {
		t.Fatalf("restore: %+v %s %v", next, kind, changed)
	}
	// Asynchronous sets run quorum 1 and are never degraded.
	async := policy{members: 2}
	next, _, changed = tracker.next(async, Value{Quorum: 2}, up, at(200), time.Now())
	if !changed || next.Quorum != 1 || next.Degraded {
		t.Fatalf("async: %+v", next)
	}
	// A set without replicated tables has nothing to wait for.
	if !(sample{}).copiesActive(p) {
		t.Fatal("no tables counts as active")
	}
}

func TestValueEncoding(t *testing.T) {
	encoded, err := Value{Quorum: 0}.encode()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeValue(encoded)
	if err != nil || decoded.Quorum != 1 || decoded.V != 1 {
		t.Fatalf("decoded %+v %v", decoded, err)
	}
	if _, err := DecodeValue([]byte(`{"v":9}`)); err == nil {
		t.Fatal("unknown version accepted")
	}
	if v, err := DecodeValue(nil); err != nil || v.Degraded {
		t.Fatal("empty value")
	}
}
