package daemon

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaylane"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func testLanePlugin(dataOnly int) (*NginxPlugin, *nginxRelayTunnel, []*nginxRelayTunnel) {
	p := &NginxPlugin{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	watch := &nginxRelayTunnel{ctx: context.Background(), targetID: "relay-a"}
	watch.origin = watch
	p.relayTunnels = append(p.relayTunnels, watch)
	lanes := make([]*nginxRelayTunnel, dataOnly)
	for i := range lanes {
		lanes[i] = &nginxRelayTunnel{ctx: context.Background(), targetID: "relay-a", dataOnly: true, socket: &connector.LaneSocket{}}
		lanes[i].origin = lanes[i]
		p.relayTunnels = append(p.relayTunnels, lanes[i])
	}
	return p, watch, lanes
}

// Tunnels go to the data-only lanes, whose connections can be replaced; the lease-watch lanes take them only while no
// data-only lane is connected.
func TestSelectRelayTunnelPrefersDataOnlyLanes(t *testing.T) {
	p, watch, lanes := testLanePlugin(2)
	lanes[0].active.Store(1)
	if got := p.selectRelayTunnel("relay-a"); got != lanes[1] {
		t.Fatal("the least busy data-only lane was not picked")
	}
	if got := p.selectRelayTunnel("relay-a"); got == watch {
		t.Fatal("a lease-watch lane took a tunnel while data-only lanes were connected")
	}
	p.relayTunnels = p.relayTunnels[:1]
	if got := p.selectRelayTunnel("relay-a"); got != watch {
		t.Fatal("without data-only lanes a tunnel did not go to the lease-watch lane")
	}
}

// The bundle's lanes watch the lease gates; the lanes past them are data-only.
func TestRelayTunnelLaneCountAddsDataOnlyLanes(t *testing.T) {
	p := &NginxPlugin{relayGrants: &relayGrantStore{changed: make(chan struct{}, 1), current: &pb.SyncRelayGrantsCommand{DataLanes: 3}}}
	if got := p.RelayTunnelLaneCount(); got != 3+nginxDataOnlyLanes {
		t.Fatalf("lanes %d, want %d", got, 3+nginxDataOnlyLanes)
	}
}

// A rotation puts the new connection in the lane's place, keeps the old one out of selection until its tunnels ended,
// and closes only connections the daemon dialled; a slot rotates at most once per relaylane.Every.
func TestReplaceRelayLaneReplacesTheConnection(t *testing.T) {
	p, _, lanes := testLanePlugin(1)
	old := lanes[0]
	old.conn = newLaneTestConn(t)
	old.active.Store(1)
	dialled := 0
	p.RelayLaneDialer(old.conn, 4, func(context.Context) (*grpc.ClientConn, error) {
		dialled++
		return newLaneTestConn(t), nil
	})
	t.Cleanup(func() { nginxLaneDialers.Delete(old.conn) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p.relayLaneRotations = map[string]*relayLaneRotation{"relay-a": {rotating: true}}
	p.relayLaneRotatedAt = map[*nginxRelayTunnel]time.Time{}
	p.replaceRelayLane(ctx, old, "collapsed")
	if dialled != 1 || p.relayLaneRotations["relay-a"].rotating {
		t.Fatalf("dialled %d, rotating %v", dialled, p.relayLaneRotations["relay-a"].rotating)
	}
	replacement := p.relayTunnels[1]
	if replacement == old || !replacement.rotated || replacement.origin != old || !old.retiring || !replacement.dataOnly {
		t.Fatal("the old connection was not replaced")
	}
	if len(p.relayTunnels) != 2 {
		t.Fatal("the old connection stayed selectable next to its replacement")
	}
	p.closeEmptyRetiringRelayLanes(old)
	if len(p.retiringRelayTunnels) != 1 {
		t.Fatal("a retiring lane with a tunnel was dropped")
	}
	old.active.Store(0)
	p.closeEmptyRetiringRelayLanes(old)
	if len(p.retiringRelayTunnels) != 0 || old.conn.GetState().String() == "SHUTDOWN" {
		t.Fatalf("retiring %d, pool connection %v (the pool owns it)", len(p.retiringRelayTunnels), old.conn.GetState())
	}
	// The replacement collapses too, at once: its slot rotated a moment ago.
	now := time.Now()
	p.relayLaneRotatedAt[old] = now
	replacement.trigger.NoteHeader(map[string][]string{connector.LaneRenewHeader: {"1"}})
	if lane, _ := p.relayLaneToRotate(old, now.Add(relaylane.Spacing)); lane != nil {
		t.Fatal("a slot rotated twice within relaylane.Every")
	}
	p.removeRelayLane(old)
	if len(p.relayTunnels) != 1 || replacement.conn.GetState().String() != "SHUTDOWN" {
		t.Fatal("removing the pool lane left its replacement open")
	}
}

func newLaneTestConn(t *testing.T) *grpc.ClientConn {
	t.Helper()
	conn, err := grpc.NewClient("passthrough:///127.0.0.1:1", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}
