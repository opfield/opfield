package chha

import (
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// MemberReadinessQuery is the docker daemon's readiness query of a set
// member's container (create, recreate): the engine answers. A member's
// databases are the set's Replicated ones and exist only once its Keeper
// joined the set (a new copy waits for the holder to add it), so readiness
// never names a database; the member runtime reports the databases syncing
// until it has them.
const MemberReadinessQuery = "SELECT 1"

// StageMemberFiles are the files the docker daemon writes into a member's
// data mount before it creates the member's container (create, convert,
// lift): the server config, the users config, the client profile and, for a
// set member whose Keeper has no state yet, the joining marker. The member
// runtime takes the member over only once its container exists, so the
// marker is what tells the holder (member-control) that this Keeper waits to
// be added: without it the holder never adds a copy the daemon created, and
// the copy never gets a Keeper session (rc.1 stand B blocker).
func StageMemberFiles(config memberha.Config, ec EngineConfig, keeperLogEmpty, standalone bool, quorumTimeoutMs uint32,
	internalPasswordSHA256 string) map[string][]byte {
	files := map[string][]byte{
		ServerConfigFile: RenderServerConfig(config, ec, keeperLogEmpty),
		UsersConfigFile:  RenderUsersConfig(1, quorumTimeoutMs, internalPasswordSHA256),
		RoleConfigFile:   RenderRoleConfig(standalone),
	}
	if keeperLogEmpty && !standalone {
		files[joiningMarker] = []byte("joining\n")
	}
	return files
}
