package lease

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// ErrLeaseNotHeld is returned by the backend gate (A5).
var ErrLeaseNotHeld = errors.New("availability lease is not held by this node")

// DecodeBlockUpdate turns the opaque serialized relay.v1 messages of T3's
// SyncAvailabilityLeaseCommand into a BlockUpdate. Nothing is trusted here:
// signatures are verified when the node adopts the blocks.
func DecodeBlockUpdate(revision uint64, memberID string, keys []PolicyKey, rotations [][]byte, manifests [][]byte) (BlockUpdate, error) {
	update := BlockUpdate{Revision: revision, MemberID: memberID, PolicyKeys: keys}
	for _, data := range rotations {
		link := &relayv1.LeasePolicyKeyRotation{}
		if err := proto.Unmarshal(data, link); err != nil {
			return BlockUpdate{}, fmt.Errorf("decode lease key rotation: %w", err)
		}
		update.KeyRotations = append(update.KeyRotations, link)
	}
	for _, data := range manifests {
		block := &relayv1.LeaseSignedBlock{}
		if err := proto.Unmarshal(data, block); err != nil {
			return BlockUpdate{}, fmt.Errorf("decode lease manifest: %w", err)
		}
		update.Manifests = append(update.Manifests, block)
	}
	return update, nil
}

// ApplyLeaseBlocks adopts Opfield-delivered trust and signed blocks. Keys come
// over the authenticated CommandStream and are trusted directly; rotation
// links and blocks are verified by the protocol node (A4, A14). Adoption is
// durable before this returns, so the next report is the persisted ack.
func (r *Runtime) ApplyLeaseBlocks(update BlockUpdate) error {
	if update.MemberID != "" && update.MemberID != r.opts.NodeID {
		return fmt.Errorf("lease member id %q does not match this node %q", update.MemberID, r.opts.NodeID)
	}
	var errs []error
	for _, key := range update.PolicyKeys {
		if err := r.node.TrustPolicyKey(key.ID, key.PublicKey); err != nil {
			errs = append(errs, fmt.Errorf("policy key %s: %w", key.ID, err))
		}
	}
	for _, link := range update.KeyRotations {
		if err := r.node.AdoptKeyRotation(link); err != nil {
			errs = append(errs, fmt.Errorf("key rotation %s: %w", link.GetKeyId(), err))
		}
	}
	for _, block := range update.Manifests {
		if _, err := r.node.AdoptManifest(block); err != nil {
			errs = append(errs, fmt.Errorf("manifest: %w", err))
		}
	}
	r.mu.Lock()
	if update.Revision > r.revision {
		r.revision = update.Revision
	}
	r.mu.Unlock()
	r.kick()
	return errors.Join(errs...)
}

// BeforeStart is called at every Docker start site of this daemon, right
// before a container of policyID starts (A12.1, A5). For a lease-mode policy
// it allows the start only while this node may start under a fresh watchdog
// heartbeat and no stop or release is under way, and it writes the
// container's deadline record with the holder's deadline before returning.
// For a policy outside lease mode it clears stale records so the watchdog
// does not kill the legacy start.
func (r *Runtime) BeforeStart(containerID, policyID, cgroupPath string) error {
	manifest, ok := r.node.ManifestInfo(policyID)
	if !ok || manifest.Closed {
		return r.clearLegacyRecords(policyID)
	}
	if !leasefence.ValidContainerID(containerID) {
		return fmt.Errorf("%w: container id %q cannot carry a deadline record", ErrLeaseNotHeld, containerID)
	}
	now := r.opts.Clock.Now()
	if !HeartbeatFresh(r.opts.Fence, now) {
		return fmt.Errorf("%w: the lease watchdog is not running", ErrLeaseNotHeld)
	}
	var status availabilitylease.HolderStatus
	for slot := uint32(0); slot < manifest.Slots; slot++ {
		if candidate := r.node.HolderStatus(availabilitylease.Key{PolicyID: policyID, Slot: slot}); candidate.MayStart {
			status = candidate
			break
		}
	}
	if !status.MayStart || status.Deadline <= now {
		return ErrLeaseNotHeld
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if wl := r.workloads[policyID]; wl != nil && (wl.release != nil || (wl.busy && wl.op == "stop")) {
		return fmt.Errorf("%w: the workload is being stopped", ErrLeaseNotHeld)
	}
	r.writeRecordLocked(Container{ID: containerID, PolicyID: policyID, CgroupPath: cgroupPath}, status.Key.Slot, status.Deadline)
	record, ok := r.records[containerID]
	if !ok || record.Deadline() <= now {
		return fmt.Errorf("%w: the deadline record could not be written", ErrLeaseNotHeld)
	}
	return nil
}

// Holds reports whether this node holds (or recovers) a slot of the policy.
// Recovering reports whether this node recovered a running copy of the
// policy after a daemon start on a watchdog record that is still live, and
// renews it now (A2.3): the lease is provably still this node's until that
// deadline, so the copy keeps serving meanwhile (B-13).
func (r *Runtime) Recovering(policyID string) bool {
	for _, status := range r.node.Holders() {
		if status.Key.PolicyID == policyID && status.Role == availabilitylease.RoleRecovering && !status.FenceNow {
			return true
		}
	}
	return false
}

// Prime runs the daemon-start steps (the first container view and the
// startup fence, which recovers running copies on live records) before the
// loop starts, for at most wait, so the endpoints of a recovered copy
// register serving from the first registration (B-13). A hung dockerd only
// delays the start by wait; Run finishes the steps then.
//
// Records it cannot read (a switch of the daemon's user the records have not followed yet) shorten the wait to
// primeUnreadableWait: the daemon's relays and links wait for Prime, and only a watchdog that hands the records over
// within moments helps here; Run finishes the start once they can be read.
func (r *Runtime) Prime(wait time.Duration) {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		r.Step()
		r.mu.Lock()
		started, unreadable := r.started, r.recordsUnreadable
		r.mu.Unlock()
		if started {
			// The recovered keys show up in the next step's holder view.
			r.Step()
			return
		}
		if unreadable {
			deadline = earlier(deadline, time.Now().Add(primeUnreadableWait))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// primeUnreadableWait bounds Prime while the watchdog records cannot be read.
var primeUnreadableWait = time.Second

func earlier(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

func (r *Runtime) Holds(policyID string) bool {
	for _, status := range r.node.Holders() {
		if status.Key.PolicyID == policyID && (status.Role == availabilitylease.RoleHolding || status.Role == availabilitylease.RoleRecovering) {
			return true
		}
	}
	return false
}

// BootstrapPending reports whether this node is the named initial holder of
// a slot of the policy and has not acquired it yet (A5).
func (r *Runtime) BootstrapPending(policyID string) bool {
	manifest, ok := r.node.ManifestInfo(policyID)
	if !ok {
		return false
	}
	return r.bootstrapPendingLocked(manifest)
}

// LeaseMode reports whether the policy runs under a lease manifest that is
// not closed.
func (r *Runtime) LeaseMode(policyID string) bool { return r.node.LeaseMode(policyID) }

// CheckServe is the backend gate (A5): while a lease-mode manifest exists for
// the policy, a backend start or serve command for its placements runs only
// when this node holds the lease, its watchdog is alive and no release is
// under way. Placement generations are still checked separately (D12).
func (r *Runtime) CheckServe(policyID string) error {
	manifest, ok := r.node.ManifestInfo(policyID)
	if !ok || manifest.Closed {
		return r.clearLegacyRecords(policyID)
	}
	now := r.opts.Clock.Now()
	if !HeartbeatFresh(r.opts.Fence, now) {
		return fmt.Errorf("%w: the lease watchdog is not running", ErrLeaseNotHeld)
	}
	r.mu.Lock()
	releasing := r.workloads[policyID] != nil && r.workloads[policyID].release != nil
	r.mu.Unlock()
	if releasing {
		return fmt.Errorf("%w: a release is in progress", ErrLeaseNotHeld)
	}
	for slot := uint32(0); slot < manifest.Slots; slot++ {
		if r.node.HolderStatus(availabilitylease.Key{PolicyID: policyID, Slot: slot}).MayStart {
			return nil
		}
	}
	return ErrLeaseNotHeld
}

// clearLegacyRecords removes the deadline records of a policy that left
// lease mode before legacy starts its containers, so the watchdog does not
// kill them. A record goes only once this node no longer holds the key and
// the container's cgroup is confirmed empty (A12.3); otherwise the start is
// refused and the backend retries. A retained holder is not a release under
// way: the graceful close handed its running copy to legacy, its watchdog
// deadline is disarmed, and the backend's commands for it (a disable adopting
// it as the standalone workload, a stop, a restart) pass (B-20).
func (r *Runtime) clearLegacyRecords(policyID string) error {
	for _, status := range r.node.Holders() {
		if status.Key.PolicyID == policyID && status.Role != availabilitylease.RoleRetained && rolePriority(status.Role) >= 3 {
			return fmt.Errorf("%w: the closed lease is still being released", ErrLeaseNotHeld)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, record := range r.records {
		if record.PolicyID != policyID {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), dockerCallWait)
		empty, err := r.opts.Engine.CgroupEmpty(ctx, Container{ID: id, CgroupPath: record.CgroupPath})
		cancel()
		if err != nil || !empty {
			continue
		}
		if err := r.opts.Fence.DeleteRecord(id); err != nil {
			return fmt.Errorf("clear lease deadline record: %w", err)
		}
		delete(r.records, id)
	}
	return nil
}

// Handoff starts a planned release to a designated successor (D9). The
// holder deregisters its endpoint, stops its workload, confirms the cgroup is
// empty and only then releases (A6); the outcome is reported as an event.
func (r *Runtime) Handoff(request Handoff) error {
	manifest, ok := r.node.ManifestInfo(request.PolicyID)
	if !ok || manifest.Closed {
		return fmt.Errorf("policy %s has no lease manifest", request.PolicyID)
	}
	if manifest.Version < request.ManifestVersion {
		return fmt.Errorf("manifest version %d of policy %s is not adopted yet (have %d)", request.ManifestVersion, request.PolicyID, manifest.Version)
	}
	if request.SuccessorID != "" && (!manifest.IsCandidate(request.SuccessorID) || request.SuccessorID == r.opts.NodeID) {
		return fmt.Errorf("successor %q is not another candidate of policy %s", request.SuccessorID, request.PolicyID)
	}
	status := r.node.HolderStatus(availabilitylease.Key{PolicyID: request.PolicyID, Slot: request.Slot})
	if status.Role != availabilitylease.RoleHolding || !status.MayStart {
		return fmt.Errorf("%w: slot %d of policy %s (role %s)", ErrLeaseNotHeld, request.Slot, request.PolicyID, status.Role)
	}
	r.mu.Lock()
	wl := r.workloadLocked(request.PolicyID)
	if wl.release == nil {
		wl.release = &releaseIntent{successor: request.SuccessorID, operationID: request.OperationID, reason: "handoff"}
	}
	r.mu.Unlock()
	// SuccessorGeneration is the successor placement's generation (its last
	// standby prepare, T6 §3.3); the successor serves under it after it
	// acquires, and reports it with its held key (D12).
	r.logger.Info("availability lease handoff requested", "policy_id", request.PolicyID, "slot", request.Slot,
		"successor_generation", request.SuccessorGeneration,
		"successor_id", request.SuccessorID, "operation_id", request.OperationID)
	r.kick()
	return nil
}
