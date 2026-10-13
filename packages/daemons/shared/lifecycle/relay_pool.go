package lifecycle

import (
	"context"
	"log/slog"
	"slices"
	"sort"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

func runProcessRelayPool(
	ctx context.Context,
	connector *connector.Connector,
	plugin RelayPoolTunnelPlugin,
	nodeID string,
	identityChanged <-chan struct{},
	logger *slog.Logger,
) {
	go runRelayLatencyProbes(ctx, connector, plugin)
	// Each relay target runs on its own. A grant refresh that adds, removes or
	// changes one relay must not reconnect the lanes to the others: every tunnel
	// on those lanes (database, storage and backup streams) would drop with them.
	type targetRun struct {
		target *atomic.Pointer[RelayTunnelTarget]
		// changed wakes the run when the target's address or certificate changed.
		changed chan struct{}
		cancel  context.CancelFunc
		done    chan struct{}
	}
	running := map[string]*targetRun{}
	laneCount := 0
	stop := func(ids ...string) {
		for _, id := range ids {
			if run := running[id]; run != nil {
				run.cancel()
				<-run.done
				delete(running, id)
			}
		}
	}
	stopAll := func() {
		ids := make([]string, 0, len(running))
		for id := range running {
			ids = append(ids, id)
		}
		stop(ids...)
	}
	defer stopAll()
	for ctx.Err() == nil {
		lanes := plugin.RelayTunnelLaneCount()
		if lanes < 1 {
			lanes = 1
		}
		if lanes > 16 {
			lanes = 16
		}
		if lanes != laneCount {
			stopAll()
			laneCount = lanes
		}
		targets := plugin.RelayTunnelTargets()
		if len(targets) == 0 {
			targets = []RelayTunnelTarget{{ID: "local"}}
		}
		runningIDs := make(map[string]bool, len(running))
		for id := range running {
			runningIDs[id] = true
		}
		plan := planRelayTargets(runningIDs, targets)
		stop(plan.stop...)
		for _, target := range plan.update {
			// A changed address or certificate (a re-enrollment or a renewal)
			// replaces the target's lanes once one of them is not connected;
			// lanes that are up stay up (runRelayPoolTarget).
			next := target
			run := running[target.ID]
			if previous := run.target.Swap(&next); !sameRelayConnection(*previous, next) {
				notifyRelayLanes(run.changed)
			}
		}
		for _, target := range plan.start {
			id := target.ID
			current := &atomic.Pointer[RelayTunnelTarget]{}
			initial := target
			current.Store(&initial)
			targetCtx, cancel := context.WithCancel(ctx)
			run := &targetRun{target: current, changed: make(chan struct{}, 1), cancel: cancel, done: make(chan struct{})}
			running[id] = run
			go func() {
				defer close(run.done)
				runRelayPoolTarget(targetCtx, connector, plugin, nodeID, current.Load, run.changed, lanes, logger)
			}()
		}
		select {
		case <-ctx.Done():
			return
		case <-identityChanged:
			// This daemon's own certificate changed: every lane must reconnect with it.
			logger.Info("relay tunnel identity changed, reconnecting pool lanes")
			stopAll()
		case <-plugin.RelayTunnelRuntimeChanged():
			logger.Info("relay tunnel targets changed, reconciling pool lanes")
		}
	}
}

type relayTargetPlan struct {
	start  []RelayTunnelTarget
	update []RelayTunnelTarget
	stop   []string
}

// planRelayTargets compares running relay targets with the desired ones: only
// new targets start and only removed ones stop. A running target is updated in
// place; its run replaces its lanes when its address or certificate changed.
func planRelayTargets(running map[string]bool, desired []RelayTunnelTarget) relayTargetPlan {
	plan := relayTargetPlan{}
	wanted := make(map[string]bool, len(desired))
	for _, target := range desired {
		if wanted[target.ID] {
			continue
		}
		wanted[target.ID] = true
		if running[target.ID] {
			plan.update = append(plan.update, target)
		} else {
			plan.start = append(plan.start, target)
		}
	}
	for id := range running {
		if !wanted[id] {
			plan.stop = append(plan.stop, id)
		}
	}
	sort.Strings(plan.stop)
	return plan
}

// runRelayPoolTarget keeps the lanes to one relay target. A lane's connection
// pins the address and certificate it was built for, and gRPC reconnects it
// with them. When the target's address or certificate changes (a re-enrolled
// relay serves a new certificate), lanes that are up stay up: a renewed relay
// keeps serving the previous certificate, so their tunnels carry on. Once one
// of them drops (or is down when the change arrives), every lane of the target
// is replaced with lanes built for the new data: reconnecting with the old
// ones fails for as long as the relay no longer serves that certificate.
func runRelayPoolTarget(
	ctx context.Context,
	connector *connector.Connector,
	plugin RelayPoolTunnelPlugin,
	nodeID string,
	currentTarget func() *RelayTunnelTarget,
	targetChanged <-chan struct{},
	laneCount int,
	logger *slog.Logger,
) {
	// addressOffset rotates the target's addresses for the next lanes once its
	// lanes stayed down on the address they were built for.
	addressOffset := 0
	for ctx.Err() == nil {
		target := *currentTarget()
		targetCtx, cancelTarget := context.WithCancel(ctx)
		connections := make([]*grpc.ClientConn, 0, laneCount)
		laneEnded := make(chan struct{}, laneCount)
		laneDropped := make(chan struct{}, 1)
		addresses := rotatedRelayAddresses(target.Addresses, addressOffset)
		// A target without addresses is the relay at the Gateway address. When
		// Opfield moved to another address (gateway next address), lanes that
		// are down are rebuilt for the new one; lanes that are up stay up.
		var controlMoved <-chan struct{}
		if len(addresses) == 0 {
			controlMoved = connector.AddressChanged()
		}
		staleControlAddress := false
		// Each lane carries tunnels as soon as it is up: right after a start (a restart or update of the daemon) the
		// connections the previous process handed over wait for the first lane, not for every lane of the relay.
		openLanes := func(connectCtx context.Context) error {
			for len(connections) < laneCount && connectCtx.Err() == nil {
				var conn *grpc.ClientConn
				var err error
				if len(addresses) == 0 {
					conn, err = connector.ConnectLaneWithRetry(connectCtx)
				} else {
					conn, err = connector.ConnectTargetAttempt(connectCtx, addresses, target.CertificateIdentity, target.CertificateFingerprint)
				}
				if err != nil {
					return err
				}
				liveRelayTransports.add(target.ID, conn)
				connections = append(connections, conn)
				if dialerPlugin, ok := plugin.(RelayLaneDialerPlugin); ok {
					// Another connection like this lane, for a plugin that replaces a lane's connection while it runs.
					dialTarget, dialAddresses := target, addresses
					dialerPlugin.RelayLaneDialer(conn, len(connections)-1, func(dialCtx context.Context) (*grpc.ClientConn, error) {
						if len(dialAddresses) == 0 {
							return connector.ConnectLaneWithRetry(dialCtx)
						}
						return connector.ConnectTargetAttempt(dialCtx, dialAddresses, dialTarget.CertificateIdentity, dialTarget.CertificateFingerprint)
					})
				}
				go keepRelayLaneConnected(targetCtx, conn, laneDropped, laneLeftReady(plugin, target.ID, conn), laneReached(target.ID))
				go func() {
					plugin.RunRelayTargetTunnels(targetCtx, conn, nodeID, target.ID)
					laneEnded <- struct{}{}
				}()
			}
			return nil
		}
		if err := openLanes(ctx); err != nil {
			logger.Warn("relay target lane connection failed", "relay_instance_id", target.ID, "error", err)
		}
		if len(connections) == 0 {
			cancelTarget()
			if !waitForControlSessionReconnect(ctx) {
				return
			}
			continue
		}
		// Lanes that failed to open are opened again later: the target otherwise ran with fewer lanes until its
		// address or certificate changed.
		var missingLanes *time.Timer
		retryMissingLanes := func() <-chan time.Time {
			if len(connections) >= laneCount {
				return nil
			}
			missingLanes = time.NewTimer(relayLaneRetryDelay)
			return missingLanes.C
		}
		missing := retryMissingLanes()
		// stranded fires once the lanes of a target with several addresses stayed down after a drop.
		var stranded <-chan time.Time
	lanesUp:
		for {
			dropped := false
			select {
			case <-ctx.Done():
				break lanesUp
			case <-laneEnded:
				break lanesUp
			case <-targetChanged:
			case <-controlMoved:
				controlMoved = nil
				staleControlAddress = true
				if !relayLanesReady(connections) {
					logger.Info("Opfield address changed, replacing the lanes to its relay", "relay_instance_id", target.ID)
					break lanesUp
				}
				continue
			case <-laneDropped:
				dropped = true
				if staleControlAddress {
					logger.Info("Opfield address changed, replacing the lanes to its relay", "relay_instance_id", target.ID)
					break lanesUp
				}
			case <-missing:
				attemptCtx, cancelAttempt := context.WithTimeout(ctx, relayLaneRetryAttempt)
				if err := openLanes(attemptCtx); err != nil {
					logger.Debug("relay target lane connection failed", "relay_instance_id", target.ID, "error", err)
				}
				cancelAttempt()
				missing = retryMissingLanes()
				continue
			case <-stranded:
				stranded = nil
				if relayLanesDown(connections) {
					// gRPC reconnects a lane to the address it was built for only: an address that became unreachable
					// kept the relay out of use although its other address answers. The lanes carry nothing now.
					addressOffset++
					logger.Info("relay target lanes stayed down, reconnecting through its next address", "relay_instance_id", target.ID)
					break lanesUp
				}
				continue
			}
			current := *currentTarget()
			if !sameRelayConnection(target, current) && (dropped || !relayLanesReady(connections)) {
				logger.Info("relay target address or certificate changed, replacing its lanes",
					"relay_instance_id", target.ID, "certificate_fingerprint", current.CertificateFingerprint)
				break lanesUp
			}
			if dropped && len(target.Addresses) > 1 && stranded == nil {
				stranded = time.After(relayLaneStrandedAfter)
			}
		}
		if missingLanes != nil {
			missingLanes.Stop()
		}
		cancelTarget()
		liveRelayTransports.remove(target.ID, connections)
		for _, conn := range connections {
			_ = conn.Close()
			forgetLane(conn)
		}
		if ctx.Err() == nil && !waitForControlSessionReconnect(ctx) {
			return
		}
	}
}

// forgetLane drops a closed lane's socket holder (connector.LaneSocket).
var forgetLane = connector.ForgetLane

const (
	// relayLaneRetryDelay spaces the attempts to open the lanes of a target that failed to open.
	relayLaneRetryDelay = 15 * time.Second
	// relayLaneRetryAttempt bounds one such attempt: the lanes that are up wait for it.
	relayLaneRetryAttempt = 20 * time.Second
	// relayLaneStrandedAfter is how long every lane of a target with several addresses may stay down after a drop
	// before they are rebuilt through its next address.
	relayLaneStrandedAfter = 15 * time.Second
)

// rotatedRelayAddresses starts the addresses at offset (modulo their count).
func rotatedRelayAddresses(addresses []string, offset int) []string {
	if len(addresses) < 2 {
		return addresses
	}
	offset %= len(addresses)
	return append(append([]string(nil), addresses[offset:]...), addresses[:offset]...)
}

func relayLanesDown(connections []*grpc.ClientConn) bool {
	for _, conn := range connections {
		if conn.GetState() == connectivity.Ready {
			return false
		}
	}
	return true
}

// RelayLaneStatePlugin is told when a relay lane leaves the connected state:
// a stopping relay's GOAWAY (it keeps existing streams for seconds) or a
// transport failure. Resumable streams on that lane move at once.
type RelayLaneStatePlugin interface {
	RelayLaneLeftReady(relayInstanceID string, conn *grpc.ClientConn)
}

// laneLeftReady is what a lane leaving the connected state does: the plugin
// moves its streams, and once every lane of the relay is down the relay is
// failing for this daemon (relaybridge.LatencyTracker.Fail), which the next
// health report tells Gateway.
func laneLeftReady(plugin RelayPoolTunnelPlugin, relayInstanceID string, conn *grpc.ClientConn) func() {
	hook, _ := plugin.(RelayLaneStatePlugin)
	return func() {
		if hook != nil {
			hook.RelayLaneLeftReady(relayInstanceID, conn)
		}
		if relayLanesDown(liveRelayTransports.get(relayInstanceID)) {
			relaybridge.Latency.Fail(relayInstanceID)
		}
	}
}

// laneReached clears the relay's failure once one of its lanes is connected
// again, ahead of the next measurement.
func laneReached(relayInstanceID string) func() {
	return func() { relaybridge.Latency.Reached(relayInstanceID) }
}

// keepRelayLaneConnected reconnects a lane whose transport dropped. gRPC
// leaves such a connection idle until the next call on it, but tunnels are
// only opened on lanes that are connected: a relay that was unreachable for a
// while would stay out of use after it came back. Each time the lane leaves
// the connected state it is signalled on dropped (nil for none), even when it
// is connected again by the time the signal is read, and leftReady runs (nil
// for none); reached runs each time it is connected again (nil for none).
func keepRelayLaneConnected(ctx context.Context, conn *grpc.ClientConn, dropped chan<- struct{}, leftReady, reached func()) {
	for {
		state := conn.GetState()
		if state == connectivity.Idle {
			conn.Connect()
		}
		if !conn.WaitForStateChange(ctx, state) {
			return
		}
		if state == connectivity.Ready {
			notifyRelayLanes(dropped)
			if leftReady != nil {
				leftReady()
			}
		} else if reached != nil && conn.GetState() == connectivity.Ready {
			reached()
		}
	}
}

func notifyRelayLanes(changed chan<- struct{}) {
	select {
	case changed <- struct{}{}:
	default:
	}
}

// sameRelayConnection reports whether lanes built for one target fit the other:
// a lane's connection is bound to its addresses, server name and certificate.
func sameRelayConnection(built, current RelayTunnelTarget) bool {
	return slices.Equal(built.Addresses, current.Addresses) &&
		built.CertificateIdentity == current.CertificateIdentity &&
		built.CertificateFingerprint == current.CertificateFingerprint
}

func relayLanesReady(connections []*grpc.ClientConn) bool {
	for _, conn := range connections {
		if conn.GetState() != connectivity.Ready {
			return false
		}
	}
	return true
}
