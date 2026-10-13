package broker

import (
	"context"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
)

// A relay whose sending side of a lane collapsed says so in the tunnel's
// response header, to the source and to the target (the node replaces that
// lane's connection); otherwise the header is absent.
func TestTunnelReadyCarriesTheLaneHint(t *testing.T) {
	for _, collapsed := range []bool{true, false} {
		h := newRHHarness(t)
		h.addRoute(rhRoute{id: "route-hint"})
		relay := h.startRelay("relay-a")
		relay.currentBroker().SetLaneHint(func(context.Context) bool { return collapsed })
		targetHint := make(chan bool, 1)
		target := h.startTarget(func(accepted *rhAccepted) {
			header, err := accepted.stream.Header()
			targetHint <- err == nil && len(header.Get(connector.LaneRenewHeader)) > 0
			rawEcho(accepted)
		}, relay)
		target.waitRegistered(relay)
		conn := h.dial(relay, h.sourceCert)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		stream, _, err := h.openTunnel(ctx, conn, "route-hint")
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		header, err := stream.Header()
		sourceHint := err == nil && len(header.Get(connector.LaneRenewHeader)) > 0
		var gotTarget bool
		select {
		case gotTarget = <-targetHint:
		case <-ctx.Done():
			t.Fatal("the target saw no tunnel")
		}
		cancel()
		if sourceHint != collapsed || gotTarget != collapsed {
			t.Fatalf("collapsed %v: source hint %v, target hint %v", collapsed, sourceHint, gotTarget)
		}
	}
}
