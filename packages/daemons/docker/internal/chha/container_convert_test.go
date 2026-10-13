//go:build chhacontainer

package chha

// Container test of turning a single ClickHouse node into a pair with a
// Keeper witness (the convert path of a create operation, rc.1 stand B
// blocker): the origin restarts with its Keeper as the only voter (bootstrap
// voters) and holds the set; then the witness starts and the copy is created
// the way the docker daemon creates it for Opfield's create command: its
// files staged (stageClickHouseAvailability), its container started directly
// (no PrepareStandby: the member runtime only takes it over once it exists),
// and the command waits up to managedDatabaseReadinessTimeout for the
// engine to answer. Run as in container_test.go, with the image of the
// version under test:
//
//	CHHA_DOCKER_HOST=unix:///run/x/docker.sock CHHA_DOCKER=/root/x/docker CHHA_IMAGE=<clickhouse-server 26.7> \
//	  go test -tags chhacontainer -run '^TestContainerConvertedPairJoins$' -v ./internal/chha/
//
// It checks: the holder adds the witness and the copy to its Keeper (reconfig
// add), the copy joins the Replicated database and answers the daemon's
// readiness query inside the readiness window, the pair fails over to the
// copy, and the copy's Keeper narrows back to a single voter (disable).

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// ctReadinessWindow is the docker daemon's managedDatabaseReadinessTimeout.
const ctReadinessWindow = 90 * time.Second

// stageLikeDaemon writes a member's files the way the docker daemon stages
// them before it creates the container (stageClickHouseAvailability).
func stageLikeDaemon(t *testing.T, rt *ctRuntime, config memberha.Config, ec EngineConfig) {
	t.Helper()
	hash, _ := rt.InternalPasswordSHA256()
	files := StageMemberFiles(config, ec, !rt.Exists("coordination/log"), false, 10*1000, hash)
	for name, data := range files {
		if err := rt.WriteFile(name, data); err != nil {
			t.Fatal(err)
		}
	}
}

// readiness is the daemon's readiness query of a set member.
func readiness(rt *ctRuntime) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+ctIPs[rt.name]+":8123/", strings.NewReader(MemberReadinessQuery))
	request.Header.Set("X-ClickHouse-User", InternalUser)
	request.Header.Set("X-ClickHouse-Key", rt.password())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func TestContainerConvertedPairJoins(t *testing.T) {
	host := os.Getenv("CHHA_DOCKER_HOST")
	if host == "" {
		t.Skip("CHHA_DOCKER_HOST is not set")
	}
	h := &ctHarness{t: t, docker: envOr("CHHA_DOCKER", "docker"), host: host, image: envOr("CHHA_IMAGE", ctImage),
		keeperImage: envOr("CHHA_KEEPER_IMAGE", ctKeeperImage), engines: map[string]*engine{},
		work: t.TempDir(), logger: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})),
		configs: map[string]memberha.Config{}, targets: map[string]string{
			"member-" + testMemberA + "-ch-keeper":      ctIPs["ch1"] + ":39501",
			"member-" + testMemberB + "-ch-keeper":      ctIPs["ch2"] + ":39502",
			"member-" + testMemberA + "-ch-interserver": ctIPs["ch1"] + ":39000",
			"member-" + testMemberB + "-ch-interserver": ctIPs["ch2"] + ":39001",
			"witness-" + testWitness + "-ch-keeper":     ctIPs["kw"] + ":39433",
		}}
	_ = os.Chmod(h.work, 0o777)
	ctDiagnose = func() {
		for _, name := range []string{"ch1", "ch2"} {
			t.Logf("--- %s srvr:\n%s", name, fourLetter(ctIPs[name]+":9181", "srvr"))
			out, _ := h.run("logs", "--tail", "25", name)
			t.Logf("--- %s log:\n%s", name, out)
		}
		t.Logf("--- kw srvr:\n%s", fourLetter(ctIPs["kw"]+":39432", "srvr"))
		out, _ := h.run("logs", "--tail", "20", "kw")
		t.Logf("--- kw log:\n%s", out)
	}
	defer func() { ctDiagnose = nil }()
	h.cleanup()
	t.Cleanup(func() {
		h.mu.Lock()
		h.configs = map[string]memberha.Config{}
		h.mu.Unlock()
		if t.Failed() && os.Getenv("CHHA_KEEP") != "" {
			return
		}
		h.cleanup()
	})
	h.must("pull", "-q", h.image)
	h.must("pull", "-q", h.keeperImage)
	h.must("network", "create", "--subnet", ctSubnet, ctNetwork)
	ctx := context.Background()

	witness := []KeeperServer{{ID: 1001, Port: 39433, WitnessID: testWitness, Role: RoleVoter}}
	converting := func(self uint32) EngineConfig {
		ec := ctEngineConfig(self, witness)
		ec.BootstrapVoters = []uint32{1}
		return ec
	}
	h.setConfig("ch1", converting(1), 1)
	h.setConfig("ch2", converting(2), 1)
	open := func(name string, rt *ctRuntime) *engine {
		config, _ := rt.Config()
		opened, err := New(config, rt)
		if err != nil {
			t.Fatal(err)
		}
		e := opened.(*engine)
		h.mu.Lock()
		h.engines[name] = e
		h.mu.Unlock()
		return e
	}

	// 1. The origin restarts with its Keeper as the only voter and holds the set alone.
	rt1 := h.createMember("ch1")
	e1 := open("ch1", rt1)
	if err := e1.PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	h.createContainer(rt1)
	if err := e1.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the origin's Keeper serves alone", 2*time.Minute, func() (bool, string) {
		s := status(t, e1)
		return keeperServing(s.Position[posKeeper]), s.Position[posKeeper] + " " + s.Detail
	})
	alone, _ := Value{Quorum: 1, Degraded: true}.encode()
	if err := e1.Promote(ctx, alone); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "Replicated database app on the origin", 2*time.Minute, func() (bool, string) {
		engines, err := e1.databaseEngines(ctx)
		return err == nil && engines["app"] == "Replicated", fmt.Sprint(engines["app"], err)
	})
	if _, err := rt1.Query(ctx, "CREATE TABLE app.ledger (id UInt64) ORDER BY id"); err != nil {
		t.Fatal(err)
	}
	if _, err := rt1.Query(ctx, "INSERT INTO app.ledger SELECT number FROM numbers(1000)"); err != nil {
		t.Fatal(err)
	}

	// 2. The witness starts; the copy is created like the daemon's create command does it.
	witnessForwarders := h.startWitness("kw", 1001, 39433)
	defer witnessForwarders.close()
	rt2 := h.createMember("ch2")
	e2 := open("ch2", rt2)
	config2, _ := rt2.Config()
	stageLikeDaemon(t, rt2, config2, converting(2))
	h.createContainer(rt2)
	h.must("start", "ch2")
	created := time.Now()

	// 3. Inside the readiness window: the holder's Keeper lists the copy and the witness, the copy joined
	// app and answers the readiness query.
	waitFor(t, "the copy and the witness in the holder's Keeper, the copy ready", ctReadinessWindow, func() (bool, string) {
		current, err := e1.keeperConfig(ctx)
		if err != nil {
			return false, err.Error()
		}
		ready := readiness(rt2)
		// The member runtime samples every member it runs (memberha observe).
		_ = status(t, e2)
		engines, _ := e2.databaseEngines(ctx)
		return voterList(current) == "1,2,1001" && ready == nil && engines["app"] == "Replicated",
			fmt.Sprintf("voters %s ready %v app %q", voterList(current), ready, engines["app"])
	})
	t.Logf("copy ready %.1fs after its container started", time.Since(created).Seconds())
	waitFor(t, "the copy caught up", 2*time.Minute, func() (bool, string) {
		n, err := count(rt2)
		return err == nil && n == 1000, fmt.Sprint(n, err)
	})

	// 4. The pair's configuration (convert finished) and a failover to the copy: its Keeper and the
	// witness keep the quorum.
	h.setConfig("ch1", ctEngineConfig(1, witness), 2)
	h.setConfig("ch2", ctEngineConfig(2, witness), 2)
	healthy, _ := Value{Quorum: 2}.encode()
	if err := e1.Kill(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e2.Promote(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the copy holds the set writable without the origin", 2*time.Minute, func() (bool, string) {
		s := status(t, e2)
		return s.Writable && keeperServing(s.Position[posKeeper]), fmt.Sprint(s.Position)
	})
	degraded, _ := Value{Quorum: 1, Degraded: true}.encode()
	if err := e2.Promote(ctx, degraded); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "insert on the new holder", time.Minute, func() (bool, string) {
		_, err := rt2.Query(ctx, "INSERT INTO app.ledger SELECT number + 5000 FROM numbers(10)")
		return err == nil, fmt.Sprint(err)
	})

	// 5. Disable keeping the copy while the witness is gone too (its Keeper has no quorum and cannot
	// reconfigure): the lift restarts it as a single node that is its Keeper's only voter.
	h.must("kill", "kw")
	witnessForwarders.close()
	waitFor(t, "the copy's Keeper lost its quorum", time.Minute, func() (bool, string) {
		s := status(t, e2)
		return !keeperServing(s.Position[posKeeper]), s.Position[posKeeper]
	})
	standalone := ctEngineConfig(2, nil)
	standalone.KeeperServers = standalone.KeeperServers[1:]
	h.setConfig("ch2", standalone, 3)
	config3, _ := rt2.Config()
	hash, _ := rt2.InternalPasswordSHA256()
	for name, data := range StageMemberFiles(config3, standalone, false, true, 10000, hash) {
		if err := rt2.WriteFile(name, data); err != nil {
			t.Fatal(err)
		}
	}
	h.must("restart", "ch2")
	waitFor(t, "the lifted single node inserts", 2*time.Minute, func() (bool, string) {
		_, err := rt2.Query(ctx, "INSERT INTO app.ledger SELECT number + 9000 FROM numbers(10)")
		return err == nil, fmt.Sprint(err)
	})
	n, err := count(rt2)
	if err != nil || n < 1020 {
		t.Fatalf("rows after the lift: %d %v", n, err)
	}
}
