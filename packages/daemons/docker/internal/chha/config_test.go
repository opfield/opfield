package chha

import (
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

func TestRenderServerConfigPairWithWitness(t *testing.T) {
	ec := pairEngineConfig()
	config := testConfig(memberha.ModeAutomatic, ec, testMemberA, testMemberB)
	parsed, err := ParseEngineConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	got := string(RenderServerConfig(config, parsed, true))
	want := `<clickhouse>
    <interserver_http_host>127.12.34.1</interserver_http_host>
    <interserver_http_port>39001</interserver_http_port>
    <macros><shard>s1</shard><replica>11111111-1111-4111-8111-111111111111</replica></macros>
    <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>1</server_id>
        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
        <enable_reconfiguration>true</enable_reconfiguration>
        <four_letter_word_white_list>ruok,srvr,mntr,conf,isro,lgif,rqld</four_letter_word_white_list>
        <coordination_settings>
            <operation_timeout_ms>10000</operation_timeout_ms>
            <min_session_timeout_ms>4000</min_session_timeout_ms>
            <session_timeout_ms>30000</session_timeout_ms>
            <raft_logs_level>warning</raft_logs_level>
        </coordination_settings>
        <raft_configuration>
            <server><id>1</id><hostname>127.12.34.1</hostname><port>39501</port><priority>3</priority></server>
            <server><id>2</id><hostname>127.12.34.1</hostname><port>39502</port><priority>3</priority></server>
            <server><id>101</id><hostname>127.12.34.1</hostname><port>39433</port><priority>1</priority></server>
        </raft_configuration>
    </keeper_server>
    <zookeeper><node><host>127.0.0.1</host><port>9181</port></node><session_timeout_ms>5000</session_timeout_ms><operation_timeout_ms>3000</operation_timeout_ms><zookeeper_load_balancing>in_order</zookeeper_load_balancing></zookeeper>
    <user_directories replace="replace"><users_xml><path>users.xml</path></users_xml><replicated><zookeeper_path>/gw/access</zookeeper_path></replicated></user_directories>
    <distributed_ddl><path>/gw/task_queue/ddl</path></distributed_ddl>
</clickhouse>
`
	if got != want {
		t.Fatalf("server config:\n%s\nwant:\n%s", got, want)
	}
}

func TestRenderServerConfigThreeMembersAndBootstrap(t *testing.T) {
	ec := EngineConfig{Version: 1, LoopbackHost: "127.9.9.1", KeeperServerID: 3,
		KeeperServers: []KeeperServer{
			{ID: 1, Port: 39501, MemberID: testMemberA, Role: RoleVoter},
			{ID: 2, Port: 39502, MemberID: testMemberB, Role: RoleVoter},
			{ID: 3, Port: 39503, MemberID: testMemberC, Role: RoleVoter},
		},
		Interserver: []InterserverPeer{{MemberID: testMemberA, Port: 39001}, {MemberID: testMemberB, Port: 39002}, {MemberID: testMemberC, Port: 39003}},
	}
	config := testConfig(memberha.ModeAutomatic, ec, testMemberC, testMemberA, testMemberB)
	got := string(RenderServerConfig(config, ec, true))
	for _, want := range []string{"<server_id>3</server_id>", "<port>39503</port><priority>3</priority></server>", "<interserver_http_port>39003</interserver_http_port>"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in\n%s", want, got)
		}
	}
	if strings.Contains(got, "can_become_leader") {
		t.Fatal("can_become_leader=false makes a learner (no vote); priorities order leadership")
	}
	// Convert: the origin's first Keeper start knows only itself; once the
	// log exists the desired voters are rendered.
	ec.BootstrapVoters = []uint32{1}
	ec.KeeperServerID = 1
	origin := testConfig(memberha.ModeAutomatic, ec, testMemberA, testMemberB, testMemberC)
	first := string(RenderServerConfig(origin, ec, true))
	if strings.Count(first, "<server>") != 1 || !strings.Contains(first, "<id>1</id>") {
		t.Fatalf("bootstrap raft list should be the origin only:\n%s", first)
	}
	later := string(RenderServerConfig(origin, ec, false))
	if strings.Count(later, "<server>") != 3 {
		t.Fatalf("an initialised Keeper renders the desired voters:\n%s", later)
	}
	// Only the origin waits for its convert; a copy joins the converted databases at once.
	ec.ConvertDatabases = []string{"app"}
	if !ec.convertsHere() {
		t.Fatal("the origin runs the convert")
	}
	copyConfig := ec
	copyConfig.KeeperServerID = 2
	if copyConfig.convertsHere() {
		t.Fatal("a copy does not run the convert")
	}
	files := StageMemberFiles(joiningConfigOf(origin, copyConfig), copyConfig, true, false, 10000, "hash")
	if string(files[joiningMarker]) != "joining\n" || len(files) != 4 {
		t.Fatalf("a member staged with an empty Keeper state is joining: %v", files)
	}
	if files := StageMemberFiles(origin, ec, true, true, 10000, "hash"); files[joiningMarker] != nil {
		t.Fatal("a standalone node is not joining")
	}
	if files := StageMemberFiles(origin, ec, false, false, 10000, "hash"); files[joiningMarker] != nil {
		t.Fatal("a Keeper with a log is not joining")
	}
	lifted := string(StageMemberFiles(origin, ec, false, true, 10000, "hash")[ServerConfigFile])
	if !strings.Contains(lifted, "<force_recovery>true</force_recovery>") || strings.Count(lifted, "<server>") != 1 ||
		!strings.Contains(lifted, "<enable_reconfiguration>false</enable_reconfiguration>") {
		t.Fatalf("a lifted member's Keeper is forced to be its only voter:\n%s", lifted)
	}
	ec.ConvertDatabases = nil
	// A member that joins lists the current voters and itself.
	ec.BootstrapVoters = nil
	ec.KeeperServers[2].Role = RoleLeaving
	ec.KeeperServerID = 3
	joining := testConfig(memberha.ModeAutomatic, ec, testMemberC, testMemberA, testMemberB)
	rendered := string(RenderServerConfig(joining, ec, true))
	if strings.Count(rendered, "<server>") != 3 {
		t.Fatalf("a joining member lists the voters and itself:\n%s", rendered)
	}
}

func TestEngineConfigValidation(t *testing.T) {
	base := pairEngineConfig()
	config := testConfig(memberha.ModeAutomatic, base, testMemberA, testMemberB)
	if err := base.Validate(config); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
	cases := map[string]func(ec *EngineConfig){
		"own loopback":       func(ec *EngineConfig) { ec.LoopbackHost = "127.0.0.1" },
		"not loopback":       func(ec *EngineConfig) { ec.LoopbackHost = "10.0.0.1" },
		"port range":         func(ec *EngineConfig) { ec.KeeperServers[0].Port = 9234 },
		"duplicate port":     func(ec *EngineConfig) { ec.Interserver[0].Port = 39501 },
		"duplicate id":       func(ec *EngineConfig) { ec.KeeperServers[1].ID = 1 },
		"unknown member":     func(ec *EngineConfig) { ec.KeeperServers[1].MemberID = testMemberC },
		"self missing":       func(ec *EngineConfig) { ec.KeeperServerID = 7 },
		"member standby":     func(ec *EngineConfig) { ec.KeeperServers[1].Role = RoleStandby },
		"bad role":           func(ec *EngineConfig) { ec.KeeperServers[2].Role = "active" },
		"no interserver":     func(ec *EngineConfig) { ec.Interserver = ec.Interserver[1:] },
		"reserved database":  func(ec *EngineConfig) { ec.Databases = []string{"system"} },
		"convert suffix":     func(ec *EngineConfig) { ec.ConvertDatabases = []string{"app_gwold"} },
		"bad bootstrap":      func(ec *EngineConfig) { ec.BootstrapVoters = []uint32{9} },
		"weak interserver":   func(ec *EngineConfig) { ec.InterserverUser, ec.InterserverPassword = "gw", "short" },
		"version":            func(ec *EngineConfig) { ec.Version = 2 },
		"witness and member": func(ec *EngineConfig) { ec.KeeperServers[2].MemberID = testMemberB },
	}
	for name, mutate := range cases {
		ec := pairEngineConfig()
		mutate(&ec)
		if err := ec.Validate(config); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRenderUsersAndRole(t *testing.T) {
	users := string(RenderUsersConfig(2, 10000, strings.Repeat("ab", 32)))
	for _, want := range []string{"<insert_quorum>2</insert_quorum>", "<insert_quorum_timeout>10000</insert_quorum_timeout>",
		"<database_replicated_allow_only_replicated_engine>1</database_replicated_allow_only_replicated_engine>",
		"<default_table_engine>ReplicatedMergeTree</default_table_engine>", "<gateway_member><password_sha256_hex>",
		// The daemon's user gives client users the client profile (ALTER USER).
		"<access_management>1</access_management></gateway_member>"} {
		if !strings.Contains(users, want) {
			t.Fatalf("missing %q in\n%s", want, users)
		}
	}
	if !strings.Contains(string(RenderRoleConfig(false)), "<readonly>1</readonly>") ||
		!strings.Contains(string(RenderRoleConfig(true)), "<readonly>0</readonly>") {
		t.Fatal("client profile readonly flag")
	}
	ec := pairEngineConfig()
	if got := ec.ReconfigEntry(ec.KeeperServers[2]); got != "server.101=127.12.34.1:39433;participant;1" {
		t.Fatalf("witness reconfig entry %q", got)
	}
	if got := ec.ReconfigEntry(ec.KeeperServers[1]); got != "server.2=127.12.34.1:39502;participant;3" {
		t.Fatalf("member reconfig entry %q", got)
	}
}

// The engine configuration Opfield builds (CORE engine-clickhouse.test.ts
// "matches the daemon contract" pins the same document).
func TestOpfieldEngineConfigContract(t *testing.T) {
	document := `{"version":1,"loopbackHost":"127.48.54.1","keeperServerId":1,
		"keeperServers":[{"id":1,"port":39501,"memberId":"11111111-1111-4111-8111-111111111111","role":"voter"},
			{"id":2,"port":39502,"memberId":"22222222-2222-4222-8222-222222222222","role":"voter"},
			{"id":1001,"port":39433,"witnessId":"44444444-4444-4444-8444-444444444444","role":"voter"},
			{"id":1002,"port":39437,"witnessId":"55555555-5555-4555-8555-555555555555","role":"standby"}],
		"interserver":[{"memberId":"11111111-1111-4111-8111-111111111111","port":39000},{"memberId":"22222222-2222-4222-8222-222222222222","port":39001}],
		"interserverUser":"gw_interserver","interserverPassword":"interserver-password-0123456789","databases":["app"]}`
	config := testConfig(memberha.ModeAutomatic, EngineConfig{}, testMemberA, testMemberB)
	config.EngineConfig = []byte(document)
	ec, err := ParseEngineConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(ec.Voters()) != 3 || len(standbys(ec)) != 1 || ec.InterserverPort(testMemberB) != 39001 {
		t.Fatalf("parsed %+v", ec)
	}
	rendered := string(RenderServerConfig(config, ec, true))
	if !strings.Contains(rendered, "<interserver_http_credentials><user>gw_interserver</user>") ||
		!strings.Contains(rendered, "<server><id>1001</id><hostname>127.48.54.1</hostname><port>39433</port><priority>1</priority></server>") {
		t.Fatalf("rendered %s", rendered)
	}
}

func joiningConfigOf(config memberha.Config, ec EngineConfig) memberha.Config {
	config.EngineConfig = mustJSON(ec)
	return config
}

// A switch does not wait out ClickHouse's own 30 s shutdown.
func TestClickHouseCleanStopIsShort(t *testing.T) {
	var e engine
	if grace := e.StopGrace(); grace <= 0 || grace > 10*time.Second {
		t.Fatalf("clean stop grace %v", grace)
	}
}
