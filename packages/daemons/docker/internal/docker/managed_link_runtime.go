package docker

import (
	"net"
	"sync"
	"sync/atomic"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// managedLinkRuntimeCapability tells Gateway that the health report carries the connections of the node's managed
// links (HealthReport.managed_links): a link the report leaves out has none.
const managedLinkRuntimeCapability = "managed_link_runtime_v1"

// managedLinkCompletedCapability tells Gateway that the link reports carry completed_total (the sessions that
// ended); an older daemon's reports read 0 there.
const managedLinkCompletedCapability = "managed_link_completed_v1"

// managedLinkDefaultSessions is a link's concurrent connections when its grant names no session limit (an older
// Gateway); Gateway signs its link capacity (MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS) into the grant.
const managedLinkDefaultSessions = 64

// linkConnectionCounts holds the links that reach the relay without a host listener (a storage link's connector, a
// link of the shared connector's egress) at their limit: the node is the link's single gate, whichever relay of the pool
// carries a connection. The zero value is ready to use.
type linkConnectionCounts struct {
	mu     sync.Mutex
	active map[linkKey]int
}

// acquire takes one of the link's limit connections; false when it carries them all.
func (c *linkConnectionCounts) acquire(link linkKey, limit int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active[link] >= limit {
		return false
	}
	if c.active == nil {
		c.active = map[linkKey]int{}
	}
	c.active[link]++
	return true
}

// force takes one of the link's connections whatever its limit: a connection a
// handover brought along was admitted already.
func (c *linkConnectionCounts) force(link linkKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active == nil {
		c.active = map[linkKey]int{}
	}
	c.active[link]++
}

func (c *linkConnectionCounts) release(link linkKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active[link] <= 1 {
		delete(c.active, link)
		return
	}
	c.active[link]--
}

func (c *linkConnectionCounts) count(link linkKey) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.active[link]
}

// linkTraffic counts what each link carried through this node: the sessions a relay opened for it and the bytes in
// each direction. The node proxies every connection of the link, whichever relay of the pool carries it, so these are
// the link's totals. The zero value is ready to use.
type linkTraffic struct {
	mu    sync.Mutex
	links map[linkKey]*linkTrafficCounts
}

type linkTrafficCounts struct {
	opened         atomic.Uint64
	completed      atomic.Uint64
	sourceToTarget atomic.Uint64
	targetToSource atomic.Uint64
}

// carry counts a session a relay opened for link and returns connection counting the bytes it carries over it.
func (t *linkTraffic) carry(link linkKey, connection net.Conn) net.Conn {
	t.mu.Lock()
	if t.links == nil {
		t.links = map[linkKey]*linkTrafficCounts{}
	}
	counts := t.links[link]
	if counts == nil {
		counts = &linkTrafficCounts{}
		t.links[link] = counts
	}
	t.mu.Unlock()
	counts.opened.Add(1)
	return &linkCountedConn{Conn: connection, counts: counts}
}

// completed counts a session of link that ended: call it once the session carry returned closed.
func (t *linkTraffic) completed(link linkKey) {
	t.mu.Lock()
	counts := t.links[link]
	t.mu.Unlock()
	if counts != nil {
		counts.completed.Add(1)
	}
}

// counts returns what the links in keep carried and forgets every other link (a link that left the node).
func (t *linkTraffic) counts(keep map[linkKey]struct{}) map[linkKey]*pb.ManagedLinkRuntime {
	t.mu.Lock()
	defer t.mu.Unlock()
	result := make(map[linkKey]*pb.ManagedLinkRuntime, len(t.links))
	for link, counts := range t.links {
		if _, present := keep[link]; !present {
			delete(t.links, link)
			continue
		}
		result[link] = &pb.ManagedLinkRuntime{OpenedTotal: counts.opened.Load(), CompletedTotal: counts.completed.Load(),
			SourceToTargetBytes: counts.sourceToTarget.Load(), TargetToSourceBytes: counts.targetToSource.Load()}
	}
	return result
}

// linkCountedConn is the workload side of a link session: what it reads goes to the target, what it writes came
// from it.
type linkCountedConn struct {
	net.Conn
	counts *linkTrafficCounts
}

func (c *linkCountedConn) Read(buffer []byte) (int, error) {
	n, err := c.Conn.Read(buffer)
	c.counts.sourceToTarget.Add(uint64(max(n, 0)))
	return n, err
}

func (c *linkCountedConn) Write(buffer []byte) (int, error) {
	n, err := c.Conn.Write(buffer)
	c.counts.targetToSource.Add(uint64(max(n, 0)))
	return n, err
}

// CloseWrite half-closes the workload's connection like the bridge does without the counter.
func (c *linkCountedConn) CloseWrite() error {
	if half, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return nil
}

// managedLinkRuntime reports every managed database, storage and container link this node serves workloads of (a connect grant
// in the bundle): its open connections, its limit, what it refused and what it carried.
func (p *DockerPlugin) managedLinkRuntime() []*pb.ManagedLinkRuntime {
	if p.relayGrants == nil {
		return nil
	}
	var listenerConnections map[string]int
	if p.databaseListeners != nil {
		listenerConnections = p.databaseListeners.activeConnections()
	}
	type reportedLink struct {
		key   linkKey
		limit uint32
	}
	var links []reportedLink
	keep := map[linkKey]struct{}{}
	p.relayGrants.withCurrent(func(bundle *pb.SyncRelayGrantsCommand) {
		for _, assignment := range bundle.GetGrants() {
			kind := assignment.GetOwnerKind()
			if assignment.GetRole() != "connect" || (kind != linkKindManagedDatabaseBinding && kind != linkKindManagedStorageBinding && kind != containerLinkOwnerKind) {
				continue
			}
			key := linkKey{kind: kind, id: assignment.GetOwnerId()}
			if _, seen := keep[key]; seen {
				continue
			}
			keep[key] = struct{}{}
			links = append(links, reportedLink{key: key, limit: relayGrantSessionLimit(assignment, managedLinkDefaultSessions)})
		}
	})
	rejections := p.linkRejections.counts(keep)
	traffic := p.linkTraffic.counts(keep)
	reports := make([]*pb.ManagedLinkRuntime, 0, len(links))
	for _, link := range links {
		active := p.linkConnections.count(link.key)
		if link.key.kind == linkKindManagedDatabaseBinding {
			active += listenerConnections[link.key.id]
		}
		counts := rejections[link.key]
		report := &pb.ManagedLinkRuntime{
			OwnerKind: link.key.kind, OwnerId: link.key.id, ActiveConnections: uint32(active),
			ConnectionLimit: link.limit, RejectedTotal: counts.atCapacity, LastRejectionReason: counts.lastReason,
		}
		if !counts.lastAt.IsZero() {
			report.LastRejectedAtUnixMs = counts.lastAt.UnixMilli()
		}
		if carried := traffic[link.key]; carried != nil {
			report.OpenedTotal, report.SourceToTargetBytes, report.TargetToSourceBytes, report.CompletedTotal =
				carried.GetOpenedTotal(), carried.GetSourceToTargetBytes(), carried.GetTargetToSourceBytes(), carried.GetCompletedTotal()
		}
		reports = append(reports, report)
	}
	return reports
}
