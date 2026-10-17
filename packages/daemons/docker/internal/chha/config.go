package chha

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"net/netip"
	"regexp"
	"sort"
	"strings"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Engine is the memberha engine name.
const Engine = "clickhouse"

// Ports inside a member's container and the ranges Opfield allocates from.
const (
	// KeeperClientPort is the embedded Keeper's client port (the member's
	// own ZooKeeper client and the daemon's probe use it).
	KeeperClientPort = 9181
	// HTTPPort is the engine's HTTP interface (the daemon's status queries).
	HTTPPort = 8123
	// MeshPortMin/MeshPortMax bound every Keeper raft and interserver
	// endpoint port of a set (relay-local witness raft ports 39400-39499,
	// member raft ports and forwarders 39500-39999, interserver 39000-39399).
	MeshPortMin = 39000
	MeshPortMax = 39999
)

// Keeper server roles in the engine configuration.
const (
	// RoleVoter is a desired Keeper voter.
	RoleVoter = "voter"
	// RoleStandby is a staged standby witness: not a voter; the holder may
	// activate it while Opfield is down (decision 8) and then adds it.
	RoleStandby = "standby"
	// RoleLearner is a member's Keeper that replicates the log and serves its
	// own member's ZooKeeper session but does not vote: the 4th and 5th data
	// members of a set, and a manual pair's copy (its primary never waits for
	// it). A learner becomes a voter only through a rejoin with a wiped
	// Keeper state (an in-place role change crashed Keeper 25.8).
	RoleLearner = "learner"
	// RoleLeaving is a server Opfield is removing: the holder removes it from
	// the Keeper configuration once every desired voter is in it.
	RoleLeaving = "leaving"
)

// Names of the configuration files of a member (in its data mount) and where
// the container sees them.
const (
	ServerConfigFile   = legacycompat.AvailabilityFilePrefix + ".xml"
	UsersConfigFile    = legacycompat.AvailabilityFilePrefix + "-users.xml"
	RoleConfigFile     = legacycompat.AvailabilityFilePrefix + "-role.xml"
	ServerConfigTarget = "/etc/clickhouse-server/config.d/zz-" + legacycompat.AvailabilityFilePrefix + ".xml"
	UsersConfigTarget  = "/etc/clickhouse-server/users.d/zz-" + legacycompat.AvailabilityFilePrefix + ".xml"
	RoleConfigTarget   = "/etc/clickhouse-server/users.d/zz-" + legacycompat.AvailabilityFilePrefix + "-role.xml"
	// ClientProfile is the settings profile every client user has.
	ClientProfile = legacycompat.ClickHouseClientProfile
	// InternalUser is the daemon's own user (status, reconfiguration).
	InternalUser = legacycompat.ClickHouseInternalUser
	// DatabasePathPrefix is the Keeper path of the set's Replicated databases.
	DatabasePathPrefix = "/gw/db"
	// AccessPath is the Keeper path of the replicated access storage.
	AccessPath = "/gw/access"
	// Shard is the one shard of a set.
	Shard = "s1"
)

var (
	uuidPattern     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	databasePattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`)
	userPattern     = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`)
)

// KeeperServer is one Keeper server of the set: a member's embedded Keeper or
// a witness Keeper. Its endpoint is LoopbackHost:Port on every node.
type KeeperServer struct {
	ID        uint32 `json:"id"`
	Port      uint32 `json:"port"`
	MemberID  string `json:"memberId,omitempty"`
	WitnessID string `json:"witnessId,omitempty"`
	Role      string `json:"role"`
}

// Alias is the member mesh alias that reaches the server's raft port.
func (s KeeperServer) Alias() string {
	if s.WitnessID != "" {
		return "witness-" + s.WitnessID + "-ch-keeper"
	}
	return "member-" + s.MemberID + "-ch-keeper"
}

// Witness reports a witness Keeper (never a leader).
func (s KeeperServer) Witness() bool { return s.WitnessID != "" }

// InterserverPeer is one member's interserver (replication fetch) port.
type InterserverPeer struct {
	MemberID string `json:"memberId"`
	Port     uint32 `json:"port"`
}

// EngineConfig is the ClickHouse part of a member's configuration
// (AvailabilityMemberConfig.engine_config), computed by Opfield.
type EngineConfig struct {
	Version      int    `json:"version"`
	LoopbackHost string `json:"loopbackHost"`
	// KeeperServerID is this member's embedded Keeper server id.
	KeeperServerID uint32         `json:"keeperServerId"`
	KeeperServers  []KeeperServer `json:"keeperServers"`
	// BootstrapVoters is the raft list a Keeper with an empty log starts with
	// when set (convert: only the origin member, a single voter). Otherwise
	// the desired voters.
	BootstrapVoters []uint32          `json:"bootstrapVoters,omitempty"`
	Interserver     []InterserverPeer `json:"interserver"`
	// InterserverUser/Password authenticate replication fetches (set-wide).
	InterserverUser     string `json:"interserverUser,omitempty"`
	InterserverPassword string `json:"interserverPassword,omitempty"`
	// Databases every member must have as Replicated databases.
	Databases []string `json:"databases,omitempty"`
	// ConvertDatabases are Atomic databases the holder moves into Replicated
	// databases of the same name without copying (convert, P0-T02 item 5).
	ConvertDatabases []string `json:"convertDatabases,omitempty"`
	// ConvertOperationID names the convert run (reports carry its progress).
	ConvertOperationID string `json:"convertOperationId,omitempty"`
}

// ParseEngineConfig decodes and validates a member's engine configuration.
func ParseEngineConfig(config memberha.Config) (EngineConfig, error) {
	var ec EngineConfig
	if len(config.EngineConfig) == 0 {
		return ec, errors.New("the ClickHouse member has no engine configuration")
	}
	if err := json.Unmarshal(config.EngineConfig, &ec); err != nil {
		return ec, fmt.Errorf("ClickHouse engine configuration: %w", err)
	}
	return ec, ec.Validate(config)
}

// Validate checks everything the renderers and forwarders rely on.
func (ec EngineConfig) Validate(config memberha.Config) error {
	if ec.Version != 1 {
		return fmt.Errorf("unsupported ClickHouse engine configuration version %d", ec.Version)
	}
	host, err := netip.ParseAddr(ec.LoopbackHost)
	if err != nil || !host.Is4() || !host.IsLoopback() || host == netip.MustParseAddr("127.0.0.1") {
		return fmt.Errorf("loopback host %q must be a 127.0.0.0/8 address other than 127.0.0.1", ec.LoopbackHost)
	}
	ports := map[uint32]string{}
	use := func(port uint32, owner string) error {
		if port < MeshPortMin || port > MeshPortMax {
			return fmt.Errorf("%s: port %d is outside %d-%d", owner, port, MeshPortMin, MeshPortMax)
		}
		if other, taken := ports[port]; taken {
			return fmt.Errorf("%s and %s both use port %d", other, owner, port)
		}
		ports[port] = owner
		return nil
	}
	ids := map[uint32]bool{}
	self, voters := false, 0
	for _, server := range ec.KeeperServers {
		owner := fmt.Sprintf("keeper server %d", server.ID)
		if server.ID == 0 || ids[server.ID] {
			return fmt.Errorf("%s: invalid or repeated id", owner)
		}
		ids[server.ID] = true
		if (server.MemberID == "") == (server.WitnessID == "") {
			return fmt.Errorf("%s: names neither or both a member and a witness", owner)
		}
		if server.MemberID != "" {
			if _, ok := config.Peer(server.MemberID); !ok {
				return fmt.Errorf("%s: member %s is not in the set", owner, server.MemberID)
			}
		} else if !uuidPattern.MatchString(server.WitnessID) {
			return fmt.Errorf("%s: invalid witness id", owner)
		}
		switch server.Role {
		case RoleVoter:
			voters++
		case RoleStandby, RoleLeaving:
		case RoleLearner:
			if server.MemberID == "" {
				return fmt.Errorf("%s: only a member's Keeper can be a learner", owner)
			}
		default:
			return fmt.Errorf("%s: unknown role %q", owner, server.Role)
		}
		if server.Role == RoleStandby && server.MemberID != "" {
			return fmt.Errorf("%s: only a witness can be a standby", owner)
		}
		if err := use(server.Port, owner); err != nil {
			return err
		}
		if server.ID == ec.KeeperServerID {
			if server.MemberID != config.MemberID {
				return fmt.Errorf("%s: this member's Keeper id names another server", owner)
			}
			self = true
		}
	}
	if !self {
		return errors.New("this member's Keeper server is not in the configuration")
	}
	if voters == 0 {
		return errors.New("the Keeper configuration has no voter")
	}
	for _, id := range ec.BootstrapVoters {
		if !ids[id] {
			return fmt.Errorf("bootstrap voter %d is not a Keeper server", id)
		}
	}
	interserverSelf := false
	for _, peer := range ec.Interserver {
		if _, ok := config.Peer(peer.MemberID); !ok {
			return fmt.Errorf("interserver peer %s is not in the set", peer.MemberID)
		}
		if err := use(peer.Port, "interserver of "+peer.MemberID); err != nil {
			return err
		}
		interserverSelf = interserverSelf || peer.MemberID == config.MemberID
	}
	if !interserverSelf {
		return errors.New("this member's interserver port is not in the configuration")
	}
	if ec.InterserverUser != "" && (!userPattern.MatchString(ec.InterserverUser) || len(ec.InterserverPassword) < 16) {
		return errors.New("interserver credentials are invalid")
	}
	for _, name := range append(append([]string(nil), ec.Databases...), ec.ConvertDatabases...) {
		if !databasePattern.MatchString(name) || reservedDatabase(name) {
			return fmt.Errorf("database name %q is not allowed", name)
		}
	}
	return nil
}

func reservedDatabase(name string) bool {
	switch strings.ToLower(name) {
	case "system", "information_schema", "default":
		return true
	}
	return strings.HasSuffix(name, convertSuffixOld) || strings.HasSuffix(name, convertSuffixNew)
}

// Self is this member's Keeper server.
func (ec EngineConfig) Self() KeeperServer {
	for _, server := range ec.KeeperServers {
		if server.ID == ec.KeeperServerID {
			return server
		}
	}
	return KeeperServer{}
}

// Server returns the Keeper server with id.
func (ec EngineConfig) Server(id uint32) (KeeperServer, bool) {
	for _, server := range ec.KeeperServers {
		if server.ID == id {
			return server, true
		}
	}
	return KeeperServer{}, false
}

// Learners are the desired learners, by id.
func (ec EngineConfig) Learners() []KeeperServer {
	out := []KeeperServer{}
	for _, server := range ec.KeeperServers {
		if server.Role == RoleLearner {
			out = append(out, server)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// convertsHere: this member runs the convert of ConvertDatabases (it is the
// bootstrap voter of the convert, the origin).
func (ec EngineConfig) convertsHere() bool {
	if len(ec.ConvertDatabases) == 0 {
		return false
	}
	if len(ec.BootstrapVoters) == 0 {
		return true
	}
	for _, id := range ec.BootstrapVoters {
		if id == ec.KeeperServerID {
			return true
		}
	}
	return false
}

// Voters are the desired voters, by id.
func (ec EngineConfig) Voters() []KeeperServer {
	out := []KeeperServer{}
	for _, server := range ec.KeeperServers {
		if server.Role == RoleVoter {
			out = append(out, server)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// InterserverPort is the interserver port of memberID (0 when unknown).
func (ec EngineConfig) InterserverPort(memberID string) uint32 {
	for _, peer := range ec.Interserver {
		if peer.MemberID == memberID {
			return peer.Port
		}
	}
	return 0
}

// Endpoint is a server's raft endpoint as every node writes it.
func (ec EngineConfig) Endpoint(server KeeperServer) string {
	return fmt.Sprintf("%s:%d", ec.LoopbackHost, server.Port)
}

// Raft priorities: data members lead; a witness only votes (a leading
// witness stalled inserts for ~30 s when it died, P0-T02 item 8). Not
// can_become_leader=false: that makes a Keeper a learner, which does not vote.
const (
	MemberPriority  = 3
	WitnessPriority = 1
)

// Priority is the server's raft priority.
func (s KeeperServer) Priority() int {
	if s.Witness() {
		return WitnessPriority
	}
	return MemberPriority
}

// ReconfigEntry is the "reconfig add" argument of a server.
func (ec EngineConfig) ReconfigEntry(server KeeperServer) string {
	if server.Role == RoleLearner {
		return fmt.Sprintf("server.%d=%s;learner;1", server.ID, ec.Endpoint(server))
	}
	return fmt.Sprintf("server.%d=%s;participant;%d", server.ID, ec.Endpoint(server), server.Priority())
}

// RenderMode selects the raft list and recovery settings of the server config.
type RenderMode int

const (
	// RenderNormal: desired voters and learners (or the bootstrap voters while
	// the Keeper has no log), this member added as a joining server.
	RenderNormal RenderMode = iota
	// RenderRecovery: this member alone as a voter with force_recovery and
	// reconfiguration off (a manual pair's assigned primary whose voter is
	// gone: Keeper ignores a changed raft list while reconfiguration is on,
	// and 4lw rcvr left it unresponsive in the prototype).
	RenderRecovery
	// RenderSoleVoter: this member alone as a voter, reconfiguration on (the
	// restart after a recovery; the holder adds the other member again).
	RenderSoleVoter
)

func escapeXML(value string) string {
	var out strings.Builder
	_ = xml.EscapeText(&out, []byte(value))
	return out.String()
}

// RenderServerConfig is the member's config.d file: interserver endpoint,
// macros, the embedded Keeper, the ZooKeeper client (own Keeper only),
// replicated access storage. keeperLogEmpty: the Keeper has no log yet (the
// raft list is then the bootstrap voters when set).
func RenderServerConfig(config memberha.Config, ec EngineConfig, keeperLogEmpty bool) []byte {
	return RenderServerConfigMode(config, ec, keeperLogEmpty, RenderNormal)
}

// RenderServerConfigMode is RenderServerConfig with a raft list mode.
func RenderServerConfigMode(config memberha.Config, ec EngineConfig, keeperLogEmpty bool, mode RenderMode) []byte {
	raft := append(ec.Voters(), ec.Learners()...)
	if keeperLogEmpty && len(ec.BootstrapVoters) > 0 {
		raft = raft[:0]
		for _, id := range ec.BootstrapVoters {
			if server, ok := ec.Server(id); ok {
				raft = append(raft, server)
			}
		}
		sort.Slice(raft, func(i, j int) bool { return raft[i].ID < raft[j].ID })
	}
	self := ec.Self()
	if mode != RenderNormal {
		self.Role = RoleVoter
		raft = []KeeperServer{self}
	}
	inRaft := false
	for _, server := range raft {
		inRaft = inRaft || server.ID == self.ID
	}
	if !inRaft {
		// A joining member lists itself with the current voters; it cannot win
		// an election alone and is added by the holder (reconfig add).
		raft = append(raft, self)
	}
	sort.SliceStable(raft, func(i, j int) bool { return raft[i].ID < raft[j].ID })
	var b strings.Builder
	b.WriteString("<clickhouse>\n")
	fmt.Fprintf(&b, "    <interserver_http_host>%s</interserver_http_host>\n", ec.LoopbackHost)
	fmt.Fprintf(&b, "    <interserver_http_port>%d</interserver_http_port>\n", ec.InterserverPort(config.MemberID))
	if ec.InterserverUser != "" {
		fmt.Fprintf(&b, "    <interserver_http_credentials><user>%s</user><password>%s</password></interserver_http_credentials>\n",
			ec.InterserverUser, escapeXML(ec.InterserverPassword))
	}
	fmt.Fprintf(&b, "    <macros><shard>%s</shard><replica>%s</replica></macros>\n", Shard, config.MemberID)
	b.WriteString("    <keeper_server>\n")
	fmt.Fprintf(&b, "        <tcp_port>%d</tcp_port>\n", KeeperClientPort)
	fmt.Fprintf(&b, "        <server_id>%d</server_id>\n", self.ID)
	b.WriteString("        <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>\n")
	b.WriteString("        <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>\n")
	if mode == RenderRecovery {
		b.WriteString("        <enable_reconfiguration>false</enable_reconfiguration>\n")
		b.WriteString("        <force_recovery>true</force_recovery>\n")
	} else {
		b.WriteString("        <enable_reconfiguration>true</enable_reconfiguration>\n")
	}
	b.WriteString("        <four_letter_word_white_list>ruok,srvr,mntr,conf,isro,lgif,rqld</four_letter_word_white_list>\n")
	b.WriteString("        <coordination_settings>\n")
	b.WriteString("            <operation_timeout_ms>10000</operation_timeout_ms>\n")
	b.WriteString("            <min_session_timeout_ms>4000</min_session_timeout_ms>\n")
	b.WriteString("            <session_timeout_ms>30000</session_timeout_ms>\n")
	b.WriteString("            <raft_logs_level>warning</raft_logs_level>\n")
	b.WriteString("        </coordination_settings>\n")
	b.WriteString("        <raft_configuration>\n")
	for _, server := range raft {
		if server.Role == RoleLearner {
			// can_become_leader=false is how Keeper's XML names a learner.
			fmt.Fprintf(&b, "            <server><id>%d</id><hostname>%s</hostname><port>%d</port><can_become_leader>false</can_become_leader></server>\n",
				server.ID, ec.LoopbackHost, server.Port)
			continue
		}
		fmt.Fprintf(&b, "            <server><id>%d</id><hostname>%s</hostname><port>%d</port><priority>%d</priority></server>\n",
			server.ID, ec.LoopbackHost, server.Port, server.Priority())
	}
	b.WriteString("        </raft_configuration>\n")
	b.WriteString("    </keeper_server>\n")
	// Own Keeper only (P0-T02 item 8): a member never sits on a dead peer's
	// Keeper, and a minority member has no session (read-only tables).
	fmt.Fprintf(&b, "    <zookeeper><node><host>127.0.0.1</host><port>%d</port></node>", KeeperClientPort)
	b.WriteString("<session_timeout_ms>5000</session_timeout_ms><operation_timeout_ms>3000</operation_timeout_ms>")
	b.WriteString("<zookeeper_load_balancing>in_order</zookeeper_load_balancing></zookeeper>\n")
	fmt.Fprintf(&b, "    <user_directories replace=\"replace\"><users_xml><path>users.xml</path></users_xml><replicated><zookeeper_path>%s</zookeeper_path></replicated></user_directories>\n", AccessPath)
	b.WriteString("    <distributed_ddl><path>/gw/task_queue/ddl</path></distributed_ddl>\n")
	b.WriteString("</clickhouse>\n")
	return []byte(b.String())
}

// RenderUsersConfig is the member's users.d file: the default profile's
// replication rules and insert quorum (reloaded live), and the daemon's
// internal user.
func RenderUsersConfig(quorum int, quorumTimeoutMs uint32, internalPasswordSHA256 string) []byte {
	if quorum < 1 {
		quorum = 1
	}
	var b strings.Builder
	b.WriteString("<clickhouse>\n    <profiles>\n        <default>\n")
	fmt.Fprintf(&b, "            <insert_quorum>%d</insert_quorum>\n", quorum)
	fmt.Fprintf(&b, "            <insert_quorum_timeout>%d</insert_quorum_timeout>\n", quorumTimeoutMs)
	b.WriteString("            <database_replicated_allow_only_replicated_engine>1</database_replicated_allow_only_replicated_engine>\n")
	b.WriteString("            <default_table_engine>ReplicatedMergeTree</default_table_engine>\n")
	b.WriteString("        </default>\n    </profiles>\n    <users>\n")
	// access_management: the daemon gives every replicated client user the
	// client profile (the read-only guard of a copy and of a switching
	// primary), which takes ALTER USER (stand rc.9: "Not enough privileges").
	fmt.Fprintf(&b, "        <%s><password_sha256_hex>%s</password_sha256_hex><profile>default</profile><quota>default</quota><networks><ip>::/0</ip></networks><access_management>1</access_management></%s>\n",
		InternalUser, internalPasswordSHA256, InternalUser)
	b.WriteString("    </users>\n</clickhouse>\n")
	return []byte(b.String())
}

// RenderRoleConfig is the client profile: read-only on a copy, writable on
// the holder.
func RenderRoleConfig(writable bool) []byte {
	readonly := 1
	if writable {
		readonly = 0
	}
	return []byte(fmt.Sprintf("<clickhouse>\n    <profiles>\n        <%s>\n            <readonly>%d</readonly>\n        </%s>\n    </profiles>\n</clickhouse>\n",
		ClientProfile, readonly, ClientProfile))
}
