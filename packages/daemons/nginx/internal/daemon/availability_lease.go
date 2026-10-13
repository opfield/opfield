package daemon

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasegate"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// availabilityLeaseCapability is advertised once this daemon can derive
// Secure Link socket state from relay lease gate views. nginx daemons are
// observers only: they never vote and hold no acceptor state (A18-A20; the
// per-policy voter set now travels inside the manifest, and witnesses are
// relays or docker nodes, never nginx).
// It is versioned (D3): Opfield requires v2 of every lease participant and
// treats v1 as outdated.
const availabilityLeaseCapability = "availability_lease_v2"

// availabilityLeaseSweepInterval bounds how often stale Secure Link sockets
// are noticed and closed without waiting for a relay to broadcast that their
// gate view is gone (D8, A8).
const availabilityLeaseSweepInterval = 250 * time.Millisecond

// availabilityLeaseAdoptionGrace is how long a member socket taken over open
// from the previous daemon process stays open while no relay has reported on
// its policy yet: long enough for this process to reach its relays after a
// restart, short enough that a socket nothing vouches for closes. The relays
// gate the member's tunnels themselves meanwhile, so this only decides whether
// nginx connects or moves on before sending a byte.
const availabilityLeaseAdoptionGrace = 10 * time.Second

// availabilityLeaseReconnectDelay paces WatchLeaseGates retries.
const availabilityLeaseReconnectDelay = time.Second

// availabilityLeaseObsoleteStateFile is the persisted acceptor state file an
// earlier build of this daemon may have created, back when nginx daemons
// could be named voters. It is removed on start: nginx never runs the
// availabilitylease acceptor now, so nothing ever reads it again, and
// leaving it behind would only be confusing on a future audit of the state
// directory.
const availabilityLeaseObsoleteStateFile = "availability-lease-state.json"

// availabilityLeaseCoordinator derives Secure Link socket state for
// availability members from relay lease gate views (D8, A8). It holds no
// protocol state of its own: gate views are relay-reported facts with their
// own TTL, not something this daemon needs to persist or vote on.
type availabilityLeaseCoordinator struct {
	logger  *slog.Logger
	sockets *sourceLinkManager

	gates *leasegate.Tracker

	mu       sync.Mutex
	watched  map[string]bool // relay member id -> a WatchLeaseGates stream is already running
	revision uint64

	stopOnce sync.Once
	stop     chan struct{}
}

func newAvailabilityLeaseCoordinator(stateDir string, sockets *sourceLinkManager, logger *slog.Logger) *availabilityLeaseCoordinator {
	removeObsoleteAvailabilityLeaseState(stateDir, logger)
	return &availabilityLeaseCoordinator{
		logger:  logger,
		sockets: sockets,
		gates:   leasegate.NewTracker(),
		watched: map[string]bool{},
		stop:    make(chan struct{}),
	}
}

// removeObsoleteAvailabilityLeaseState is a migration-safe cleanup: it
// deletes the acceptor state file a pre-A18 build of this daemon may have
// created, if one exists. Its absence, or any error removing it, is not
// fatal: nginx never reads or writes this file anymore either way.
func removeObsoleteAvailabilityLeaseState(stateDir string, logger *slog.Logger) {
	if stateDir == "" {
		return
	}
	path := filepath.Join(stateDir, availabilityLeaseObsoleteStateFile)
	if err := os.Remove(path); err != nil {
		if !os.IsNotExist(err) && logger != nil {
			logger.Warn("failed to remove the obsolete availability lease acceptor state file", "path", path, "error", err)
		}
		return
	}
	if logger != nil {
		logger.Info("removed the obsolete availability lease acceptor state file", "path", path)
	}
}

// start runs the Secure Link socket sweep for the life of the process.
func (c *availabilityLeaseCoordinator) start() {
	go c.runSocketSweep()
}

func (c *availabilityLeaseCoordinator) close() {
	c.stopOnce.Do(func() { close(c.stop) })
}

func (c *availabilityLeaseCoordinator) logf(format string, args ...any) {
	if c.logger != nil {
		c.logger.Debug(fmt.Sprintf(format, args...))
	}
}

// runSocketSweep closes Secure Link sockets whose backing gate view has gone
// stale, without waiting for a relay to broadcast that it is gone (D8, A8).
func (c *availabilityLeaseCoordinator) runSocketSweep() {
	ticker := time.NewTicker(availabilityLeaseSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.reconcileSockets()
		}
	}
}

// reconcileSockets opens or closes every availability member's Secure Link
// socket according to the relay gate views currently held (D8, A8). Every
// view is aged out at at most the lease term T, regardless of what a relay
// reports (leasegate.Tracker.Apply).
func (c *availabilityLeaseCoordinator) reconcileSockets() {
	if c.sockets == nil {
		return
	}
	now := time.Now()
	for _, binding := range c.sockets.leaseGatedBindings() {
		open := c.gates.OpenFor(binding.PolicyID, binding.CandidateID, now)
		if !open && !c.gates.Reported(binding.PolicyID, now) &&
			c.sockets.adoptedWithin(binding.LinkID, now, availabilityLeaseAdoptionGrace) {
			// Taken over open from the previous process: no relay reported on
			// this policy yet since the restart.
			continue
		}
		if err := c.sockets.setLeaseOpen(binding.LinkID, open); err != nil {
			c.logf("availability lease socket %s: %v", binding.LinkID, err)
		}
	}
}

// apply acknowledges a SyncAvailabilityLeaseCommand. nginx daemons are
// observers only (A18-A20): they hold no policy keys, voters or manifests of
// their own, so there is nothing here to adopt. The revision is still
// tracked and echoed back in the heartbeat, so Opfield's "resend until
// lease_revision >= revision" loop settles instead of retrying forever.
func (c *availabilityLeaseCoordinator) apply(command *pb.SyncAvailabilityLeaseCommand) (string, error) {
	if command == nil {
		return "", nil
	}
	c.mu.Lock()
	if command.GetRevision() > c.revision {
		c.revision = command.GetRevision()
	}
	c.mu.Unlock()
	return "", nil
}

// buildReport is this daemon's minimal availability-lease heartbeat: nginx
// is never a candidate, voter or acceptor, so only the last applied
// revision is meaningful.
func (c *availabilityLeaseCoordinator) buildReport() *pb.AvailabilityLeaseReport {
	c.mu.Lock()
	revision := c.revision
	c.mu.Unlock()
	return &pb.AvailabilityLeaseReport{LeaseRevision: revision}
}
