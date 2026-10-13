package daemon

import (
	"errors"
	"io"
	"net"
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasegate"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

func availabilityMemberCommand(policyID, candidateID string) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: testSecureLinkID, Role: "source", Generation: 1, SocketOnly: true,
		AvailabilityPolicyId: policyID, AvailabilityCandidateId: candidateID,
	}}}
}

// TestSourceLinkManagerAvailabilityMemberStartsClosed covers D8/A8: a newly
// synced availability member's socket does not listen until a relay gate
// view says its candidate holds the lease.
func TestSourceLinkManagerAvailabilityMemberStartsClosed(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(availabilityMemberCommand("policy-1", "node-a"))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	if _, err := net.DialTimeout("unix", statuses[0].SocketPath, 200*time.Millisecond); err == nil {
		t.Fatal("an availability member's socket must not accept connections before any lease view opens it")
	}
}

// TestSourceLinkManagerNonAvailabilityMemberSocketUnaffected covers the "non-
// availability sockets are unchanged" requirement: a plain binding keeps
// listening exactly as it did before this feature existed.
func TestSourceLinkManagerNonAvailabilityMemberSocketUnaffected(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(sourceCommand(0, 1))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	connection, err := net.DialTimeout("unix", statuses[0].SocketPath, time.Second)
	if err != nil {
		t.Fatalf("a non-availability socket must keep listening unconditionally: %v", err)
	}
	_ = connection.Close()
}

// TestAvailabilityLeaseCoordinatorOpensAndClosesSocketOnGateViewChanges
// covers D8/A8 end to end through the coordinator: the socket opens once a
// relay gate view admits its candidate, and closes the moment the view moves
// to a different holder.
func TestAvailabilityLeaseCoordinatorOpensAndClosesSocketOnGateViewChanges(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(availabilityMemberCommand("policy-1", "node-a"))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	socketPath := statuses[0].SocketPath

	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), manager, nil)
	defer coordinator.close()

	coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 30000,
	}}}, time.Now())
	coordinator.reconcileSockets()

	connection, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatalf("socket did not open once the gate view admitted its candidate: %v", err)
	}
	_ = connection.Close()

	// The lease moves to a different holder: node-a's socket must close.
	coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-b", RemainingMs: 30000,
	}}}, time.Now())
	coordinator.reconcileSockets()

	if _, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond); err == nil {
		t.Fatal("socket stayed open after the gate view moved to a different holder")
	}

	// The lease returns to node-a: the socket reopens.
	coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 30000,
	}}}, time.Now())
	coordinator.reconcileSockets()
	connection, err = net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatalf("socket did not reopen once the view admitted node-a again: %v", err)
	}
	_ = connection.Close()
}

// Stand run ha18/a: members are created while their policy is still legacy or
// bootstrapping, so without lease fields, and resent with them once the policy
// reaches lease mode. The resync used to leave the existing binding ungated:
// every member's socket stayed open, nginx kept sending requests to the
// standbys, and one transient holder error took the route down for the whole
// fail_timeout.
func TestResyncWithLeaseFieldsGatesAnExistingMemberAndLegacyReopensIt(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), manager, nil)
	defer coordinator.close()
	bootstrapping := availabilityMemberCommand("", "")
	statuses, err := manager.sync(bootstrapping)
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	socketPath := statuses[0].SocketPath
	connection, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatalf("a member outside lease mode listens like any link: %v", err)
	}
	_ = connection.Close()

	// The policy reached lease mode and another candidate holds the lease.
	coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-b", RemainingMs: 30000,
	}}}, time.Now())
	leased := availabilityMemberCommand("policy-1", "node-a")
	leased.Bindings[0].Generation = 2
	if _, err := manager.sync(leased); err != nil {
		t.Fatal(err)
	}
	coordinator.reconcileSockets()
	if _, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond); err == nil {
		t.Fatal("the standby member's socket stayed open after its policy entered lease mode")
	}

	// The lease closed: the member is legacy again and must listen without any gate view.
	closed := availabilityMemberCommand("", "")
	closed.Bindings[0].Generation = 3
	if _, err := manager.sync(closed); err != nil {
		t.Fatal(err)
	}
	coordinator.reconcileSockets()
	connection, err = net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatalf("a member that left lease mode must listen again: %v", err)
	}
	_ = connection.Close()
}

// TestAvailabilityLeaseCoordinatorClosesSocketOnStaleView covers D8/A8's
// "close instead of waiting for a broadcast" rule: once a view's own TTL
// elapses, the next reconciliation closes the socket even though no new
// snapshot ever arrived.
func TestAvailabilityLeaseCoordinatorClosesSocketOnStaleView(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(availabilityMemberCommand("policy-1", "node-a"))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	socketPath := statuses[0].SocketPath

	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), manager, nil)
	defer coordinator.close()

	coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 50,
	}}}, time.Now())
	coordinator.reconcileSockets()

	connection, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatalf("socket did not open: %v", err)
	}
	_ = connection.Close()

	time.Sleep(150 * time.Millisecond) // the view's 50ms TTL has elapsed; no new broadcast follows
	coordinator.reconcileSockets()

	if _, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond); err == nil {
		t.Fatal("socket stayed open after its gate view went stale")
	}
}

// TestAvailabilityLeaseCoordinatorOpensSocketOnLeaseModeFalseView covers the
// B2 fix end to end: a policy that leaves lease mode (or was never in it)
// must not leave its lease-bound Secure Link members closed forever. Once a
// relay reports lease_mode=false, the socket opens regardless of holder_id.
func TestAvailabilityLeaseCoordinatorOpensSocketOnLeaseModeFalseView(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(availabilityMemberCommand("policy-1", "node-a"))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	socketPath := statuses[0].SocketPath

	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), manager, nil)
	defer coordinator.close()

	// No view yet: the lease-bound member stays closed (fail closed).
	coordinator.reconcileSockets()
	if _, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond); err == nil {
		t.Fatal("a lease-bound member must stay closed before any view arrives")
	}

	// The relay reports the policy is not lease-bound (legacy admission, or
	// its lease just closed): the socket must open even though no view ever
	// named node-a as holder.
	coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: false, Open: false,
	}}}, time.Now())
	coordinator.reconcileSockets()

	connection, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatalf("socket did not open once the relay reported lease_mode=false: %v", err)
	}
	_ = connection.Close()
}

// TestAvailabilityLeaseCoordinatorSocketSweepClosesStaleViewOnItsOwn checks
// the background sweep started by (*availabilityLeaseCoordinator).start:
// nothing needs to call reconcileSockets by hand for a stale view to close.
func TestAvailabilityLeaseCoordinatorSocketSweepClosesStaleViewOnItsOwn(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	statuses, err := manager.sync(availabilityMemberCommand("policy-1", "node-a"))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	socketPath := statuses[0].SocketPath

	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), manager, nil)
	coordinator.start()
	defer coordinator.close()

	coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 700,
	}}}, time.Now())

	deadline := time.Now().Add(2 * time.Second)
	opened := false
	for time.Now().Before(deadline) {
		if _, err := net.DialTimeout("unix", socketPath, 50*time.Millisecond); err == nil {
			opened = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !opened {
		t.Fatal("background sweep never opened the socket once the gate view admitted its candidate")
	}

	deadline = time.Now().Add(3 * time.Second)
	for {
		_, dialErr := net.DialTimeout("unix", socketPath, 50*time.Millisecond)
		if dialErr != nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("background sweep never closed the socket once its view went stale")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// B-12b: the holder's member socket when its policy enters lease mode. The
// binding becomes lease-gated while its candidate holds the lease and serves
// (holder_endpoint READY, or UNKNOWN from a relay not yet carrying the
// endpoint lease-bound): the socket keeps listening and a connection
// established before the flip keeps working.
func TestHolderSocketSurvivesItsPolicyEnteringLeaseMode(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		defer connection.Close()
		buffer := make([]byte, 64)
		for {
			n, err := connection.Read(buffer)
			if err != nil {
				return
			}
			if _, err := connection.Write(buffer[:n]); err != nil {
				return
			}
		}
	})
	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), manager, nil)
	defer coordinator.close()
	statuses, err := manager.sync(availabilityMemberCommand("", ""))
	if err != nil || len(statuses) != 1 {
		t.Fatalf("sync: statuses=%#v err=%v", statuses, err)
	}
	socketPath := statuses[0].SocketPath
	live, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	echo := func(step string) {
		t.Helper()
		_ = live.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := live.Write([]byte(step)); err != nil {
			t.Fatalf("%s: write on the live connection: %v", step, err)
		}
		buffer := make([]byte, len(step))
		if _, err := io.ReadFull(live, buffer); err != nil || string(buffer) != step {
			t.Fatalf("%s: the live connection broke: %q %v", step, buffer, err)
		}
	}
	echo("bootstrapping")

	for name, readiness := range map[string]relayv1.LeaseHolderEndpoint{
		"relay carries the endpoint lease-bound": relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY,
		"relay not yet updated":                  relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN,
	} {
		coordinator.gates = leasegate.NewTracker()
		coordinator.gates.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
			PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 20000, HolderEndpoint: readiness,
		}}}, time.Now())
		if _, err := manager.sync(availabilityMemberCommand("policy-1", "node-a")); err != nil {
			t.Fatal(err)
		}
		coordinator.reconcileSockets()
		echo(name)
		fresh, err := net.DialTimeout("unix", socketPath, time.Second)
		if err != nil {
			t.Fatalf("%s: the holder's socket stopped listening at the flip: %v", name, err)
		}
		_ = fresh.Close()
		if _, err := manager.sync(availabilityMemberCommand("", "")); err != nil {
			t.Fatal(err)
		}
		coordinator.reconcileSockets()
		echo(name + ", back to legacy")
	}
}

// M-2: before nginx loads a config, every Secure Link socket it references that this daemon provides listens: a
// plain binding whose socket file went missing is re-created first. A member socket the lease gate keeps closed stays
// closed (nginx refuses it and moves on), and a socket without a binding is reported, never invented.
func TestReferencedSecureLinkSocketsListenBeforeAConfigLoads(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	command := plainAndMemberCommand()
	statuses, err := manager.sync(command)
	if err != nil || len(statuses) != 2 {
		t.Fatalf("sync: %#v %v", statuses, err)
	}
	paths := map[string]string{}
	for _, status := range statuses {
		paths[status.LinkID] = status.SocketPath
	}
	if err := os.Remove(paths[testSecureLinkID]); err != nil {
		t.Fatal(err)
	}
	unknown := manager.socketDir + "/33333333-3333-4333-8333-333333333333.sock"
	config := "upstream u {\n    server unix:" + paths[testSecureLinkID] + " max_fails=1 fail_timeout=1s;\n" +
		"    server unix:" + paths[testMemberLinkID] + ";\n    server unix:" + unknown + ";\n" +
		"    server unix:/run/elsewhere/x.sock;\n}\n"

	absent := manager.ensureReferencedListeners(config)

	if len(absent) != 2 || absent[0] != paths[testMemberLinkID] || absent[1] != unknown {
		t.Fatalf("absent = %v, want the closed member and the unknown socket", absent)
	}
	connection, err := net.DialTimeout("unix", paths[testSecureLinkID], time.Second)
	if err != nil {
		t.Fatalf("the plain socket was not re-created before the config loads: %v", err)
	}
	_ = connection.Close()
	if _, err := net.DialTimeout("unix", paths[testMemberLinkID], time.Second); !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("the closed member socket = %v, want a refusal", err)
	}
	if _, err := os.Stat(unknown); !os.IsNotExist(err) {
		t.Fatalf("a socket without a binding was created: %v", err)
	}
}
