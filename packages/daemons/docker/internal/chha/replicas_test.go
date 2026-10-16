package chha

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// The holder drops the replicas of a member that left the set, on the second
// sweep that finds them inactive; members of the set (also one being
// removed), active replicas and names that are no member id are kept.
func TestHolderDropsTheReplicasOfRemovedMembers(t *testing.T) {
	removed := testMemberC
	activeGone := "77777777-7777-4777-8777-777777777777"
	config := testConfig(memberha.ModeAutomatic, pairEngineConfig(), testMemberA, testMemberB)
	config.Members[1].Removing = true
	rt := newFakeRuntime(config)
	var mu sync.Mutex
	dropped := map[string]bool{}
	rt.answers = func(query string) (string, error) {
		switch {
		case strings.HasPrefix(query, "SELECT name FROM system.zookeeper WHERE path = '/gw/db' "):
			return "app\n", nil
		case strings.HasPrefix(query, "SELECT name FROM system.zookeeper WHERE path = '/gw/db/app/replicas' "):
			mu.Lock()
			defer mu.Unlock()
			names := []string{"s1|" + testMemberA, "s1|" + testMemberB, "s1|" + activeGone, "s1|not-a-member", "s2|" + removed}
			if !dropped["db"] {
				names = append(names, "s1|"+removed)
			}
			return strings.Join(names, "\n") + "\n", nil
		case strings.Contains(query, "AND name = 'active'"):
			if strings.Contains(query, activeGone) {
				return "1\n", nil
			}
			return "0\n", nil
		case strings.HasPrefix(query, "SYSTEM DROP REPLICA"):
			mu.Lock()
			dropped["tables"] = true
			mu.Unlock()
		case strings.HasPrefix(query, "SYSTEM DROP DATABASE REPLICA"):
			mu.Lock()
			dropped["db"] = true
			mu.Unlock()
		}
		return "", nil
	}
	e := newTestEngine(t, rt)
	snap := &configSnapshot{config: config, ec: pairEngineConfig()}
	ctx := context.Background()
	drops := func() []string {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		var out []string
		for _, query := range rt.queries {
			if strings.HasPrefix(query, "SYSTEM DROP") {
				out = append(out, query)
			}
		}
		return out
	}

	start := time.Hour
	e.holderDropRemovedReplicas(ctx, snap, start)
	if got := drops(); len(got) != 0 {
		t.Fatalf("dropped on the first sweep: %q", got)
	}
	// Within the sweep period nothing is asked again.
	e.holderDropRemovedReplicas(ctx, snap, start+time.Minute)
	if got := drops(); len(got) != 0 {
		t.Fatalf("dropped within the grace: %q", got)
	}
	e.holderDropRemovedReplicas(ctx, snap, start+replicaSweepPeriod)
	want := []string{
		"SYSTEM DROP REPLICA '" + removed + "' FROM DATABASE `app`",
		"SYSTEM DROP DATABASE REPLICA '" + removed + "' FROM SHARD 's1' FROM DATABASE `app`",
	}
	if got := drops(); !slices.Equal(got, want) {
		t.Fatalf("drops %q, want %q", got, want)
	}
	// Dropped: the next sweep finds nothing more to drop.
	e.holderDropRemovedReplicas(ctx, snap, start+3*replicaSweepPeriod)
	if got := drops(); len(got) != 2 {
		t.Fatalf("drops after the replica is gone: %q", got)
	}
	e.mu.Lock()
	left := len(e.removedReplicas)
	e.mu.Unlock()
	if left != 0 {
		t.Fatalf("removed replicas still tracked: %d", left)
	}
}

// A replica that reappears as a member (or becomes active) before its grace
// ran out is not dropped.
func TestHolderKeepsAReplicaThatComesBack(t *testing.T) {
	config := testConfig(memberha.ModeAutomatic, pairEngineConfig(), testMemberA, testMemberB)
	rt := newFakeRuntime(config)
	rt.answers = func(query string) (string, error) {
		switch {
		case strings.HasPrefix(query, "SELECT name FROM system.zookeeper WHERE path = '/gw/db' "):
			return "app\n", nil
		case strings.HasPrefix(query, "SELECT name FROM system.zookeeper WHERE path = '/gw/db/app/replicas' "):
			return "s1|" + testMemberA + "\ns1|" + testMemberC + "\n", nil
		case strings.Contains(query, "AND name = 'active'"):
			return "0\n", nil
		}
		return "", nil
	}
	e := newTestEngine(t, rt)
	ctx := context.Background()
	e.holderDropRemovedReplicas(ctx, &configSnapshot{config: config, ec: pairEngineConfig()}, time.Hour)
	// Member C joins before the next sweep.
	joined := testConfig(memberha.ModeAutomatic, pairEngineConfig(), testMemberA, testMemberB, testMemberC)
	e.holderDropRemovedReplicas(ctx, &configSnapshot{config: joined, ec: pairEngineConfig()}, time.Hour+replicaSweepPeriod)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for _, query := range rt.queries {
		if strings.HasPrefix(query, "SYSTEM DROP") {
			t.Fatalf("dropped a member's replica: %s", query)
		}
	}
}
