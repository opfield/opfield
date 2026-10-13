//go:build chhacontainer

package chha

// Container test of ClickHouse sets of 4 and 5 members (decision 14): the
// first three members' embedded Keepers vote, the 4th and 5th are learners,
// addressed as Opfield addresses them (clickhouse-keeper-addressing.ts: voter
// server id member index + 1, learner server id 201 + member index, raft port
// 39500 + server id, interserver port 39000 + member index, one loopback host
// per set from sha256(set id)). Each member runs the real engine (New) over a
// real clickhouse-server container; the member mesh is replaced by direct
// dials (ctHarness.bridge) and the member runtime (memberha.Manager) by the
// test: it samples every running member's status every second as the runtime
// does, and starts, kills and promotes members itself. Run as root on a host
// with a private Docker engine:
//
//	CHHA_DOCKER_HOST=unix:///run/x/docker.sock CHHA_DOCKER=/root/x/docker \
//	  go test -tags chhacontainer -run '^TestContainerLearnerSets$' -v ./internal/chha/
//
// For each size it checks: every member joins the Replicated database and
// has every quorum insert, the Keeper cluster configuration lists voters
// 1,2,3 and the learners, no learner ever leads (sampled throughout), a voter
// member's loss keeps the Keeper quorum and inserts going, the holder's loss
// fails over to the member the engine names (ReleaseTarget) once it is
// eligible, and every member that returns catches up.

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

const (
	testMemberD = "77777777-7777-4777-8777-777777777777"
	testMemberE = "88888888-8888-4888-8888-888888888888"
	// setMemberMemory keeps five members inside the build host's memory.
	setMemberMemory = "1200m"
)

var setMemberIDs = []string{testMemberA, testMemberB, testMemberC, testMemberD, testMemberE}

func setMemberName(index int) string { return fmt.Sprintf("ch%d", index+1) }

// setLoopbackHost is Opfield's keeperLoopbackHost.
func setLoopbackHost(setID string) string {
	digest := sha256.Sum256([]byte(setID))
	a, b := digest[0], digest[1]
	if a == 0 && b == 0 {
		b = 1
	}
	return fmt.Sprintf("127.%d.%d.1", a, b)
}

// setKeeperServerID is Opfield's memberKeeperServerId: the 4th and 5th
// members of an automatic set are learners.
func setKeeperServerID(index int) uint32 {
	if index >= 3 {
		return 201 + uint32(index)
	}
	return uint32(index) + 1
}

// setEngineConfig is the engine configuration Opfield computes for member self
// of an n-member automatic set without a witness.
func setEngineConfig(n, self int) EngineConfig {
	ec := EngineConfig{Version: 1, LoopbackHost: setLoopbackHost(ctSetID), KeeperServerID: setKeeperServerID(self),
		Databases: []string{"app"}}
	for i := 0; i < n; i++ {
		role := RoleVoter
		if i >= 3 {
			role = RoleLearner
		}
		id := setKeeperServerID(i)
		ec.KeeperServers = append(ec.KeeperServers, KeeperServer{ID: id, Port: 39500 + id, MemberID: setMemberIDs[i], Role: role})
		ec.Interserver = append(ec.Interserver, InterserverPeer{MemberID: setMemberIDs[i], Port: 39000 + uint32(i)})
	}
	return ec
}

func setMemberConfig(n, self int) memberha.Config {
	config := memberha.Config{SetID: ctSetID, MemberID: setMemberIDs[self], NodeID: "node-" + setMemberIDs[self][:1], Engine: Engine,
		OwnerKind: "managed_database", OwnerID: "db1", Mode: memberha.ModeAutomatic, LeasePolicyID: testPolicy,
		Durability: "synchronous", SyncDegradeAfterSeconds: 10, ConfigRevision: 1}
	for i := 0; i < n; i++ {
		config.Members = append(config.Members, memberha.Peer{MemberID: setMemberIDs[i], NodeID: "node-" + setMemberIDs[i][:1],
			MemberIndex: uint32(i)})
	}
	config.EngineConfig = mustJSON(setEngineConfig(n, self))
	return config
}

// setSampler stands in for the member runtime's status sampling (every engine
// pass of memberha.Manager calls Status) and records every Keeper mode a
// learner reported.
type setSampler struct {
	mu            sync.Mutex
	learnerModes  map[string]map[string]int
	learnerLeader []string
	stop          chan struct{}
	done          sync.WaitGroup
}

func (s *setSampler) run(t *testing.T, name string, e *engine, learner bool) {
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		for {
			select {
			case <-s.stop:
				return
			case <-time.After(time.Second):
			}
			if state, _, err := e.rt.Container(context.Background()); err != nil || !state.Running {
				continue
			}
			mode := status(t, e).Position[posKeeper]
			if !learner {
				continue
			}
			s.mu.Lock()
			if s.learnerModes[name] == nil {
				s.learnerModes[name] = map[string]int{}
			}
			s.learnerModes[name][mode]++
			if mode == "leader" {
				s.learnerLeader = append(s.learnerLeader, fmt.Sprintf("%s at %s", name, time.Now().UTC().Format("15:04:05")))
			}
			s.mu.Unlock()
		}
	}()
}

func (s *setSampler) check(t *testing.T, when string) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.learnerLeader) > 0 {
		t.Fatalf("%s: a learner Keeper led: %v", when, s.learnerLeader)
	}
}

func TestContainerLearnerSets(t *testing.T) {
	host := os.Getenv("CHHA_DOCKER_HOST")
	if host == "" {
		t.Skip("CHHA_DOCKER_HOST is not set")
	}
	for i := 2; i < len(setMemberIDs); i++ {
		ctIPs[setMemberName(i)] = fmt.Sprintf("10.233.60.%d", 13+i)
	}
	docker, image := envOr("CHHA_DOCKER", "docker"), envOr("CHHA_IMAGE", ctImage)
	// One pull for both sizes.
	puller := &ctHarness{t: t, docker: docker, host: host}
	puller.cleanup()
	puller.must("pull", "-q", image)
	for _, n := range []int{4, 5} {
		t.Run(fmt.Sprintf("%dMembers", n), func(t *testing.T) {
			started := time.Now()
			runLearnerSet(t, host, docker, image, n)
			t.Logf("%d-member set done in %s", n, time.Since(started).Round(time.Second))
		})
	}
}

func runLearnerSet(t *testing.T, host, docker, image string, n int) {
	h := &ctHarness{t: t, docker: docker, host: host, image: image, memory: setMemberMemory, engines: map[string]*engine{},
		work: t.TempDir(), logger: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})),
		configs: map[string]memberha.Config{}, targets: map[string]string{}}
	_ = os.Chmod(h.work, 0o777)
	ec := setEngineConfig(n, 0)
	names := make([]string, n)
	for i := 0; i < n; i++ {
		names[i] = setMemberName(i)
		server, _ := ec.Server(setKeeperServerID(i))
		h.targets[server.Alias()] = fmt.Sprintf("%s:%d", ctIPs[names[i]], server.Port)
		h.targets["member-"+setMemberIDs[i]+"-ch-interserver"] = fmt.Sprintf("%s:%d", ctIPs[names[i]], 39000+i)
	}
	ctDiagnose = func() {
		for _, name := range names {
			t.Logf("--- %s srvr:\n%s", name, fourLetter(ctIPs[name]+":9181", "srvr"))
			out, _ := h.run("exec", name, "bash", "-c", "grep -iE 'raft|keeper' /var/log/clickhouse-server/clickhouse-server.err.log | tail -15")
			t.Logf("--- %s keeper errors:\n%s", name, out)
		}
	}
	defer func() { ctDiagnose = nil }()
	h.cleanup()
	sampler := &setSampler{learnerModes: map[string]map[string]int{}, stop: make(chan struct{})}
	t.Cleanup(func() {
		close(sampler.stop)
		sampler.done.Wait()
		h.mu.Lock()
		h.configs = map[string]memberha.Config{}
		h.mu.Unlock()
		if t.Failed() {
			for _, name := range names {
				out, _ := h.run("logs", "--tail", "30", name)
				t.Logf("--- %s logs:\n%s", name, out)
			}
			if os.Getenv("CHHA_KEEP") != "" {
				return
			}
		}
		h.cleanup()
	})
	h.must("network", "create", "--subnet", ctSubnet, ctNetwork)
	ctx := context.Background()

	engines := make([]*engine, n)
	runtimes := make([]*ctRuntime, n)
	for i := 0; i < n; i++ {
		h.mu.Lock()
		h.configs[names[i]] = setMemberConfig(n, i)
		h.mu.Unlock()
		runtimes[i] = h.createMember(names[i])
		config, _ := runtimes[i].Config()
		opened, err := New(config, runtimes[i])
		if err != nil {
			t.Fatal(err)
		}
		engines[i] = opened.(*engine)
		h.mu.Lock()
		h.engines[names[i]] = engines[i]
		h.mu.Unlock()
	}
	for i := 0; i < n; i++ {
		if err := engines[i].PrepareStandby(ctx); err != nil {
			t.Fatal(err)
		}
		h.createContainer(runtimes[i])
		if err := engines[i].Start(ctx); err != nil {
			t.Fatal(err)
		}
		sampler.run(t, names[i], engines[i], i >= 3)
	}
	learnerIDs := []string{}
	for i := 3; i < n; i++ {
		learnerIDs = append(learnerIDs, fmt.Sprint(setKeeperServerID(i)))
	}
	sort.Strings(learnerIDs)
	wantLearners := strings.Join(learnerIDs, ",")
	modes := func(of []int) (string, bool, bool) {
		parts, serving, voterLeads := []string{}, true, false
		for _, i := range of {
			mode := status(t, engines[i]).Position[posKeeper]
			parts = append(parts, names[i]+"="+mode)
			if i >= 3 && mode == "leader" {
				sampler.mu.Lock()
				sampler.learnerLeader = append(sampler.learnerLeader, fmt.Sprintf("%s at %s", names[i], time.Now().UTC().Format("15:04:05")))
				sampler.mu.Unlock()
			}
			serving = serving && keeperServing(mode)
			voterLeads = voterLeads || (i < 3 && mode == "leader")
		}
		return strings.Join(parts, " "), serving, voterLeads
	}
	all := make([]int, n)
	for i := range all {
		all[i] = i
	}
	without := func(skip ...int) []int {
		out := []int{}
		for _, i := range all {
			gone := false
			for _, s := range skip {
				gone = gone || i == s
			}
			if !gone {
				out = append(out, i)
			}
		}
		return out
	}
	counts := func(of []int) (string, bool) {
		parts, same, first := []string{}, true, -1
		for _, i := range of {
			c, err := count(runtimes[i])
			if err != nil {
				return fmt.Sprintf("%s: %v", names[i], err), false
			}
			parts = append(parts, fmt.Sprintf("%s=%d", names[i], c))
			if first < 0 {
				first = c
			}
			same = same && c == first
		}
		return strings.Join(parts, " "), same
	}

	// 1. Every Keeper serves; a voter leads.
	waitFor(t, "Keeper quorum on every member, a voter leads", 3*time.Minute, func() (bool, string) {
		detail, serving, voterLeads := modes(all)
		return serving && voterLeads, detail
	})
	sampler.check(t, "start")

	// 2. ch1 is the holder; every member joins the Replicated database and
	// replicates the quorum inserts.
	healthy, _ := Value{Quorum: 2}.encode()
	if err := engines[0].Promote(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "Replicated database app on every member", 3*time.Minute, func() (bool, string) {
		parts, ok := []string{}, true
		for i := range all {
			found, err := engines[i].databaseEngines(ctx)
			parts = append(parts, fmt.Sprintf("%s=%s", names[i], found["app"]))
			ok = ok && err == nil && found["app"] == "Replicated"
		}
		return ok, strings.Join(parts, " ")
	})
	if _, err := runtimes[0].Query(ctx, "CREATE TABLE app.ledger (id UInt64) ORDER BY id"); err != nil {
		t.Fatal(err)
	}
	inserted := 0
	insert := func(on int, batches int, what string) {
		t.Helper()
		for b := 0; b < batches; b++ {
			inserted++
			if _, err := runtimes[on].Query(ctx, fmt.Sprintf("INSERT INTO app.ledger SELECT number + %d FROM numbers(100)", inserted*1000)); err != nil {
				t.Fatalf("%s: insert %d on %s: %v", what, b, names[on], err)
			}
		}
	}
	insert(0, 20, "healthy set")
	if out, err := runtimes[0].Query(ctx, "SELECT value FROM system.settings WHERE name = 'insert_quorum'"); err != nil || strings.TrimSpace(out) != "2" {
		t.Fatalf("holder insert quorum %q %v", out, err)
	}
	waitFor(t, "every member has every insert", 2*time.Minute, func() (bool, string) {
		detail, same := counts(all)
		return same, detail
	})

	// 3. The Keeper cluster configuration: voters 1,2,3 and the learners; each
	// learner sees itself as one.
	current, err := engines[0].keeperConfig(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if voterList(current) != "1,2,3" || idList(current, true) != wantLearners {
		t.Fatalf("holder's Keeper configuration: voters %q learners %q (want 1,2,3 and %s)", voterList(current), idList(current, true), wantLearners)
	}
	for i := 3; i < n; i++ {
		view, err := engines[i].keeperConfig(ctx)
		if err != nil {
			t.Fatalf("%s reads its Keeper configuration: %v", names[i], err)
		}
		if own, ok := view[setKeeperServerID(i)]; !ok || !own.learner || voterList(view) != "1,2,3" {
			t.Fatalf("%s's Keeper configuration %v", names[i], view)
		}
	}
	t.Logf("Keeper configuration: voters %s, learners %s", voterList(current), idList(current, true))

	// 4. A voter member (ch3) is lost: the two other voters keep the quorum and
	// the holder keeps inserting with quorum 2.
	lost := time.Now()
	if err := engines[2].Kill(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "inserts with voter ch3 down", time.Minute, func() (bool, string) {
		_, err := runtimes[0].Query(ctx, "INSERT INTO app.ledger SELECT number + 990000000 FROM numbers(1)")
		return err == nil, fmt.Sprint(err)
	})
	insert(0, 5, "voter ch3 down")
	t.Logf("inserts go on %.1fs after voter ch3 was lost", time.Since(lost).Seconds())
	waitFor(t, "the remaining members serve their Keeper", time.Minute, func() (bool, string) {
		detail, serving, voterLeads := modes(without(2))
		return serving && voterLeads, detail
	})
	sampler.check(t, "voter lost")

	// 5. ch3 returns and catches up.
	if err := engines[2].PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if err := engines[2].Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "ch3 back, every member caught up", 3*time.Minute, func() (bool, string) {
		detail, same := counts(all)
		_, serving, _ := modes([]int{2})
		return same && serving, detail
	})

	// 6. The holder (ch1, a voter) is lost: the engine names its release
	// target; it becomes eligible and takes over with every acknowledged row.
	before, _ := count(runtimes[0])
	target, ok := engines[0].ReleaseTarget(healthy)
	if !ok {
		t.Fatal("the holder names no release target")
	}
	next := -1
	for i, id := range setMemberIDs[:n] {
		if id == target {
			next = i
		}
	}
	if next <= 0 {
		t.Fatalf("release target %s is not another member", target)
	}
	if err := engines[0].Kill(ctx); err != nil {
		t.Fatal(err)
	}
	killed := time.Now()
	waitFor(t, names[next]+" eligible without the holder", 2*time.Minute, func() (bool, string) {
		s := status(t, engines[next])
		ok, reason := engines[next].Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: healthy, Holder: "node-1"}}, s)
		return ok, reason + " " + s.Position[posKeeper]
	})
	if err := engines[next].Promote(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	waitFor(t, names[next]+" takes inserts", 2*time.Minute, func() (bool, string) {
		_, err := runtimes[next].Query(ctx, "INSERT INTO app.ledger SELECT number + 991000000 FROM numbers(1)")
		return err == nil, fmt.Sprint(err)
	})
	t.Logf("%s writable %.1fs after the holder was lost", names[next], time.Since(killed).Seconds())
	if got, _ := count(runtimes[next]); got < before {
		t.Fatalf("rows lost on the new holder: %d < %d", got, before)
	}
	insert(next, 5, "after the failover")
	waitFor(t, "a voter leads without ch1", time.Minute, func() (bool, string) {
		detail, serving, voterLeads := modes(without(0))
		return serving && voterLeads, detail
	})
	sampler.check(t, "holder lost")

	// 7. The old holder returns as a copy and catches up.
	if err := engines[0].PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if err := engines[0].Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "ch1 back as a copy, every member caught up", 3*time.Minute, func() (bool, string) {
		detail, same := counts(all)
		s := status(t, engines[0])
		return same && !s.Writable && keeperServing(s.Position[posKeeper]), detail
	})
	current, err = engines[next].keeperConfig(ctx)
	if err != nil || voterList(current) != "1,2,3" || idList(current, true) != wantLearners {
		t.Fatalf("Keeper configuration after the failover: %v %v", current, err)
	}
	sampler.check(t, "end")
	sampler.mu.Lock()
	t.Logf("learner Keeper modes sampled: %v", sampler.learnerModes)
	sampler.mu.Unlock()
}
