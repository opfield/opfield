package chha

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Keeper roles beyond three voters (prototype for the unblocking work,
// 2026-10-11, ClickHouse 25.8):
//
//   - A learner Keeper replicates the log and serves its own member's
//     ZooKeeper sessions (inserts on a member whose Keeper is a learner work).
//     Sets of 4-5 members run learners on the members beyond the first three,
//     and a manual pair's copy is a learner, so its primary never waits on it.
//   - Keeper cannot change a server's role in place ("Bad arguments"), and
//     removing a live learner and adding it back as a participant crashed it
//     (segfault in commit_in_bg). A role change is therefore a rejoin: the
//     member wipes its Keeper state (moved aside) and starts again as a joining
//     server; the holder removes the old entry and adds the member with its
//     role. A member only waits to be added after such a wipe (or on its first
//     start): it says so on its member-control port (keeperJoining), and the
//     holder adds no member that does not.
//   - Forced recovery (a manual pair's assigned primary whose voter is gone):
//     4lw rcvr while reconfiguration is on ignores the new raft list and left
//     Keeper unresponsive; a restart with reconfiguration off, force_recovery
//     and this member as the only voter works, then a second restart with
//     reconfiguration on (reconfig answers "Unimplemented" until then).
const (
	recoveryFile  = "gateway-availability-recovery.json"
	joiningMarker = "gateway-keeper-joining"
	// keeperRoleFile keeps the role this member's Keeper last had in its own
	// cluster configuration (voter or learner; empty after a wipe). A manual
	// pair's member reads it before its Keeper can answer: a learner cannot
	// hold a diverged state that harms its peer and needs its peer's Keeper to
	// serve at all (ClickHouse exits at startup without a ZooKeeper session),
	// so only a voter's Keeper waits for the peer check (checkKeeperGate).
	keeperRoleFile   = "gateway-keeper-role"
	recoveryAfter    = 15 * time.Second
	learnerOutOfStep = 30 * time.Second
	// peerKeeperJoining is the PeerState.Engine key of a member whose Keeper
	// waits to be added.
	peerKeeperJoining = "keeperJoining"
	// peerKeeperVoters lists the voters of the member's Keeper configuration.
	peerKeeperVoters = "keeperVoters"
	// peerKeeperRole is the member's own Keeper role (keeperRoleFile).
	peerKeeperRole = "keeperRole"
)

// Recovery phases of a manual pair's primary.
const (
	phaseRecovering = "recovering"
	phaseSoleVoter  = "sole"
)

type recovery struct {
	Phase    string `json:"phase"`
	AtUnixMs int64  `json:"atUnixMs"`
}

func decodeRecovery(raw []byte) *recovery {
	var r recovery
	if len(raw) == 0 || json.Unmarshal(raw, &r) != nil || (r.Phase != phaseRecovering && r.Phase != phaseSoleVoter) {
		return nil
	}
	return &r
}

// recoveryAdopted: Gateway's configuration names this member the only voter.
func recoveryAdopted(ec EngineConfig) bool {
	voters := ec.Voters()
	return len(voters) == 1 && voters[0].ID == ec.KeeperServerID
}

// effectiveRoles are the voters and learners the holder reconciles toward:
// Gateway's, with a standby activation or a forced recovery applied while
// Gateway's configuration does not show them yet.
func effectiveRoles(config memberha.Config, ec EngineConfig, act *activation, rec *recovery) (voters, learners []KeeperServer) {
	if rec != nil && !recoveryAdopted(ec) {
		self := ec.Self()
		self.Role = RoleVoter
		voters = []KeeperServer{self}
		for _, server := range ec.KeeperServers {
			if server.MemberID == "" || server.ID == self.ID || server.Role == RoleLeaving {
				continue
			}
			if peer, ok := config.Peer(server.MemberID); ok && !peer.Removing {
				server.Role = RoleLearner
				learners = append(learners, server)
			}
		}
		sort.Slice(learners, func(i, j int) bool { return learners[i].ID < learners[j].ID })
		return voters, learners
	}
	return desiredVoters(ec, act), ec.Learners()
}

// selfRole is this member's desired role among the effective roles.
func selfRole(selfID uint32, voters, learners []KeeperServer) string {
	for _, server := range voters {
		if server.ID == selfID {
			return RoleVoter
		}
	}
	for _, server := range learners {
		if server.ID == selfID {
			return RoleLearner
		}
	}
	return ""
}

// copyRejoinReason decides whether a copy (not the primary) must wipe its
// Keeper state and join again. view is its Keeper's cluster configuration
// (nil when its Keeper does not serve). Only states where its Keeper holds no
// data the set needs qualify:
//   - promoted: it is a learner and must become a voter;
//   - diverged: a manual pair's copy that is a voter of a cluster without the
//     voters Gateway names (the primary recovered alone while it was away);
//   - learner_out_of_step: it was a learner and its Keeper has not served for
//     learnerOutOfStep (removed by the holder for a role change, or lost).
func copyRejoinReason(selfID uint32, view map[uint32]keeperEntry, wasLearner bool, notServing time.Duration,
	voters, learners []KeeperServer, manual bool) string {
	desired := selfRole(selfID, voters, learners)
	if view != nil {
		own, in := view[selfID]
		if in && own.learner && desired == RoleVoter {
			return "promoted"
		}
		if in && !own.learner && desired == RoleLearner && manual {
			for _, voter := range voters {
				if entry, ok := view[voter.ID]; ok && !entry.learner {
					return ""
				}
			}
			return "diverged"
		}
		return ""
	}
	if wasLearner && notServing >= learnerOutOfStep {
		return "learner_out_of_step"
	}
	return ""
}
