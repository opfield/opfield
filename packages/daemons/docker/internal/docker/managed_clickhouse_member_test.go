package docker

import (
	"encoding/json"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opfield/opfield/docker-daemon/internal/chha"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

const (
	chTestSet     = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	chTestMemberA = "11111111-1111-4111-8111-111111111111"
	chTestMemberB = "22222222-2222-4222-8222-222222222222"
	chTestWitness = "44444444-4444-4444-8444-444444444444"
)

func chAvailabilityCommand(t *testing.T, standalone bool) *clickHouseAvailabilityCommand {
	t.Helper()
	ec := chha.EngineConfig{Version: 1, LoopbackHost: "127.12.34.1", KeeperServerID: 1,
		KeeperServers: []chha.KeeperServer{
			{ID: 1, Port: 39501, MemberID: chTestMemberA, Role: chha.RoleVoter},
			{ID: 2, Port: 39502, MemberID: chTestMemberB, Role: chha.RoleVoter},
			{ID: 101, Port: 39433, WitnessID: chTestWitness, Role: chha.RoleVoter},
		},
		Interserver: []chha.InterserverPeer{{MemberID: chTestMemberA, Port: 39001}, {MemberID: chTestMemberB, Port: 39002}},
		Databases:   []string{"app"},
	}
	raw, err := json.Marshal(ec)
	if err != nil {
		t.Fatal(err)
	}
	return &clickHouseAvailabilityCommand{Standalone: standalone, SetID: chTestSet, MemberID: chTestMemberA, Mode: "automatic",
		Durability: "synchronous", SyncDegradeAfterSeconds: 10, EngineConfig: raw,
		Members: []memberha.Peer{{MemberID: chTestMemberA, NodeID: "node-a"}, {MemberID: chTestMemberB, NodeID: "node-b", MemberIndex: 1}}}
}

// A set member's files are staged before its container exists: standby at
// rest (client profile read-only), the internal user's secret root-only.
func TestStageClickHouseAvailabilityMember(t *testing.T) {
	mount := t.TempDir()
	record := managedDatabaseRecord{ID: "db1", Type: "clickhouse", MountPath: mount}
	input := managedDatabaseCommand{Type: "clickhouse", ClickhouseAvailability: chAvailabilityCommand(t, false)}
	if err := validateClickHouseAvailability(input, record.ID); err != nil {
		t.Fatal(err)
	}
	binds, err := stageClickHouseAvailability(&record, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(binds) != 3 || !strings.HasSuffix(binds[0], ":"+chha.ServerConfigTarget+":ro") {
		t.Fatalf("binds %v", binds)
	}
	role, _ := os.ReadFile(filepath.Join(mount, chha.RoleConfigFile))
	if !strings.Contains(string(role), "<readonly>1</readonly>") {
		t.Fatalf("a member's container must start read-only: %s", role)
	}
	server, _ := os.ReadFile(filepath.Join(mount, chha.ServerConfigFile))
	if !strings.Contains(string(server), "<server_id>1</server_id>") || !strings.Contains(string(server), "<interserver_http_port>39001</interserver_http_port>") {
		t.Fatalf("server config %s", server)
	}
	// A member created with an empty Keeper state tells the holder it waits to be added (the member runtime
	// takes it over only once its container exists), and its readiness never names a database it gets only
	// after it joined.
	if marker, err := os.ReadFile(filepath.Join(mount, legacycompat.KeeperFilePrefix+"-joining")); err != nil || strings.TrimSpace(string(marker)) != "joining" {
		t.Fatalf("joining marker %q %v", marker, err)
	}
	if command, _, _ := managedDatabaseReadinessCommand(managedDatabaseCommand{Type: "clickhouse", OwnerUsername: "o", DatabaseName: "app",
		ClickhouseAvailability: input.ClickhouseAvailability}); strings.Contains(strings.Join(command, " "), "--database") {
		t.Fatalf("member readiness names a database: %v", command)
	}
	if command, _, _ := managedDatabaseReadinessCommand(managedDatabaseCommand{Type: "clickhouse", OwnerUsername: "o", DatabaseName: "app"}); !strings.Contains(strings.Join(command, " "), "--database app") {
		t.Fatalf("single-node readiness: %v", command)
	}
	info, err := os.Stat(filepath.Join(mount, clickHouseInternalSecretFile))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("internal secret %v %v", info, err)
	}
	if !record.clickHouseAvailabilityMember() || !record.ClickhouseAvailabilityFiles || record.ClickhouseAvailabilityMemberID != chTestMemberA {
		t.Fatalf("record %+v", record)
	}
	// The same password every time (the users file and the daemon agree).
	first, _ := clickHouseInternalPasswordSHA256(mount)
	second, _ := clickHouseInternalPasswordSHA256(mount)
	if first != second || len(first) != 64 {
		t.Fatal("internal password hash is not stable")
	}
	// Turning availability off keeps the Replicated databases on a standalone
	// node: writable, run by the managed engine supervisor.
	standalone := managedDatabaseCommand{Type: "clickhouse", ClickhouseAvailability: chAvailabilityCommand(t, true)}
	if !clickHouseAvailabilityChanged(record, standalone) {
		t.Fatal("member → standalone must recreate the container")
	}
	if _, err := stageClickHouseAvailability(&record, standalone); err != nil {
		t.Fatal(err)
	}
	role, _ = os.ReadFile(filepath.Join(mount, chha.RoleConfigFile))
	if record.clickHouseAvailabilityMember() || !record.ClickhouseAvailabilityFiles || !strings.Contains(string(role), "<readonly>0</readonly>") {
		t.Fatalf("standalone record %+v role %s", record, role)
	}
	if clickHouseAvailabilityChanged(record, standalone) {
		t.Fatal("an unchanged standalone node is recreated")
	}
	if !clickHouseAvailabilityChanged(record, managedDatabaseCommand{Type: "clickhouse"}) {
		t.Fatal("dropping the availability files must recreate the container")
	}
}

func TestClickHouseMemberCommandRules(t *testing.T) {
	if err := validateManagedDatabaseInput(managedDatabaseCommand{Type: "postgres", ClickhouseAvailability: &clickHouseAvailabilityCommand{}}); err == nil {
		t.Fatal("a Postgres command with a ClickHouse member part was accepted")
	}
	broken := chAvailabilityCommand(t, false)
	broken.EngineConfig = json.RawMessage(`{"version":1,"loopbackHost":"127.0.0.1"}`)
	if err := validateClickHouseAvailability(managedDatabaseCommand{Type: "clickhouse", ClickhouseAvailability: broken}, "db1"); err == nil {
		t.Fatal("an invalid engine configuration was accepted")
	}
	env := withoutEnv([]string{"CLICKHOUSE_USER=u", "CLICKHOUSE_DB=app", "CLICKHOUSE_DB_EXTRA=x"}, "CLICKHOUSE_DB")
	if len(env) != 2 || env[0] != "CLICKHOUSE_USER=u" || env[1] != "CLICKHOUSE_DB_EXTRA=x" {
		t.Fatalf("env %v", env)
	}
	owner := clickHouseMemberOwnerOverrideConfig("gw_owner", "secret<&>")
	if !strings.Contains(owner, "<profile>"+legacycompat.ClickHouseClientProfile+"</profile>") || strings.Contains(owner, "<profile>default</profile>") ||
		!strings.Contains(owner, "secret&lt;&amp;&gt;") {
		t.Fatalf("owner override %s", owner)
	}
	if clickHouseAvailabilitySetID(managedDatabaseCommand{ClickhouseAvailability: chAvailabilityCommand(t, true)}) != "" {
		t.Fatal("a standalone node is no set member")
	}
}
