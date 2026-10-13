package lifecycle

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/relaybridge"
)

// A relay the daemon has not measured yet (it joined or came back) is
// measured on the next tick; the others every sample interval.
func TestRelayLatencyProbesMeasureNewRelaysAtOnce(t *testing.T) {
	probed := map[string]time.Time{}
	now := time.Unix(1000, 0)
	ids := func(targets []RelayTunnelTarget) []string {
		result := []string{}
		for _, target := range targets {
			result = append(result, target.ID)
		}
		return result
	}
	local, uk, nl := RelayTunnelTarget{ID: "relay-local"}, RelayTunnelTarget{ID: "relay-uk"}, RelayTunnelTarget{ID: "relay-nl"}
	if due := ids(dueRelayLatencyTargets([]RelayTunnelTarget{local, uk}, probed, now, 30*time.Second)); len(due) != 2 {
		t.Fatalf("first tick probed %v", due)
	}
	now = now.Add(relayLatencyTick)
	if due := ids(dueRelayLatencyTargets([]RelayTunnelTarget{local, uk, nl}, probed, now, 30*time.Second)); len(due) != 1 || due[0] != "relay-nl" {
		t.Fatalf("the relay that came back was not probed at once: %v", due)
	}
	now = now.Add(30 * time.Second)
	if due := ids(dueRelayLatencyTargets([]RelayTunnelTarget{local, nl}, probed, now, 30*time.Second)); len(due) != 2 {
		t.Fatalf("an interval later probed %v", due)
	}
	if _, kept := probed["relay-uk"]; kept {
		t.Fatal("a relay no longer listed is still remembered")
	}
}

// A probe that cannot reach a relay marks it failing, keeping its measured
// round trip; one that reaches it clears the mark.
func TestRelayLatencyProbeMarksAnUnreachableRelayFailing(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	tracker := relaybridge.NewLatencyTracker(time.Now)
	target := RelayTunnelTarget{ID: "relay-nl", Addresses: []string{address}}
	probeRelayLatencies(context.Background(), []RelayTunnelTarget{target}, nil, liveRelayTransports, "", tracker)
	if rtt, ok := tracker.RTT("relay-nl"); !ok || rtt <= 0 {
		t.Fatalf("no round trip measured: %v %v", rtt, ok)
	}
	_ = listener.Close()
	probeRelayLatencies(context.Background(), []RelayTunnelTarget{target}, nil, liveRelayTransports, "", tracker)
	time.Sleep(5 * time.Millisecond)
	samples := tracker.Samples()
	if len(samples) != 1 || samples[0].GetFailingMs() == 0 {
		t.Fatalf("an unreachable relay is not failing: %v", samples)
	}
	if _, ok := tracker.RTT("relay-nl"); !ok {
		t.Fatal("the measured round trip was dropped")
	}
}
