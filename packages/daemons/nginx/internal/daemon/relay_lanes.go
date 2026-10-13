package daemon

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/relaylane"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

// nginxDataOnlyLanes is how many lanes per relay the daemon opens beyond the bundle's for tunnels alone.
//
// A lane is one long-lived TCP connection, and TCP keeps what it learned of its path for the life of the connection:
// after a retransmission timeout, or after the lane's round trip grew far beyond the one it learned on, a transfer that
// starts on it ramps up in congestion avoidance from a few segments and takes tens of seconds to reach the rate a new
// connection reaches in a second (stand rc.8 F-1). The bundle's lanes also watch the availability lease gates for their
// whole life, so their connections cannot be replaced; the data-only lanes carry no such stream, new tunnels go to
// them, and one whose connection is no longer worth keeping is rotated (rotateRelayLane): the daemon dials a new
// connection like it, new tunnels go there at once, the resumable streams on the old one move over with a planned move,
// and the old one carries its other tunnels until they end.
const nginxDataOnlyLanes = 2

// relayLaneRotation is one relay's rotation state: at most one rotation at a time, relaylane.Spacing apart.
type relayLaneRotation struct {
	rotating bool
	last     time.Time
}

type nginxLaneDialer struct {
	index int
	dial  func(context.Context) (*grpc.ClientConn, error)
}

// nginxLaneDialers keeps, per pool lane connection, its position among its relay's lanes and how to dial another
// connection like it (lifecycle.RelayLaneDialerPlugin).
var nginxLaneDialers sync.Map // *grpc.ClientConn -> nginxLaneDialer

// RelayLaneDialer implements lifecycle.RelayLaneDialerPlugin.
func (p *NginxPlugin) RelayLaneDialer(conn *grpc.ClientConn, index int, dial func(context.Context) (*grpc.ClientConn, error)) {
	nginxLaneDialers.Store(conn, nginxLaneDialer{index: index, dial: dial})
}

// removeRelayLane takes a pool lane whose run ended out of selection, with the connections that replaced it; its open
// tunnels end with the connection.
func (p *NginxPlugin) removeRelayLane(lane *nginxRelayTunnel) {
	p.relayTunnelMu.Lock()
	var closing []*nginxRelayTunnel
	drop := func(current *nginxRelayTunnel) bool {
		if current.origin != lane {
			return false
		}
		if current.rotated {
			closing = append(closing, current)
		}
		return true
	}
	p.relayTunnels = slices.DeleteFunc(p.relayTunnels, drop)
	p.retiringRelayTunnels = slices.DeleteFunc(p.retiringRelayTunnels, drop)
	delete(p.relayLaneRotatedAt, lane)
	p.relayTunnelMu.Unlock()
	nginxLaneDialers.Delete(lane.conn)
	for _, closed := range closing {
		closeRotatedRelayLane(closed)
	}
}

func closeRotatedRelayLane(lane *nginxRelayTunnel) {
	_ = lane.conn.Close()
	connector.ForgetLane(lane.conn)
}

// rotateRelayLane watches one data-only pool lane's slot while the lane runs: it rotates the slot's connection when
// its congestion state is no longer worth keeping (relaylane.Trigger), and closes rotated-out connections once their
// last tunnel ended.
func (p *NginxPlugin) rotateRelayLane(ctx context.Context, origin *nginxRelayTunnel) {
	ticker := time.NewTicker(relaylane.Check)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			p.closeEmptyRetiringRelayLanes(origin)
			if lane, reason := p.relayLaneToRotate(origin, now); lane != nil {
				p.replaceRelayLane(ctx, lane, reason)
			}
		}
	}
}

// relayLaneToRotate is the slot's current connection when it should be rotated now, and why; it then holds the
// relay's rotation until replaceRelayLane ends.
func (p *NginxPlugin) relayLaneToRotate(origin *nginxRelayTunnel, now time.Time) (*nginxRelayTunnel, string) {
	p.relayTunnelMu.Lock()
	var lane *nginxRelayTunnel
	for _, tunnel := range p.relayTunnels {
		if tunnel.origin == origin {
			lane = tunnel
			break
		}
	}
	p.relayTunnelMu.Unlock()
	if lane == nil || lane.socket == nil {
		return nil, ""
	}
	state, known := lane.socket.State()
	reason := lane.trigger.Reason(state, known)
	if reason == "" {
		return nil, ""
	}
	p.relayTunnelMu.Lock()
	rotatedAt := p.relayLaneRotatedAt[origin]
	p.relayTunnelMu.Unlock()
	// Outside relayTunnelMu: the sessions' locks are taken while it is free.
	allowed := relaylane.MayRotate(rotatedAt, now, func() bool { return p.cheapToRotate(lane, now) })
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	if p.relayLaneRotations == nil {
		p.relayLaneRotations = map[string]*relayLaneRotation{}
		p.relayLaneRotatedAt = map[*nginxRelayTunnel]time.Time{}
	}
	if !allowed || !p.relayLaneRotatedAt[origin].Equal(rotatedAt) {
		// Rotated not long ago: the relay's word is spent until the slot may rotate again.
		lane.trigger.ClearHint()
		return nil, ""
	}
	relay := p.relayLaneRotations[origin.targetID]
	if relay == nil {
		relay = &relayLaneRotation{}
		p.relayLaneRotations[origin.targetID] = relay
	}
	if relay.rotating || now.Sub(relay.last) < relaylane.Spacing || !lane.connected() {
		return nil, ""
	}
	if _, ok := nginxLaneDialers.Load(origin.conn); !ok {
		return nil, ""
	}
	relay.rotating, relay.last = true, now
	p.relayLaneRotatedAt[origin] = now
	return lane, reason
}

// cheapToRotate reports a lane whose rotation moves no stream that carries data (relaylane.MayRotate).
func (p *NginxPlugin) cheapToRotate(lane *nginxRelayTunnel, now time.Time) bool {
	if p.relayStreams == nil {
		return true
	}
	for _, session := range p.relayStreams.Sessions() {
		if current, _ := session.CurrentLane().(*nginxRelayTunnel); current == lane &&
			!session.CheapToMove(now, relaylane.CheapQuiet, relaylane.CheapBytes) {
			return false
		}
	}
	return true
}

// replaceRelayLane dials a replacement for lane, puts it in lane's place and moves lane's resumable streams to new
// paths (the dialer picks the new connection: the old one takes no tunnels). The old connection carries its other
// tunnels until they end. The dial waits at most relaylane.DialTimeout.
func (p *NginxPlugin) replaceRelayLane(ctx context.Context, lane *nginxRelayTunnel, reason string) {
	origin := lane.origin
	defer func() {
		p.relayTunnelMu.Lock()
		if relay := p.relayLaneRotations[origin.targetID]; relay != nil {
			relay.rotating = false
		}
		p.relayTunnelMu.Unlock()
	}()
	value, ok := nginxLaneDialers.Load(origin.conn)
	if !ok {
		return
	}
	dialCtx, cancel := context.WithTimeout(ctx, relaylane.DialTimeout)
	conn, err := value.(nginxLaneDialer).dial(dialCtx)
	cancel()
	if err != nil {
		p.logger.Debug("relay lane rotation could not dial", "relay_instance_id", origin.targetID, "reason", reason, "error", err)
		return
	}
	replacement := &nginxRelayTunnel{ctx: ctx, conn: conn, client: relayv1.NewTunnelBrokerClient(conn), targetID: origin.targetID,
		dataOnly: true, socket: connector.LaneSocketOf(conn), origin: origin, rotated: true}
	p.relayTunnelMu.Lock()
	index := slices.Index(p.relayTunnels, lane)
	if index < 0 || ctx.Err() != nil {
		p.relayTunnelMu.Unlock()
		closeRotatedRelayLane(replacement)
		return
	}
	p.relayTunnels[index] = replacement
	lane.retiring = true
	p.retiringRelayTunnels = append(p.retiringRelayTunnels, lane)
	p.relayTunnelMu.Unlock()
	go keepRelayLaneConnected(ctx, conn)
	relaylane.Rotations.Add(1)
	moved := 0
	if p.relayStreams != nil {
		for _, session := range p.relayStreams.Sessions() {
			if current, _ := session.CurrentLane().(*nginxRelayTunnel); current == lane {
				p.relayStreams.MoveOffLane(session)
				moved++
			}
		}
	}
	p.logger.Info("relay lane connection replaced", "relay_instance_id", origin.targetID, "reason", reason,
		"tunnels_left", lane.active.Load(), "streams_moving", moved)
}

// keepRelayLaneConnected reconnects a rotated lane's connection when it went idle, like the pool does for its lanes.
func keepRelayLaneConnected(ctx context.Context, conn *grpc.ClientConn) {
	for {
		state := conn.GetState()
		if state == connectivity.Shutdown {
			return
		}
		if state == connectivity.Idle {
			conn.Connect()
		}
		if !conn.WaitForStateChange(ctx, state) {
			return
		}
	}
}

// closeEmptyRetiringRelayLanes closes the slot's rotated-out connections the daemon dialled once they carry no tunnel;
// the pool lane's own connection stays (the pool owns it) but takes no tunnels.
func (p *NginxPlugin) closeEmptyRetiringRelayLanes(origin *nginxRelayTunnel) {
	p.relayTunnelMu.Lock()
	var closing []*nginxRelayTunnel
	p.retiringRelayTunnels = slices.DeleteFunc(p.retiringRelayTunnels, func(lane *nginxRelayTunnel) bool {
		if lane.origin != origin || lane.active.Load() != 0 {
			return false
		}
		if lane.rotated {
			closing = append(closing, lane)
		}
		return true
	})
	p.relayTunnelMu.Unlock()
	for _, lane := range closing {
		closeRotatedRelayLane(lane)
	}
}

var _ lifecycle.RelayLaneDialerPlugin = (*NginxPlugin)(nil)
