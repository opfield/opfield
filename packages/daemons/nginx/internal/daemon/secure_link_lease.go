package daemon

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

// leaseGatedBinding names one availability member's Secure Link socket for
// the availability-lease coordinator to reconcile against relay gate views
// (D8, A8).
type leaseGatedBinding struct {
	LinkID      string
	PolicyID    string
	CandidateID string
}

// applyLeaseMetadata records which availability member a newly staged
// binding serves. A lease-gated binding starts with its Unix socket closed:
// it opens only once a relay gate view says its candidate holds the lease
// (D8, A8). Non-availability bindings are left exactly as they were: their
// Unix socket keeps listening unconditionally.
//
// A listener taken over from the previous daemon process was open when that
// process stopped, so it stays open: the relay gate views that decide it
// arrive only once this process reached the relays, and closing it meanwhile
// would refuse the holder's traffic through the whole restart. The socket
// sweep then decides it like any other (see reconcileSockets).
func applyLeaseMetadata(binding *sourceLinkBinding, desired *pb.ProxySecureLinkBinding) {
	binding.availabilityPolicyID = desired.GetAvailabilityPolicyId()
	binding.availabilityCandidateID = desired.GetAvailabilityCandidateId()
	binding.dormant = desired.GetDormant()
	binding.leaseGated = binding.availabilityPolicyID != ""
	if !binding.leaseGated {
		return
	}
	if !binding.adoptedAt.IsZero() && binding.unix != nil {
		binding.leaseOpen = true
		return
	}
	binding.closeUnixForLease()
}

// refreshLeaseMetadata applies a resync's lease fields to a binding that
// already exists. A policy enters lease mode after its members were created
// (legacy, then bootstrapping, then lease) and leaves it when the lease
// closes, so these fields change under live bindings. A binding that stops
// being lease-gated listens again at once; one that becomes gated keeps its
// socket until the reconciliation that follows every sync closes it, unless a
// relay gate view admits its candidate (D8, A8, B2).
func (m *sourceLinkManager) refreshLeaseMetadata(id string, binding *sourceLinkBinding, desired *pb.ProxySecureLinkBinding) error {
	binding.leaseMu.Lock()
	binding.availabilityPolicyID = desired.GetAvailabilityPolicyId()
	binding.availabilityCandidateID = desired.GetAvailabilityCandidateId()
	binding.dormant = desired.GetDormant()
	binding.leaseGated = binding.availabilityPolicyID != ""
	reopen := !binding.leaseGated && binding.unix == nil
	binding.leaseMu.Unlock()
	if !reopen {
		return nil
	}
	return binding.openUnixForLease(m, id)
}

// closeUnixForLease stops accepting on this binding's Unix socket, so a
// connect attempt fails immediately instead of nginx waiting on a request
// timeout (D8, A8). The socket file stays (B-13): nginx gets a fast refusal
// (ECONNREFUSED) and moves on to the next member before sending a byte, and
// reopening replaces the file in one step, so the path is never missing.
// New connections are refused from this moment even while the listener
// keeper still holds a copy of the socket. Connections already established
// are left running: in-flight requests at the exact switch moment may still
// see an error from upstream, which is the documented residual (A8).
func (b *sourceLinkBinding) closeUnixForLease() {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	b.leaseOpen = false
	b.adoptedAt = time.Time{}
	// A closed loopback endpoint refuses at once too (a reset to the SYN).
	b.closeLoopbackLocked(false)
	if b.unix == nil {
		return
	}
	refuseNewConnections(b.unix)
	if b.keptName != "" {
		_ = listenerkeep.Drop(b.keptName)
		b.keptName = ""
	}
	if unixListener, ok := b.unix.(*net.UnixListener); ok {
		unixListener.SetUnlinkOnClose(false)
	}
	_ = b.unix.Close()
	b.unix = nil
}

// refuseNewConnections makes a listening Unix or TCP socket refuse every new
// connection at once (shutdown(SHUT_RD): the kernel answers connect() with
// ECONNREFUSED, a TCP one stops listening), whatever process still holds a
// copy of it.
func refuseNewConnections(listener net.Listener) {
	conn, ok := listener.(syscall.Conn)
	if !ok {
		return
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		_ = syscall.Shutdown(int(fd), syscall.SHUT_RD)
	})
}

// openUnixForLease (re)creates and starts accepting on this binding's Unix
// socket once a relay gate view says its candidate holds the lease.
func (b *sourceLinkBinding) openUnixForLease(m *sourceLinkManager, id string) error {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	b.leaseOpen = true
	select {
	case <-b.done:
		// The binding was removed entirely; there is nothing left to open.
		return nil
	default:
	}
	if b.unix == nil {
		listener, keptName, err := m.listenUnixSocket(b.socketPath)
		if err != nil {
			return err
		}
		b.unix = listener
		m.accept(id, b, listener, true)
		if keptName == "" {
			keptName = keepUnixListener(listener, b.socketPath)
		}
		b.keptName = keptName
	}
	return b.openLoopbackLocked(m, id)
}

// adoptedWithin reports whether this binding's listener was taken over from
// the previous daemon process less than grace ago and has not been closed
// since.
func (m *sourceLinkManager) adoptedWithin(linkID string, now time.Time, grace time.Duration) bool {
	m.mu.Lock()
	binding := m.bindings[linkID]
	m.mu.Unlock()
	if binding == nil {
		return false
	}
	binding.leaseMu.Lock()
	defer binding.leaseMu.Unlock()
	return binding.unix != nil && !binding.adoptedAt.IsZero() && now.Sub(binding.adoptedAt) < grace
}

// leaseGate reports whether this binding is gated by an availability lease
// and, if so, the policy and candidate it represents (D8).
func (b *sourceLinkBinding) leaseGate() (policyID, candidateID string, gated bool) {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	return b.availabilityPolicyID, b.availabilityCandidateID, b.leaseGated
}

// setLeaseOpen opens or closes a lease-gated binding's socket. It is a no-op
// for bindings that are not availability members or that no longer exist.
func (m *sourceLinkManager) setLeaseOpen(linkID string, open bool) error {
	m.mu.Lock()
	binding := m.bindings[linkID]
	m.mu.Unlock()
	if binding == nil || !binding.leaseGated {
		return nil
	}
	if open {
		return binding.openUnixForLease(m, linkID)
	}
	binding.closeUnixForLease()
	return nil
}

// leaseGatedBindings lists the availability members currently registered, for
// the availability-lease coordinator to reconcile against relay gate views.
func (m *sourceLinkManager) leaseGatedBindings() []leaseGatedBinding {
	m.mu.Lock()
	defer m.mu.Unlock()
	bindings := make([]leaseGatedBinding, 0, len(m.bindings))
	for id, binding := range m.bindings {
		policyID, candidateID, gated := binding.leaseGate()
		if !gated {
			continue
		}
		bindings = append(bindings, leaseGatedBinding{LinkID: id, PolicyID: policyID, CandidateID: candidateID})
	}
	return bindings
}

// secureLinkSocketReference matches a Unix socket an nginx config proxies to.
var secureLinkSocketReference = regexp.MustCompile(`unix:(/[^\s;:]+\.sock)`)

// ensureReferencedListeners makes every Secure Link socket a config
// references listen before nginx loads that config (M-2, make-before-break),
// when its binding should listen: a plain binding, or a lease-gated one whose
// candidate a relay gate view admits. A socket file that went missing under
// such a binding is recreated. Lease-gated sockets closed by design (a
// standby, a holder not ready) stay closed: nginx refuses them before sending
// a byte and moves to the next member. Returns the referenced sockets of this
// daemon's socket directory that it does not provide.
func (m *sourceLinkManager) ensureReferencedListeners(config string) []string {
	var absent []string
	seen := map[string]bool{}
	for _, match := range secureLinkSocketReference.FindAllStringSubmatch(config, -1) {
		socketPath := match[1]
		if seen[socketPath] || !naming.SameDir(filepath.Dir(socketPath), filepath.Clean(m.socketDir)) {
			continue
		}
		seen[socketPath] = true
		m.mu.Lock()
		var id string
		var binding *sourceLinkBinding
		for candidateID, candidate := range m.bindings {
			if sameSocketPath(candidate.socketPath, socketPath) {
				id, binding = candidateID, candidate
				break
			}
		}
		m.mu.Unlock()
		if binding == nil {
			absent = append(absent, socketPath)
			continue
		}
		if err := binding.ensureUnixListening(m, id); err != nil {
			absent = append(absent, socketPath)
		}
	}
	for _, match := range secureLinkLoopbackReference.FindAllStringSubmatch(config, -1) {
		address := match[1]
		if seen[address] {
			continue
		}
		seen[address] = true
		m.mu.Lock()
		var id string
		var binding *sourceLinkBinding
		for candidateID, candidate := range m.bindings {
			candidate.leaseMu.Lock()
			owns := candidate.loopAddr == address
			candidate.leaseMu.Unlock()
			if owns {
				id, binding = candidateID, candidate
				break
			}
		}
		m.mu.Unlock()
		if binding == nil {
			// Not a Secure Link endpoint of this daemon (another upstream on a loopback address).
			continue
		}
		if err := binding.ensureUnixListening(m, id); err != nil {
			absent = append(absent, address)
		}
	}
	return absent
}

// ensureUnixListening recreates the Unix listener of a binding that should
// listen when its socket file is gone (removed by hand, or lost with a failed
// reopen). A lease-gated binding the gate keeps closed is left alone.
func (b *sourceLinkBinding) ensureUnixListening(m *sourceLinkManager, id string) error {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	if b.leaseGated && !b.leaseOpen {
		return errors.New("closed by the availability lease gate")
	}
	select {
	case <-b.done:
		return errors.New("binding removed")
	default:
	}
	if b.unix == nil && !b.leaseGated && !b.socketOnly && b.listener != nil {
		// A legacy loopback binding without a Unix socket.
		return nil
	}
	if b.unix != nil {
		if _, err := os.Stat(b.socketPath); err == nil {
			return b.openLoopbackLocked(m, id)
		}
		if b.keptName != "" {
			_ = listenerkeep.Drop(b.keptName)
			b.keptName = ""
		}
		_ = b.unix.Close()
		b.unix = nil
	}
	listener, keptName, err := m.listenUnixSocket(b.socketPath)
	if err != nil {
		return err
	}
	b.unix = listener
	m.accept(id, b, listener, true)
	if keptName == "" {
		keptName = keepUnixListener(listener, b.socketPath)
	}
	b.keptName = keptName
	return b.openLoopbackLocked(m, id)
}
