package chha

import (
	"testing"
	"time"
)

func never(uint32) bool { return false }

func TestParseKeeperConfig(t *testing.T) {
	current, err := parseKeeperConfig("server.1=127.12.34.1:39501;participant;1\nserver.2=127.12.34.1:39502;participant;1\nserver.101=127.12.34.1:39433;participant;0\n")
	if err != nil {
		t.Fatal(err)
	}
	if len(current) != 3 || current[101].endpoint != "127.12.34.1:39433" || voterList(current) != "1,2,101" {
		t.Fatalf("parsed %v", current)
	}
	if _, err := parseKeeperConfig(""); err == nil {
		t.Fatal("empty configuration accepted")
	}
	if _, err := parseKeeperConfig("server.x=a:1"); err == nil {
		t.Fatal("bad id accepted")
	}
}

// Re-placement order (P0-T02 item 7): add the new witness as soon as it is
// reachable, remove the dead one only after every desired voter settled.
func TestPlanKeeperReplacement(t *testing.T) {
	ec := pairEngineConfig()
	ec.KeeperServers[2].Role = RoleLeaving                                                          // dead witness 101
	ec.KeeperServers[3].Role = RoleVoter                                                            // new witness 102
	current := map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b"}, 101: {endpoint: "w"}} // 102 not added yet
	since := map[uint32]time.Duration{1: 0, 2: 0, 101: 0}
	reachable := map[uint32]bool{}
	probe := func(s KeeperServer) bool { return reachable[s.ID] }
	if _, ok := planKeeper(1, current, ec.Voters(), nil, probe, never, since, time.Minute); ok {
		t.Fatal("added an unreachable witness or removed before it joined")
	}
	reachable[102] = true
	action, ok := planKeeper(1, current, ec.Voters(), nil, probe, never, since, time.Minute)
	if !ok || action.add == nil || action.add.ID != 102 || action.command(ec) != "reconfig add 'server.102=127.12.34.1:39437;participant;1'" {
		t.Fatalf("expected add of 102, got %+v %v", action, ok)
	}
	current[102] = keeperEntry{endpoint: "w2"}
	since[102] = time.Minute
	if _, ok := planKeeper(1, current, ec.Voters(), nil, probe, never, since, time.Minute+5*time.Second); ok {
		t.Fatal("removed before the new witness settled")
	}
	action, ok = planKeeper(1, current, ec.Voters(), nil, probe, never, since, time.Minute+settleAfterAdd)
	if !ok || action.remove != 101 || action.command(ec) != "reconfig remove '101'" {
		t.Fatalf("expected remove of 101, got %+v %v", action, ok)
	}
	// Never removes itself, never empties the configuration.
	if _, ok := planKeeper(1, map[uint32]keeperEntry{1: {endpoint: "a"}}, nil, nil, probe, never, since, time.Hour); ok {
		t.Fatal("removed the last voter")
	}
}

func TestActivationDesiredVoters(t *testing.T) {
	ec := pairEngineConfig()
	act := &activation{StandbyID: 102, StandbyWitnessID: testStandby, ReplacesID: 101, ReplacesWitness: testWitness}
	voters := desiredVoters(ec, act)
	if len(voters) != 3 || voters[2].ID != 102 || voters[2].Role != RoleVoter {
		t.Fatalf("activation applied: %+v", voters)
	}
	if act.adopted(ec) {
		t.Fatal("Gateway has not adopted the activation yet")
	}
	ec.KeeperServers[2].Role = RoleLeaving
	if !act.adopted(ec) {
		t.Fatal("the replaced witness is no voter in Gateway's configuration any more")
	}
	if !activationDue(time.Minute, 3*time.Minute, true, nil, pairEngineConfig()) {
		t.Fatal("activation due")
	}
	for name, due := range map[string]bool{
		"gateway up":     activationDue(10*time.Second, 3*time.Minute, true, nil, pairEngineConfig()),
		"witness flaps":  activationDue(time.Minute, time.Minute, true, nil, pairEngineConfig()),
		"no quorum":      activationDue(time.Minute, 3*time.Minute, false, nil, pairEngineConfig()),
		"already active": activationDue(time.Minute, 3*time.Minute, true, act, pairEngineConfig()),
	} {
		if due {
			t.Errorf("%s: activation must not be due", name)
		}
	}
}

// Learners: added as learners; a learner that must become a voter is removed
// first (its member rejoins with a wiped state); a member that does not say
// it is joining is never added; the last voter is never removed.
func TestPlanKeeperLearners(t *testing.T) {
	ec := pairEngineConfig()
	ec.KeeperServers = append(ec.KeeperServers, KeeperServer{ID: 3, Port: 39503, MemberID: testMemberC, Role: RoleLearner})
	always := func(KeeperServer) bool { return true }
	current := map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b"}, 101: {endpoint: "w"}}
	notJoining := func(id uint32) bool { return id == 3 }
	if _, ok := planKeeper(1, current, ec.Voters(), ec.Learners(), always, notJoining, map[uint32]time.Duration{}, 0); ok {
		t.Fatal("added a member that does not wait to join")
	}
	action, ok := planKeeper(1, current, ec.Voters(), ec.Learners(), always, never, map[uint32]time.Duration{}, 0)
	if !ok || action.add == nil || action.command(ec) != "reconfig add 'server.3=127.12.34.1:39503;learner;1'" {
		t.Fatalf("learner add: %+v %v", action, ok)
	}
	// Promotion: 3 is a learner in the configuration but desired a voter.
	current[3] = keeperEntry{endpoint: "c", learner: true}
	ec.KeeperServers[4].Role = RoleVoter
	action, ok = planKeeper(1, current, ec.Voters(), ec.Learners(), always, never, map[uint32]time.Duration{}, 0)
	if !ok || action.remove != 3 {
		t.Fatalf("a learner to promote is removed first: %+v %v", action, ok)
	}
	if _, ok := planKeeper(1, map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b", learner: true}}, nil, nil,
		always, never, map[uint32]time.Duration{}, time.Hour); !ok {
		t.Fatal("a learner that is not desired is removed")
	}
	if _, ok := planKeeper(2, map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b", learner: true}}, nil, nil,
		always, never, map[uint32]time.Duration{}, time.Hour); ok {
		t.Fatal("the last voter was removed")
	}
}
