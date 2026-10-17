package chha

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/witnessactivation"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

func newTestEngine(t *testing.T, rt *fakeRuntime) *engine {
	t.Helper()
	opened, err := New(rt.config, rt)
	if err != nil {
		t.Fatal(err)
	}
	e := opened.(*engine)
	t.Cleanup(func() {
		rt.mu.Lock()
		rt.known = false
		rt.mu.Unlock()
	})
	return e
}

func statusRow(readonly string, tables, minActive, quorum int) string {
	return strings.Join([]string{readonly, itoa(tables), "0", "0", itoa(minActive), "0", itoa(quorum), "10737418240", "21474836480"}, "\t")
}

func itoa(v int) string { return strconv.Itoa(v) }

// Standby at rest: the client profile is made read-only only while the
// container is stopped; Promote makes it writable and waits for the engine.
func TestStandbyAtRestAndPromote(t *testing.T) {
	rt := newFakeRuntime(testConfig(memberha.ModeAutomatic, pairEngineConfig(), testMemberA, testMemberB))
	writable := false
	rt.answers = func(query string) (string, error) {
		if query == statusQuery {
			if writable {
				return statusRow("0", 0, 0, 2), nil
			}
			return statusRow("1", 0, 0, 1), nil
		}
		if query == "SYSTEM RELOAD CONFIG" {
			writable = strings.Contains(rt.file(RoleConfigFile), "<readonly>0</readonly>")
		}
		return "", nil
	}
	e := newTestEngine(t, rt)
	ctx := context.Background()
	if err := e.PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rt.file(RoleConfigFile), "<readonly>1</readonly>") || rt.file(ServerConfigFile) == "" ||
		!strings.Contains(rt.file(UsersConfigFile), "<insert_quorum>2</insert_quorum>") {
		t.Fatalf("standby at rest files: role=%q users=%q", rt.file(RoleConfigFile), rt.file(UsersConfigFile))
	}
	if err := e.Start(ctx); err != nil {
		t.Fatal(err)
	}
	certified, _ := Value{Quorum: 2}.encode()
	if err := e.Promote(ctx, certified); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rt.file(RoleConfigFile), "<readonly>0</readonly>") {
		t.Fatal("promote did not make the client profile writable")
	}
	// After a promotion the framework writes standby at rest for the next
	// start; the running holder must stay writable.
	if err := e.PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rt.file(RoleConfigFile), "<readonly>0</readonly>") {
		t.Fatal("PrepareStandby on a running holder made it read-only")
	}
	// The next start (after a stop) comes up read-only.
	_ = e.Kill(ctx)
	if err := e.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rt.file(RoleConfigFile), "<readonly>1</readonly>") {
		t.Fatal("a start must come up read-only")
	}
	// A degraded certified state promotes with quorum 1.
	writable = false
	degraded, _ := Value{Quorum: 1, Degraded: true}.encode()
	if err := e.Promote(ctx, degraded); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rt.file(UsersConfigFile), "<insert_quorum>1</insert_quorum>") {
		t.Fatal("degraded promotion must run quorum 1")
	}
}

func TestEligibleAndValuesThroughStatus(t *testing.T) {
	ec := pairEngineConfig()
	ec.KeeperServerID = 2
	rt := newFakeRuntime(testConfig(memberha.ModeAutomatic, ec, testMemberB, testMemberA))
	e := newTestEngine(t, rt)
	row, _ := parseStatusRow(statusRow("1", 2, 2, 1))
	status := toStatus(row, "follower", false, "", nil)
	healthy, _ := Value{Quorum: 2}.encode()
	if ok, reason := e.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: healthy, Holder: "node-1"}}, status); !ok {
		t.Fatalf("healthy copy not eligible: %s", reason)
	}
	degraded, _ := Value{Quorum: 1, Degraded: true}.encode()
	if ok, _ := e.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: degraded, Holder: "node-1"}}, status); ok {
		t.Fatal("a copy of a degraded set is eligible")
	}
	if ok, _ := e.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: degraded, Holder: "node-2"}}, status); !ok {
		t.Fatal("the member that certified the degraded state is not eligible")
	}
	if target, ok := e.ReleaseTarget(healthy); !ok || target != testMemberA {
		t.Fatalf("release target %q %v", target, ok)
	}
	if _, ok := e.ReleaseTarget(degraded); ok {
		t.Fatal("a degraded set has no release target")
	}
	// Bootstrap of a convert: the copy has not joined, so degraded.
	single, _ := parseStatusRow(statusRow("0", 2, 1, 1))
	value, err := e.BootstrapValue(toStatus(single, "leader", false, "", nil))
	if err != nil {
		t.Fatal(err)
	}
	if decoded, _ := DecodeValue(value); !decoded.Degraded || decoded.Quorum != 1 {
		t.Fatalf("bootstrap value %+v", decoded)
	}
}

// Opfield down and the active witness dead for 2 minutes: the holder signs an
// activation, sends it over the standby's witness route, then adds the
// standby and removes the dead witness.
func TestHolderActivatesStandbyWhileOpfieldIsDown(t *testing.T) {
	rt := newFakeRuntime(testConfig(memberha.ModeAutomatic, pairEngineConfig(), testMemberA, testMemberB))
	rt.opfield = false
	received := make(chan witnessactivation.Request, 1)
	rt.bridge = func(connection net.Conn, alias string) error {
		defer connection.Close()
		if alias != "witness-"+testStandby+"-ch-keeper" {
			return nil
		}
		var request witnessactivation.Request
		if err := witnessactivation.Read(connection, &request); err != nil {
			return err
		}
		received <- request
		return witnessactivation.Write(connection, witnessactivation.Response{OK: true})
	}
	e := newTestEngine(t, rt)
	snap := e.snapshot.Load()
	ctx := context.Background()
	e.mu.Lock()
	e.lastSample.keeperQuorum = true
	e.opfieldDown = time.Second
	e.mu.Unlock()
	current := map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b"}, 101: {endpoint: "w"}}
	start := 10 * time.Minute
	e.holderKeeper(ctx, snap, current, start)
	if len(received) != 0 {
		t.Fatal("activated before the witness was dead for 2 minutes")
	}
	e.holderKeeper(ctx, snap, current, start+witnessDeadFor)
	select {
	case request := <-received:
		if request.WitnessID != testStandby || request.LeasePolicyID != testPolicy || request.SetID != testSet ||
			string(request.Signature) != "sig:"+witnessactivation.Domain {
			t.Fatalf("activation request %+v", request)
		}
	default:
		t.Fatal("no activation sent")
	}
	if rt.file(activationFile) == "" {
		t.Fatal("activation not persisted")
	}
	// The standby is reachable now: it is added.
	rt.probeOK["witness-"+testStandby+"-ch-keeper"] = true
	e.holderKeeper(ctx, snap, current, start+witnessDeadFor+time.Second)
	if len(rt.keeper) == 0 || rt.keeper[len(rt.keeper)-1] != "reconfig add 'server.102=127.12.34.1:39437;participant;1'" {
		t.Fatalf("keeper commands %v", rt.keeper)
	}
	current[102] = keeperEntry{endpoint: "w2"}
	e.mu.Lock()
	for id := range current {
		e.inConfig[id] = start
	}
	e.mu.Unlock()
	e.holderKeeper(ctx, snap, current, start+witnessDeadFor+time.Minute)
	if rt.keeper[len(rt.keeper)-1] != "reconfig remove '101'" {
		t.Fatalf("keeper commands %v", rt.keeper)
	}
	// Opfield's configuration adopts the activation: the record is cleared.
	ec := pairEngineConfig()
	ec.KeeperServers[2].Role, ec.KeeperServers[3].Role = RoleLeaving, RoleVoter
	rt.config.EngineConfig = mustJSON(ec)
	rt.config.ConfigRevision++
	snap, _ = e.refresh()
	delete(current, 101)
	e.holderKeeper(ctx, snap, current, start+witnessDeadFor+2*time.Minute)
	if rt.file(activationFile) != "" {
		t.Fatal("adopted activation not cleared")
	}
}

func TestForwardersAndPeers(t *testing.T) {
	rt := newFakeRuntime(testConfig(memberha.ModeAutomatic, pairEngineConfig(), testMemberA, testMemberB))
	rt.running = true
	e := newTestEngine(t, rt)
	desired := desiredForwards(testMemberA, e.snapshot.Load().ec)
	want := map[string]string{
		"127.12.34.1:39502": "member-" + testMemberB + "-ch-keeper",
		"127.12.34.1:39433": "witness-" + testWitness + "-ch-keeper",
		"127.12.34.1:39437": "witness-" + testStandby + "-ch-keeper",
		"127.12.34.1:39002": "member-" + testMemberB + "-ch-interserver",
	}
	if len(desired) != len(want) {
		t.Fatalf("forwards %v", desired)
	}
	for address, alias := range want {
		if desired[address] != alias {
			t.Fatalf("forward %s -> %q, want %q", address, desired[address], alias)
		}
	}
	if failed := e.fw.ensure("c1", 1, desired); len(failed) != 0 || len(e.fw.addresses()) != 4 {
		t.Fatalf("ensure: failed %v open %v", failed, e.fw.addresses())
	}
	// A new container is a new namespace: every listener is bound again.
	e.fw.ensure("c2", 2, desired)
	if len(rt.listening) != 8 {
		t.Fatalf("listen calls %d", len(rt.listening))
	}
	// So is the same container started again (a new process).
	e.fw.ensure("c2", 3, desired)
	if len(rt.listening) != 12 {
		t.Fatalf("listen calls after a restart %d", len(rt.listening))
	}
	e.fw.ensure("c2", 3, desired)
	if len(rt.listening) != 12 {
		t.Fatalf("a pass over the same process bound again: %d", len(rt.listening))
	}
	e.fw.close()
	if len(e.fw.addresses()) != 0 {
		t.Fatal("close kept listeners")
	}
	if _, err := e.DialPeer(context.Background(), "pg-repl"); err == nil {
		t.Fatal("unknown peer port accepted")
	}
}

func TestSwitchoverWaitsForTheSuccessor(t *testing.T) {
	rt := newFakeRuntime(testConfig(memberha.ModeAutomatic, pairEngineConfig(), testMemberA, testMemberB))
	rt.running = true
	pointer := "4"
	rt.answers = func(query string) (string, error) {
		switch {
		case strings.HasPrefix(query, "SELECT zookeeper_path"):
			return "/clickhouse/tables/u1/s1\t5\n", nil
		case strings.Contains(query, "log_pointer"):
			return pointer, nil
		case strings.Contains(query, "/queue"):
			return "0", nil
		}
		return "", nil
	}
	e := newTestEngine(t, rt)
	caught, err := e.caughtUp(context.Background(), testMemberB)
	if err != nil || caught {
		t.Fatalf("behind successor reported caught up: %v %v", caught, err)
	}
	pointer = "5"
	if err := e.Switchover(context.Background(), testMemberB); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rt.file(RoleConfigFile), "<readonly>1</readonly>") {
		t.Fatal("switchover must stop client writes")
	}
	rt.mu.Lock()
	queries := append([]string(nil), rt.queries...)
	rt.mu.Unlock()
	killed := false
	for _, query := range queries {
		if strings.HasPrefix(query, "KILL QUERY WHERE query_kind = 'Insert'") && strings.Contains(query, "'"+InternalUser+"'") {
			killed = true
		}
	}
	if !killed {
		t.Fatalf("switchover must end the running client inserts (no 30 s hang), queries %v", queries)
	}
}
