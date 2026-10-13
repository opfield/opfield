package daemon

import (
	"errors"
	"maps"
	"net"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// Live handover (shared/handover): an update of this daemon hands the
// resumable streams of its Secure Link connections to the next daemon
// process, which carries them on: nginx and the upstream see a pause of a
// second or two instead of a cut. The next process takes them over in Init,
// before its relay lanes start, checks each against its grants and puts it
// back under its binding (closeActive, disableTCP, the next drain).
//
// What it cannot hand over is cut as before and counted for the update's
// report: raw streams of targets without RSv1, and registry ingress streams
// (a pull or push in flight ends at the registry proxy of a docker node,
// whose TLS session lives in that process).

const (
	handoverOwnerKind = "owner_kind"
	handoverLinkID    = "link_id"

	cutRawStream = "raw_stream"
	cutRegistry  = "registry"
)

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

// rawStreamClass is the class a raw stream of a link of ownerKind is cut under.
func rawStreamClass(ownerKind string) string {
	if ownerKind == registrySecureLinkOwnerKind {
		return cutRegistry
	}
	return cutRawStream
}

// handOverConnections hands the resumable streams to the next process when
// the daemon exits for its update (the Secure Link sockets went already).
func (p *NginxPlugin) handOverConnections() handover.Result {
	if !exitingForUpdate() {
		return handover.Result{}
	}
	result := p.handover.HandOver(handover.Options{DaemonType: "nginx", Version: lifecycle.Version, Logger: p.logger, Keeper: handoverKeeper})
	if p.logger != nil {
		switch {
		case errors.Is(result.Err, handover.ErrServiceRestart):
			p.logger.Info("the update restarts the whole service for a newer launcher; it cuts the open connections once")
		case result.Err != nil:
			p.logger.Warn("connections are not handed over to the next daemon process; the update cuts them", "error", result.Err)
		case result.Committed:
			p.logger.Info("handed connections over to the next daemon process", "connections", result.HandedOver, "left_out", result.Cut,
				"took", time.Since(result.StartedAt).Round(time.Millisecond).String())
		}
	}
	if attrs := result.SetupAttrs(); attrs != nil && p.logger != nil {
		// Connections that were being opened as the update began (handover.Registry.Setup).
		p.logger.Info("waited for connections being opened before the handover", attrs...)
	}
	// The handed over bridges let go of their connections before the last
	// drain passes look at what this process still serves.
	p.handover.WaitHandedOver(time.Second)
	return result
}

// updateCutsNow counts, by class, the connections this process still carries
// once the handover took what it could: the update cuts every one of them,
// those the last drains close as well as those still open at the exit.
func (p *NginxPlugin) updateCutsNow() map[string]int {
	cuts := p.handover.Remaining()
	for class, n := range p.liveCuts.snapshot() {
		cuts[class] += n
	}
	return cuts
}

// recordUpdateConnections leaves the next process what this update did to the
// connections: what it handed over, and what it cut (counted before the last
// drains, updateCutsNow).
func (p *NginxPlugin) recordUpdateConnections(started time.Time, result handover.Result, cuts map[string]int) {
	if !exitingForUpdate() || p.baseCfg == nil {
		return
	}
	report := handover.Report{FromVersion: lifecycle.UpdateReportFromVersion(), StartedAt: started, Handover: result.Committed, HandedOver: result.HandedOver, Counted: true}
	for class, n := range cuts {
		report.AddCut(class, n)
	}
	if err := handover.WritePending(p.baseCfg.StateDir, report); err != nil && p.logger != nil {
		p.logger.Warn("could not record what the update did to the connections", "error", err)
	}
}

// updateConnections is the health report's view of the connections an update
// now keeps and cuts, and of the last update.
func (p *NginxPlugin) updateConnections() *pb.DaemonUpdateConnections {
	available, notHandedOver := handover.Preview(handoverKeeper)
	kept, cut := p.handover.Live(available, notHandedOver)
	for class, n := range p.liveCuts.snapshot() {
		cut[class] += n
	}
	return handover.Status(available, kept, cut, p.handoverTracker.Last())
}

// restoreHandover takes over the streams the previous process handed over
// (Init, once the Secure Link bindings are back and before the relay lanes
// start): each looks for a path at once and resumes.
func (p *NginxPlugin) restoreHandover() {
	p.handoverTracker = handover.NewTracker(p.baseCfg.StateDir, lifecycle.Version)
	p.handover.Observe(p.handoverTracker)
	if carried := handover.TakeStreamTotals(p.baseCfg.StateDir); carried.Cut > 0 && p.relayStreams != nil {
		p.relayStreams.CarryCut(carried.Cut)
	}
	restored, err := handover.RestoreFrom(handoverKeeper, "nginx", p.logger)
	if err != nil && p.logger != nil {
		p.logger.Warn("could not take over the connections the previous daemon process handed over; they are cut", "error", err)
	}
	if restored != nil {
		for _, item := range restored.Sessions {
			p.resumeSecureLinkStream(item)
		}
		for _, item := range restored.Pipes {
			item.Cut()
			p.handoverTracker.Cut(handover.CutResumeFailed, 1)
		}
		if p.logger != nil {
			p.logger.Info("took over the connections the previous daemon process handed over", "streams", len(restored.Sessions),
				"lost", restored.Lost, "from_version", restored.FromVersion)
		}
	}
	go p.handoverTracker.Settle()
}

// resumeSecureLinkStream carries a Secure Link connection's stream on, if its
// link is still configured here and its route still resumable.
func (p *NginxPlugin) resumeSecureLinkStream(item *handover.RestoredSession) {
	ownerKind, linkID := item.Labels[handoverOwnerKind], item.Labels[handoverLinkID]
	cut := func(class string) {
		item.Cut()
		p.handoverTracker.Cut(class, 1)
	}
	if ownerKind != proxySecureLinkOwnerKind || p.secureLinks == nil {
		cut(handover.CutResumeFailed)
		return
	}
	config, ok := p.resumeConfig(ownerKind, linkID, p.relayGrants.lookup("connect", ownerKind, linkID))
	p.secureLinks.mu.Lock()
	binding := p.secureLinks.bindings[linkID]
	p.secureLinks.mu.Unlock()
	if !ok || config.RouteID != item.State.RouteID || binding == nil {
		cut(handover.CutRevoked)
		return
	}
	session, err := p.relayStreams.RestoreSource(config, item.State)
	if err != nil {
		cut(handover.CutResumeFailed)
		return
	}
	p.handoverTracker.Track(session)
	tracked := newTrackedConn(item.Conn).(*trackedConn)
	tracked.opened.Store(true)
	tracked.resumable.Store(true)
	// A loopback connection keeps the reset-on-cut it had (SO_LINGER belongs to the socket): only its normal end
	// clears it, here as in the previous process.
	loopback := binding.isLoopbackConn(item.Conn)
	tracked.loopback.Store(loopback)
	binding.activeMu.Lock()
	binding.active[tracked] = item.Conn.LocalAddr().Network() == "unix" || loopback
	binding.activeMu.Unlock()
	go func() {
		defer func() {
			binding.activeMu.Lock()
			delete(binding.active, tracked)
			binding.activeMu.Unlock()
		}()
		defer tracked.Close()
		_ = p.handover.Bridge(tracked, session, handover.BridgeConfig{ReadChunk: relayresume.ReadChunk(p.relayReadChunk()),
			Labels: item.Labels})
		session.Cancel()
	}()
}

// relayReadChunk is the read size of a Secure Link bridge.
func (p *NginxPlugin) relayReadChunk() int {
	readChunk := 0
	if p.relayGrants != nil {
		readChunk = int(p.relayGrants.readChunkBytes())
	}
	if readChunk == 0 {
		readChunk = 32 * 1024
	}
	return readChunk
}

// The tracked connection keeps no byte of its own once its bridge runs (the
// bytes read before go out first): a handover passes the socket inside on.

func (c *trackedConn) HandoverInner() net.Conn { return c.Conn }

func (c *trackedConn) MarkHandedOver() { c.handedOver.Store(true) }

// leaveStreamTotals leaves the cut total, the streams this exit cuts included, to the next process (Shutdown): a
// restart that is no update (a launcher that crashed, stand rc.7 O-5) otherwise loses them from the node's counters.
func (p *NginxPlugin) leaveStreamTotals() {
	if p.relayStreams == nil || p.baseCfg == nil || p.baseCfg.StateDir == "" {
		return
	}
	if err := handover.WriteStreamTotals(p.baseCfg.StateDir, handover.StreamTotals{Cut: p.relayStreams.ExitCut()}); err != nil && p.logger != nil {
		p.logger.Warn("could not leave the relay stream counters to the next daemon process", "error", err)
	}
}
