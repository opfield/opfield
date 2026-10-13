package docker

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/relaylane"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func testLaneRouter(extra int) (*relayTunnelRouter, []*relaySourceLane) {
	router := &relayTunnelRouter{plugin: &DockerPlugin{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}}
	router.primaryLane = &relaySourceLane{}
	lanes := make([]*relaySourceLane, extra)
	for i := range lanes {
		lanes[i] = &relaySourceLane{socket: &connector.LaneSocket{}}
		lanes[i].origin = lanes[i]
	}
	router.extraLanes = lanes
	return router, lanes
}

// Tunnels go to the extra lanes, whose connections can be replaced; the
// primary lane takes them only while no extra lane is connected.
func TestSourceLanePrefersExtraLanes(t *testing.T) {
	router, lanes := testLaneRouter(2)
	lanes[0].active.Store(1)
	if got := router.sourceLane(); got != lanes[1] {
		t.Fatal("the least busy extra lane was not picked")
	}
	if got := router.sourceLane(); got == router.primaryLane {
		t.Fatal("the primary lane took a tunnel while extra lanes were connected")
	}
	router.extraLanes = nil
	if got := router.sourceLane(); got != router.primaryLane {
		t.Fatal("without extra lanes a tunnel did not go to the primary lane")
	}
}

// A rotation puts the new connection in the lane's place, keeps the old one
// out of selection until its tunnels ended, and closes only connections the
// router dialled; a lane rotates at most once per relaylane.Every.
func TestRotateLaneReplacesTheConnection(t *testing.T) {
	router, lanes := testLaneRouter(1)
	old := lanes[0]
	old.conn = newTestConn(t)
	old.active.Store(1)
	dialled := 0
	laneDialers.Store(old.conn, func(context.Context) (*grpc.ClientConn, error) {
		dialled++
		return newTestConn(t), nil
	})
	t.Cleanup(func() { laneDialers.Delete(old.conn) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	router.rotating = true
	router.rotateLane(ctx, old, "collapsed", time.Now())
	if dialled != 1 || router.rotating {
		t.Fatalf("dialled %d, rotating %v", dialled, router.rotating)
	}
	replacement := router.extraLanes[0]
	if replacement == old || !replacement.rotated || replacement.origin != old || !old.retiring {
		t.Fatal("the old connection was not replaced")
	}
	if len(router.extraLanes) != 1 {
		t.Fatal("the old connection stayed selectable next to its replacement")
	}
	router.closeEmptyRetiringLanes()
	if len(router.retiringLanes) != 1 {
		t.Fatal("a retiring lane with a tunnel was dropped")
	}
	old.active.Store(0)
	router.closeEmptyRetiringLanes()
	if len(router.retiringLanes) != 0 || old.conn.GetState().String() == "SHUTDOWN" {
		t.Fatalf("retiring %d, pool connection %v (the pool owns it)", len(router.retiringLanes), old.conn.GetState())
	}
	// The replacement collapses too, at once: its slot rotated a moment ago.
	now := time.Now()
	router.laneRotatedAt = map[*relaySourceLane]time.Time{old: now}
	replacement.trigger.NoteHeader(map[string][]string{connector.LaneRenewHeader: {"1"}})
	if lane, _ := router.laneToRotate(now.Add(relaylane.Spacing)); lane != nil {
		t.Fatal("a lane rotated twice within relaylane.Every")
	}
	router.removeLane(old)
	if len(router.extraLanes) != 0 || replacement.conn.GetState().String() != "SHUTDOWN" {
		t.Fatal("removing the pool lane left its replacement open")
	}
}

func newTestConn(t *testing.T) *grpc.ClientConn {
	t.Helper()
	conn, err := grpc.NewClient("passthrough:///127.0.0.1:1", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}
