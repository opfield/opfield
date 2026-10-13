package docker

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/relaylane"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

// relaySourceLane is one transport to a relay that source tunnels open on. The relay pool opens several lanes per
// relay (the bundle's data lanes); the first carries the endpoint registrations and their incoming tunnels, and source
// tunnels go to the least busy connected lane, as the nginx daemon's do: one lane no longer carries every database,
// storage, egress and backup stream of the node, and one lane that drops leaves the relay usable through the others.
//
// A lane is one long-lived TCP connection, and TCP keeps what it learned of its path for the life of the connection:
// after a retransmission timeout, or after the lane's round trip grew far beyond the one it learned on, a transfer that
// starts on it ramps up in congestion avoidance from a few segments and takes tens of seconds to reach the rate a new
// connection reaches in a second (stand rc.8 F-1: GETs at 3-12 MB/s). Such a lane is rotated (rotateLane): the router
// dials a new connection like it, new tunnels go there at once, the resumable streams on the old one move over with a
// planned move, and the old one carries its other tunnels until they end.
type relaySourceLane struct {
	conn   *grpc.ClientConn
	client relayv1.TunnelBrokerClient
	active atomic.Int64
	// socket is the TCP connection beneath an extra lane (nil on the primary lane, which is never rotated: its
	// registration and lease streams never end).
	socket *connector.LaneSocket
	// origin is the lane the pool opened that this one replaced (itself for a pool lane); rotated: the router dialled
	// this lane's connection and closes it.
	origin  *relaySourceLane
	rotated bool
	// Rotation state, under the router's lanesMu: retiring lanes take no tunnels; rotatedAt is when the lane's slot
	// (origin) was last rotated.
	retiring bool
	// trigger decides when the lane's connection is replaced (relaylane).
	trigger relaylane.Trigger
}

func (l *relaySourceLane) connected() bool {
	return l.conn == nil || l.conn.GetState() == connectivity.Ready
}

// tunnelContext is the context of one tunnel on the lane: the lane counts it until its cancel runs (once).
func (l *relaySourceLane) tunnelContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	var release sync.Once
	return ctx, func() {
		cancel()
		release.Do(func() { l.active.Add(-1) })
	}
}

// laneDialers keeps, per pool lane connection, how to dial another connection like it (lifecycle.RelayLaneDialerPlugin).
var laneDialers sync.Map // *grpc.ClientConn -> func(context.Context) (*grpc.ClientConn, error)

// RelayLaneDialer implements lifecycle.RelayLaneDialerPlugin.
func (p *DockerPlugin) RelayLaneDialer(conn *grpc.ClientConn, _ int, dial func(context.Context) (*grpc.ClientConn, error)) {
	laneDialers.Store(conn, dial)
}

// addLane adds another lane of the relay for source tunnels.
func (r *relayTunnelRouter) addLane(conn *grpc.ClientConn) *relaySourceLane {
	lane := &relaySourceLane{conn: conn, client: relayv1.NewTunnelBrokerClient(conn), socket: connector.LaneSocketOf(conn)}
	lane.origin = lane
	r.lanesMu.Lock()
	defer r.lanesMu.Unlock()
	r.extraLanes = append(r.extraLanes, lane)
	r.plugin.relayPathWake.Fire()
	return lane
}

// removeLane takes a pool lane whose connection ended out of selection, with the connections that replaced it; its
// open tunnels end with the connection.
func (r *relayTunnelRouter) removeLane(lane *relaySourceLane) {
	r.lanesMu.Lock()
	var closing []*relaySourceLane
	keep := func(current *relaySourceLane) bool {
		if current.origin != lane {
			return true
		}
		if current.rotated {
			closing = append(closing, current)
		}
		return false
	}
	r.extraLanes = slices.DeleteFunc(r.extraLanes, func(current *relaySourceLane) bool { return !keep(current) })
	r.retiringLanes = slices.DeleteFunc(r.retiringLanes, func(current *relaySourceLane) bool { return !keep(current) })
	delete(r.laneRotatedAt, lane)
	r.lanesMu.Unlock()
	laneDialers.Delete(lane.conn)
	for _, closed := range closing {
		closeRotatedLane(closed)
	}
}

func closeRotatedLane(lane *relaySourceLane) {
	_ = lane.conn.Close()
	connector.ForgetLane(lane.conn)
}

func (r *relayTunnelRouter) extraLaneConnected() bool {
	r.lanesMu.Lock()
	defer r.lanesMu.Unlock()
	for _, lane := range r.extraLanes {
		if lane.connected() {
			return true
		}
	}
	return false
}

// sourceLane picks the lane for a new tunnel (source tunnels and accepted incoming ones) and counts the tunnel on it:
// the least busy connected extra lane; the primary lane only while no extra lane is connected (it is never rotated, so
// tunnels on it would keep whatever TCP learned there); the least busy lane while none is connected. Retiring lanes
// take none.
func (r *relayTunnelRouter) sourceLane() *relaySourceLane {
	r.lanesMu.Lock()
	defer r.lanesMu.Unlock()
	if r.primaryLane == nil {
		r.primaryLane = &relaySourceLane{conn: r.conn, client: r.client}
	}
	var selected *relaySourceLane
	for _, lane := range r.extraLanes {
		if lane.connected() && (selected == nil || lane.active.Load() < selected.active.Load()) {
			selected = lane
		}
	}
	if selected == nil {
		selected = r.primaryLane
		selectedConnected := selected.connected()
		for _, lane := range r.extraLanes {
			connected := lane.connected()
			if (connected && !selectedConnected) || (connected == selectedConnected && lane.active.Load() < selected.active.Load()) {
				selected, selectedConnected = lane, connected
			}
		}
	}
	selected.active.Add(1)
	return selected
}

// noteLaneHint records the relay's word (a tunnel's response header) that its sending side of lane collapsed.
func (r *relayTunnelRouter) noteLaneHint(lane *relaySourceLane, header map[string][]string) {
	if lane != nil && lane.socket != nil {
		lane.trigger.NoteHeader(header)
	}
}

// rotateLanes looks at the extra lanes' TCP state and rotates a lane whose congestion state is no longer worth
// keeping (see relaySourceLane), and closes rotated-out connections once their last tunnel ended.
func (r *relayTunnelRouter) rotateLanes(ctx context.Context) {
	ticker := time.NewTicker(relaylane.Check)
	defer ticker.Stop()
	defer r.closeRotatedLanes()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			r.closeEmptyRetiringLanes()
			if lane, reason := r.laneToRotate(now); lane != nil {
				r.rotateLane(ctx, lane, reason, now)
			}
		}
	}
}

func (r *relayTunnelRouter) laneToRotate(now time.Time) (*relaySourceLane, string) {
	r.lanesMu.Lock()
	if r.laneRotatedAt == nil {
		r.laneRotatedAt = map[*relaySourceLane]time.Time{}
	}
	lanes := slices.Clone(r.extraLanes)
	busy := r.rotating || now.Sub(r.lastRotation) < relaylane.Spacing
	r.lanesMu.Unlock()
	var chosen *relaySourceLane
	reason := ""
	for _, lane := range lanes {
		if lane.socket == nil {
			continue
		}
		state, known := lane.socket.State()
		why := lane.trigger.Reason(state, known)
		if why == "" || chosen != nil || busy {
			continue
		}
		r.lanesMu.Lock()
		rotatedAt := r.laneRotatedAt[lane.origin]
		r.lanesMu.Unlock()
		recent := !relaylane.MayRotate(rotatedAt, now, func() bool { return r.cheapToRotate(lane, now) })
		r.lanesMu.Lock()
		if !recent {
			if _, ok := laneDialers.Load(lane.origin.conn); ok && lane.connected() {
				chosen, reason = lane, why
				r.rotating, r.lastRotation = true, now
				r.laneRotatedAt[lane.origin] = now
			}
		}
		r.lanesMu.Unlock()
		if recent {
			// Rotated not long ago: the relay's word is spent until the lane may rotate again.
			lane.trigger.ClearHint()
		}
	}
	return chosen, reason
}

// cheapToRotate reports a lane whose rotation moves no stream that carries data (relaylane.MayRotate).
func (r *relayTunnelRouter) cheapToRotate(lane *relaySourceLane, now time.Time) bool {
	sides := r.plugin.relayStreamsIfAny()
	if sides == nil {
		return true
	}
	for _, sessions := range [][]*relayresume.Session{sides.sources.Sessions(), sides.targets.Sessions()} {
		for _, session := range sessions {
			if current, _ := session.CurrentLane().(*relaySourceLane); current == lane &&
				!session.CheapToMove(now, relaylane.CheapQuiet, relaylane.CheapBytes) {
				return false
			}
		}
	}
	return true
}

// rotateLane dials a replacement for lane, puts it in lane's place and moves lane's resumable source streams to new
// paths (the dialer picks the new connection: the old one takes no tunnels). The old connection carries its other
// tunnels until they end. Runs in the rotation loop; the dial waits at most relaylane.DialTimeout.
func (r *relayTunnelRouter) rotateLane(ctx context.Context, lane *relaySourceLane, reason string, now time.Time) {
	defer func() {
		r.lanesMu.Lock()
		r.rotating = false
		r.lanesMu.Unlock()
	}()
	value, ok := laneDialers.Load(lane.origin.conn)
	if !ok {
		return
	}
	dialCtx, cancel := context.WithTimeout(ctx, relaylane.DialTimeout)
	conn, err := value.(func(context.Context) (*grpc.ClientConn, error))(dialCtx)
	cancel()
	if err != nil {
		r.plugin.logger.Debug("relay lane rotation could not dial", "relay_instance_id", r.targetID, "reason", reason, "error", err)
		return
	}
	replacement := &relaySourceLane{conn: conn, client: relayv1.NewTunnelBrokerClient(conn), socket: connector.LaneSocketOf(conn),
		origin: lane.origin, rotated: true}
	r.lanesMu.Lock()
	index := slices.Index(r.extraLanes, lane)
	if index < 0 || ctx.Err() != nil {
		r.lanesMu.Unlock()
		closeRotatedLane(replacement)
		return
	}
	r.extraLanes[index] = replacement
	lane.retiring = true
	r.retiringLanes = append(r.retiringLanes, lane)
	r.lanesMu.Unlock()
	go keepLaneConnected(ctx, conn)
	relaylane.Rotations.Add(1)
	moved := 0
	if sides := r.plugin.relayStreamsIfAny(); sides != nil {
		for _, session := range sides.sources.Sessions() {
			if current, _ := session.CurrentLane().(*relaySourceLane); current == lane {
				sides.sources.MoveOffLane(session)
				moved++
			}
		}
		// Streams this node accepted on the lane: their sources open new paths on the same relay (MIGRATE_REQ
		// lane), which arrive on the new connection. A source that predates the lane request (it would move the
		// stream off the relay) is not asked: its stream finishes on the old connection.
		for _, session := range sides.targets.Sessions() {
			if current, _ := session.CurrentLane().(*relaySourceLane); current == lane && session.RequestMigrate(relayresume.MigrateLane) {
				moved++
			}
		}
	}
	r.plugin.logger.Info("relay lane connection replaced", "relay_instance_id", r.targetID, "reason", reason,
		"tunnels_left", lane.active.Load(), "streams_moving", moved)
}

// keepLaneConnected reconnects a rotated lane's connection when it went idle, like the pool does for its lanes.
func keepLaneConnected(ctx context.Context, conn *grpc.ClientConn) {
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

// closeEmptyRetiringLanes closes rotated-out connections the router dialled once they carry no tunnel; a pool lane's
// connection stays (the pool owns it) but takes no tunnels.
func (r *relayTunnelRouter) closeEmptyRetiringLanes() {
	r.lanesMu.Lock()
	var closing []*relaySourceLane
	r.retiringLanes = slices.DeleteFunc(r.retiringLanes, func(lane *relaySourceLane) bool {
		if lane.active.Load() != 0 {
			return false
		}
		if lane.rotated {
			closing = append(closing, lane)
		}
		return true
	})
	r.lanesMu.Unlock()
	for _, lane := range closing {
		closeRotatedLane(lane)
	}
}

// closeRotatedLanes closes every connection the router dialled (the router ends).
func (r *relayTunnelRouter) closeRotatedLanes() {
	r.lanesMu.Lock()
	var closing []*relaySourceLane
	for _, lane := range append(slices.Clone(r.extraLanes), r.retiringLanes...) {
		if lane.rotated {
			closing = append(closing, lane)
		}
	}
	r.lanesMu.Unlock()
	for _, lane := range closing {
		closeRotatedLane(lane)
	}
}
