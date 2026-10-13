package docker

import (
	"errors"
	"maps"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// Live handover (shared/handover): an update of this daemon hands the
// resumable relay streams it carries for local sockets (the links' source
// streams, the endpoints' target streams) and the node-local link connections
// it pipes to the next daemon process, which carries them on: a pause of a
// second or two instead of a cut. The next process takes them over in Init,
// before it registers any endpoint with the relays, checks each against its
// grants, and wraps each connection as it was (link accounting, the drain
// bookkeeping of Secure Link tunnels, the host listener of a database
// binding).
//
// What the daemon cannot hand over is cut as before, and counted for the
// update's report: raw streams of peers without RSv1, PostgreSQL links whose
// TLS this daemon terminates, registry pulls and pushes, backup runs.

// Labels of a handed over connection: what the next process needs to serve it
// again.
const (
	handoverRole          = "role" // source, target, pipe
	handoverOwnerKind     = "owner_kind"
	handoverOwnerID       = "owner_id"
	handoverEntry         = "entry" // source: where the workload's connection came in
	handoverLinkKind      = "link_kind"
	handoverLinkID        = "link_id"
	handoverConnector     = "connector"        // the shared connector an ingress connection reaches
	handoverBinding       = "binding"          // host listener: the database binding
	handoverGeneration    = "route_generation" // host listener: the route generation it was opened on
	handoverPeerID        = "peer_id"
	handoverPeerName      = "peer_name"
	handoverPeerLabel     = "peer_label/"
	handoverRoleSource    = "source"
	handoverRoleTarget    = "target"
	handoverRolePipe      = "pipe"
	entryEgress           = "egress"
	entryHostListener     = "host_listener"
	entryStorageConnector = "storage_connector"
)

// Classes of connections an update cuts whatever it hands over.
const (
	cutRawStream   = "raw_stream"
	cutPostgresTLS = "postgres_tls"
	cutRegistry    = "registry"
	cutBackup      = "backup"
	// cutConnectorRetired: the sessions a replaced Secure Link connector still carried when it was removed at its
	// retirement limit, or to free its slot. A connector is replaced by an update (of Opfield's connector image, with
	// the Relay Pool), and its removal comes up to an hour later: the cut joins the node's last update report.
	cutConnectorRetired = "connector_retired"
)

// recordConnectorCut counts the sessions a removed Secure Link connector still carried (stand rc.7 O-15: 35 and 40
// connections cut an hour after the Relay Pool update, reported nowhere).
func (p *DockerPlugin) recordConnectorCut(sessions int) {
	if p == nil || sessions <= 0 {
		return
	}
	if !p.handoverTracker.CutAfter(cutConnectorRetired, sessions) && p.logger != nil {
		p.logger.Info("no update report to add the cut connector sessions to", "sessions", sessions)
	}
}

// handoverKeeper keeps what a handover passes on (the launcher's keeper), and
// exitingForUpdate tells an exit for an update; both are replaced in tests.
var (
	handoverKeeper   = handover.LauncherKeeper
	exitingForUpdate = lifecycle.ExitingForUpdate
)

// liveCuts counts, by class, the connections this process carries that an
// update cuts in any case. The zero value is ready to use.
type liveCuts struct {
	mu     sync.Mutex
	counts map[string]int
}

// track counts one connection of class until the returned func is called.
func (c *liveCuts) track(class string) func() {
	c.mu.Lock()
	if c.counts == nil {
		c.counts = map[string]int{}
	}
	c.counts[class]++
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			if c.counts[class]--; c.counts[class] <= 0 {
				delete(c.counts, class)
			}
			c.mu.Unlock()
		})
	}
}

func (c *liveCuts) snapshot() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return maps.Clone(c.counts)
}

// sourceLabels are the labels of a source stream of tag that came in at entry
// for link.
func sourceLabels(tag relaySourceTag, entry string, link linkKey) handover.Labels {
	return handover.Labels{handoverRole: handoverRoleSource, handoverOwnerKind: tag.ownerKind, handoverOwnerID: tag.ownerID,
		handoverEntry: entry, handoverLinkKind: link.kind, handoverLinkID: link.id}
}

// handOverConnections hands the live connections to the next process when the
// daemon exits for its update. A stop or a restart of the unit keeps the
// drain: the launcher does not start a next process at once then.
func (p *DockerPlugin) handOverConnections() handover.Result {
	if !exitingForUpdate() || p.cfg.Docker.Mode == "builder" {
		return handover.Result{}
	}
	var tables []*relayresume.TargetTable
	if sides := p.relayStreamsIfAny(); sides != nil {
		tables = append(tables, sides.targets)
	}
	result := p.handover.HandOver(handover.Options{DaemonType: "docker", Version: lifecycle.Version, Tables: tables, Logger: p.logger,
		Keeper: handoverKeeper})
	switch {
	case errors.Is(result.Err, handover.ErrServiceRestart):
		p.logger.Info("the update restarts the whole service for a newer launcher; it cuts the open connections once")
	case result.Err != nil:
		p.logger.Warn("connections are not handed over to the next daemon process; the update cuts them", "error", result.Err)
	case result.Committed:
		p.logger.Info("handed connections over to the next daemon process", "connections", result.HandedOver, "left_out", result.Cut,
			"took", time.Since(result.StartedAt).Round(time.Millisecond).String())
	}
	if attrs := result.SetupAttrs(); attrs != nil && p.logger != nil {
		// Connections that were being opened as the update began (handover.Registry.Setup).
		p.logger.Info("waited for connections being opened before the handover", attrs...)
	}
	// The handed over bridges let go of their connections before the drain
	// looks at what this process still carries.
	p.handover.WaitHandedOver(time.Second)
	return result
}

// updateCutsNow counts, by class, the connections this process still carries
// once the handover took what it could: the update cuts every one of them,
// those the drain closes as idle as well as those still open at the exit.
func (p *DockerPlugin) updateCutsNow() map[string]int {
	cuts := p.handover.Remaining()
	for class, n := range p.liveCuts.snapshot() {
		cuts[class] += n
	}
	return cuts
}

// recordUpdateConnections leaves the next process what this update did to the
// connections: what it handed over, and what it cut (counted before the
// drain, updateCutsNow).
func (p *DockerPlugin) recordUpdateConnections(started time.Time, result handover.Result, cuts map[string]int) {
	if !exitingForUpdate() {
		return
	}
	report := handover.Report{FromVersion: lifecycle.UpdateReportFromVersion(), StartedAt: started, Handover: result.Committed, HandedOver: result.HandedOver, Counted: true}
	for class, n := range cuts {
		report.AddCut(class, n)
	}
	if err := handover.WritePending(p.cfg.StateDir, report); err != nil {
		p.logger.Warn("could not record what the update did to the connections", "error", err)
	}
}

// updateConnections is the health report's view of the connections an update
// now keeps and cuts, and of the last update.
func (p *DockerPlugin) updateConnections() *pb.DaemonUpdateConnections {
	if p.cfg.Docker.Mode == "builder" {
		return nil
	}
	available, notHandedOver := handover.Preview(handoverKeeper)
	kept, cut := p.handover.Live(available, notHandedOver)
	for class, n := range p.liveCuts.snapshot() {
		cut[class] += n
	}
	return handover.Status(available, kept, cut, p.handoverTracker.Last())
}

// restoreHandover takes over what the previous process handed over (Init,
// before the relay lanes start): the next relay registration finds the
// target streams, and the source streams look for a path at once.
func (p *DockerPlugin) restoreHandover() {
	p.handoverTracker = handover.NewTracker(p.cfg.StateDir, lifecycle.Version)
	p.handover.Observe(p.handoverTracker)
	if carried := handover.TakeStreamTotals(p.cfg.StateDir); carried.Cut > 0 {
		p.relayStreams().sources.CarryCut(carried.Cut)
	}
	restored, err := handover.RestoreFrom(handoverKeeper, "docker", p.logger)
	if err != nil {
		p.logger.Warn("could not take over the connections the previous daemon process handed over; they are cut", "error", err)
	}
	if restored != nil {
		sides := p.relayStreams()
		sides.targets.RestoreTombstones(restored.Tombstones)
		for _, item := range restored.Sessions {
			switch item.Labels[handoverRole] {
			case handoverRoleSource:
				p.resumeSourceStream(item)
			case handoverRoleTarget:
				p.resumeTargetStream(item)
			default:
				item.Cut()
				p.handoverTracker.Cut(handover.CutResumeFailed, 1)
			}
		}
		for _, item := range restored.Pipes {
			p.handoverTracker.Kept(1)
			go p.carryLocalPipe(item)
		}
		p.logger.Info("took over the connections the previous daemon process handed over", "streams", len(restored.Sessions),
			"pipes", len(restored.Pipes), "lost", restored.Lost, "from_version", restored.FromVersion)
	}
	go p.handoverTracker.Settle()
}

// resumeSourceStream carries a link's source stream on, if its route is still
// assigned to this node.
func (p *DockerPlugin) resumeSourceStream(item *handover.RestoredSession) {
	labels := item.Labels
	tag := relaySourceTag{ownerKind: labels[handoverOwnerKind], ownerID: labels[handoverOwnerID], routeID: item.State.RouteID}
	assignment := p.relayGrants.lookup("connect", tag.ownerKind, tag.ownerID)
	revoked := assignment == nil || assignment.GetRouteId() != tag.routeID
	if !revoked {
		_, _, resumable := streamResumeKey(assignment)
		revoked = !resumable
	}
	if revoked {
		item.Cut()
		p.handoverTracker.Cut(handover.CutRevoked, 1)
		return
	}
	session, err := p.relayStreams().sources.RestoreSource(p.relaySourceConfig(tag, assignment), item.State)
	if err != nil {
		p.logger.Debug("a handed over link stream could not be taken over", "owner_kind", tag.ownerKind, "owner_id", tag.ownerID, "error", err)
		item.Cut()
		p.handoverTracker.Cut(handover.CutResumeFailed, 1)
		return
	}
	p.handoverTracker.Track(session)
	link := linkKey{kind: labels[handoverLinkKind], id: labels[handoverLinkID]}
	go func() {
		connection := item.Conn
		defer connection.Close()
		switch labels[handoverEntry] {
		case entryEgress, entryStorageConnector:
			// Counted at the link's limit again, whatever it carries now.
			p.linkConnections.force(link)
			defer p.linkConnections.release(link)
		case entryHostListener:
			defer p.trackRestoredHostConnection(connection, labels)()
		}
		flow, done := p.linkFlows.track(connection)
		defer done()
		defer p.linkTraffic.completed(link)
		p.bridgeSourceSession(p.linkTraffic.carry(link, flow), session, relaySourceIdleLimit(tag.ownerKind), labels, "", nil)
	}()
}

// resumeTargetStream carries an endpoint's target stream on, if the endpoint
// still serves the route here.
func (p *DockerPlugin) resumeTargetStream(item *handover.RestoredSession) {
	labels := item.Labels
	owner := relayTargetTag{ownerKind: labels[handoverOwnerKind], ownerID: labels[handoverOwnerID], routeID: item.State.RouteID}
	sides := p.relayStreams()
	if p.targetRouteResume(owner) == nil {
		// Its source learns the route is gone at its next RESUME.
		sides.targets.Refuse(item.State, relayresume.RejectUnauthorized)
		item.Cut()
		p.handoverTracker.Cut(handover.CutRevoked, 1)
		return
	}
	session, err := sides.targets.Restore(item.State, relayTargetTag{ownerKind: owner.ownerKind, ownerID: owner.ownerID})
	if err != nil {
		p.logger.Debug("a handed over endpoint stream could not be taken over", "owner_kind", owner.ownerKind, "owner_id", owner.ownerID, "error", err)
		item.Cut()
		p.handoverTracker.Cut(handover.CutResumeFailed, 1)
		return
	}
	p.handoverTracker.Track(session)
	connection := item.Conn
	if connector := labels[handoverConnector]; connector != "" {
		connection = &connectorConn{Conn: connection, connectorID: connector}
	}
	go p.bridgeTargetConnection(owner.ownerKind, owner.ownerID, session, connection, isConnectorIngressOwnerKind(owner.ownerKind), nil)
}

// carryLocalPipe carries a node-local link connection on (carryLocalEgress).
func (p *DockerPlugin) carryLocalPipe(item *handover.RestoredPipe) {
	labels := item.Labels
	link := linkKey{kind: labels[handoverLinkKind], id: labels[handoverLinkID]}
	workload, target := item.Conns[0], item.Conns[1]
	defer workload.Close()
	defer target.Close()
	p.linkConnections.force(link)
	defer p.linkConnections.release(link)
	flow, done := p.linkFlows.track(workload)
	defer done()
	tracked := newDrainConn(&connectorConn{Conn: target, connectorID: labels[handoverConnector]})
	defer p.proxyTunnels.addHeld(tracked, func() { _ = target.Close() })()
	defer p.linkTraffic.completed(link)
	item.Conns = [2]net.Conn{p.linkTraffic.carry(link, flow), tracked}
	_ = p.handover.ResumePipe(item, handover.PipeConfig{Labels: labels})
}

// pipeLabels are the labels of a node-local link connection to target.
func pipeLabels(link linkKey, target net.Conn) handover.Labels {
	return handover.Labels{handoverRole: handoverRolePipe, handoverLinkKind: link.kind, handoverLinkID: link.id,
		handoverConnector: connectionConnector(target)}
}

// hostListenerLabels adds what a host listener connection needs in the next
// process: its binding, route generation and peer.
func hostListenerLabels(labels handover.Labels, bindingID string, routeGeneration uint64, peer listenerPeer, known bool) handover.Labels {
	labels[handoverBinding] = bindingID
	labels[handoverGeneration] = strconv.FormatUint(routeGeneration, 10)
	if known {
		labels[handoverPeerID] = peer.containerID
		labels[handoverPeerName] = peer.name
		for key, value := range peer.labels {
			labels[handoverPeerLabel+key] = value
		}
	}
	return labels
}

// targetLabels are the labels of an endpoint's target stream.
func targetLabels(assignment *pb.RelayGrantAssignment, connection net.Conn) handover.Labels {
	return handover.Labels{handoverRole: handoverRoleTarget, handoverOwnerKind: assignment.GetOwnerKind(), handoverOwnerID: assignment.GetOwnerId(),
		handoverConnector: connectionConnector(connection)}
}

// relayReadChunkFor is the read size of a bridge over a resumable stream of an
// endpoint of ownerKind.
func (p *DockerPlugin) relayReadChunkFor(ownerKind string, session *relayresume.Session) int {
	readChunk := p.relayReadChunk()
	if isConnectorIngressOwnerKind(ownerKind) {
		if readChunk = int(p.relayGrants.readChunkBytes()); readChunk == 0 {
			readChunk = relaybridge.DefaultChunkBytes
		}
	}
	return relayresume.ReadChunk(min(readChunk, session.MaxFrame()))
}

// The connection wrappers keep no byte of their own: a handover passes the
// socket inside on.

func (c *drainConn) HandoverInner() net.Conn       { return c.Conn }
func (c *connectorConn) HandoverInner() net.Conn   { return c.Conn }
func (c *linkFlowConn) HandoverInner() net.Conn    { return c.Conn }
func (c *linkCountedConn) HandoverInner() net.Conn { return c.Conn }

// restoredHostConnection is a database binding's link connection the previous
// process handed over, and the host listener that adopted it.
type restoredHostConnection struct {
	connection net.Conn
	bindingID  string
	generation uint64
	peer       listenerPeer
	listener   *managedDatabaseHostListener
}

// trackRestoredHostConnection keeps a database link connection the previous
// process handed over until the host listener of its binding adopts it
// (adoptRestoredLocked): from then on a new route generation, a narrowed
// source list or the listener's close end it as they end the listener's other
// connections. The listeners come back with Init's restore and the first grant
// bundle: until then the connection runs on its own. The returned func takes
// it out once it ended.
func (p *DockerPlugin) trackRestoredHostConnection(connection net.Conn, labels handover.Labels) func() {
	generation, _ := strconv.ParseUint(labels[handoverGeneration], 10, 64)
	restored := &restoredHostConnection{connection: connection, bindingID: labels[handoverBinding], generation: generation,
		peer: listenerPeer{containerID: labels[handoverPeerID], name: labels[handoverPeerName], labels: map[string]string{}}}
	for key, value := range labels {
		if name, ok := strings.CutPrefix(key, handoverPeerLabel); ok {
			restored.peer.labels[name] = value
		}
	}
	p.restoredHostMu.Lock()
	if p.restoredHost == nil {
		p.restoredHost = map[*restoredHostConnection]struct{}{}
	}
	p.restoredHost[restored] = struct{}{}
	p.restoredHostMu.Unlock()
	return func() {
		p.restoredHostMu.Lock()
		delete(p.restoredHost, restored)
		listener := restored.listener
		p.restoredHostMu.Unlock()
		if listener != nil {
			listener.mu.Lock()
			delete(listener.connections, connection)
			delete(listener.sources, connection)
			listener.mu.Unlock()
		}
	}
}

// adoptRestoredLocked hands the restored connections to the listeners of their
// bindings, ending those the listener's route or sources no longer carry.
// Callers hold m.mu.
func (m *managedDatabaseHostListenerManager) adoptRestoredLocked() {
	if m.plugin == nil {
		return
	}
	var ended []net.Conn
	m.plugin.restoredHostMu.Lock()
	for restored := range m.plugin.restoredHost {
		listener := m.listeners[restored.bindingID]
		if restored.listener != nil || listener == nil {
			continue
		}
		listener.mu.Lock()
		carried := !listener.closed && listener.config.routeGeneration == restored.generation &&
			managedDatabaseListenerSourceAllowed(restored.peer, listener.config.allowedSources)
		if carried {
			listener.connections[restored.connection] = struct{}{}
			listener.sources[restored.connection] = restored.peer
			restored.listener = listener
		}
		listener.mu.Unlock()
		if !carried {
			delete(m.plugin.restoredHost, restored)
			ended = append(ended, restored.connection)
		}
	}
	m.plugin.restoredHostMu.Unlock()
	for _, connection := range ended {
		_ = connection.Close()
	}
}

// beginStreamExit marks the exit of this process for its stream counters: what the exit cuts from now on is cut.
func (p *DockerPlugin) beginStreamExit() {
	if sides := p.relayStreamsIfAny(); sides != nil {
		sides.sources.BeginExit()
	}
}

// leaveStreamTotals leaves the cut total, the streams this exit cuts included, to the next process (Shutdown).
func (p *DockerPlugin) leaveStreamTotals() {
	sides := p.relayStreamsIfAny()
	if sides == nil || p.cfg == nil || p.cfg.StateDir == "" {
		return
	}
	if err := handover.WriteStreamTotals(p.cfg.StateDir, handover.StreamTotals{Cut: sides.sources.ExitCut()}); err != nil && p.logger != nil {
		p.logger.Warn("could not leave the relay stream counters to the next daemon process", "error", err)
	}
}
