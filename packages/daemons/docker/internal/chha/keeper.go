package chha

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Keeper membership timings (decision 8, P0-T02 item 7).
const (
	// settleAfterAdd: a server added by reconfig must be in the configuration
	// this long before a leaving server is removed (a new witness followed in
	// 4-15 s in the prototype).
	settleAfterAdd = 15 * time.Second
	// witnessDeadFor: an active witness unreachable this long is replaced.
	witnessDeadFor = 2 * time.Minute
	// gatewayDownFor: the holder activates a standby witness itself only when
	// the Gateway session is down at least this long (Gateway re-places
	// witnesses itself when it is up).
	gatewayDownFor = 30 * time.Second
)

// KeeperClientCommand is the clickhouse keeper-client invocation of one
// command against the member's own Keeper. A short connection timeout keeps a
// pass short while the Keeper serves no session (a learner without its
// leader is retried for the default 10 s per attempt).
func KeeperClientCommand(command string) []string {
	return []string{"clickhouse", "keeper-client", "--host", "127.0.0.1", "--port", strconv.Itoa(KeeperClientPort),
		"--connection-timeout=3", "--query", command}
}

// KeeperClientFailed reports a keeper-client error printed with exit status 0
// (a refused reconfig prints "Coordination error: Bad arguments").
func KeeperClientFailed(output string) bool {
	for _, marker := range []string{"Coordination::Exception", "Coordination error", "Syntax error", "DB::Exception"} {
		if strings.Contains(output, marker) {
			return true
		}
	}
	return false
}

// keeperConfigCommand reads the Keeper's replicated cluster configuration
// (system.zookeeper does not list the virtual /keeper/config node).
const keeperConfigCommand = "get '/keeper/config'"

// Non-holders refresh the Keeper configuration they report this often; the
// holder reads it every pass.
const copyKeeperConfigPeriod = 30 * time.Second

// reconfigSettle: no reconfiguration follows another this soon.
const reconfigSettle = 5 * time.Second

// leadershipRequestPeriod bounds the holder's Keeper leadership requests.
const leadershipRequestPeriod = time.Minute

// keeperEntry is one server of the Keeper's cluster configuration.
type keeperEntry struct {
	endpoint string
	learner  bool
}

// parseKeeperConfig reads "server.<id>=<host>:<port>;<role>;<priority>" lines.
func parseKeeperConfig(text string) (map[uint32]keeperEntry, error) {
	out := map[uint32]keeperEntry{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || !strings.HasPrefix(key, "server.") {
			continue
		}
		id, err := strconv.ParseUint(strings.TrimPrefix(key, "server."), 10, 32)
		if err != nil || id == 0 {
			return nil, fmt.Errorf("unexpected Keeper configuration line %q", line)
		}
		parts := strings.Split(value, ";")
		out[uint32(id)] = keeperEntry{endpoint: parts[0], learner: len(parts) > 1 && parts[1] == "learner"}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the Keeper configuration lists no server")
	}
	return out, nil
}

// idList lists the ids of the voters (learner=false) or learners.
func idList(current map[uint32]keeperEntry, learners bool) string {
	ids := make([]int, 0, len(current))
	for id, entry := range current {
		if entry.learner == learners {
			ids = append(ids, int(id))
		}
	}
	sort.Ints(ids)
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(id)
	}
	return strings.Join(parts, ",")
}

func voterList(current map[uint32]keeperEntry) string { return idList(current, false) }

// activation is a standby witness the holder activated while Gateway was
// down, kept in the member's data mount until Gateway's configuration names
// the standby a voter (or no longer names the replaced witness one).
type activation struct {
	StandbyID        uint32 `json:"standbyId"`
	StandbyWitnessID string `json:"standbyWitnessId"`
	ReplacesID       uint32 `json:"replacesId"`
	ReplacesWitness  string `json:"replacesWitnessId"`
	AtUnixMs         int64  `json:"atUnixMs"`
}

const activationFile = "gateway-availability-keeper.json"

func decodeActivation(raw []byte) (*activation, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var a activation
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	if a.StandbyID == 0 {
		return nil, nil
	}
	return &a, nil
}

// adopted: Gateway's configuration caught up with the activation.
func (a *activation) adopted(ec EngineConfig) bool {
	if a == nil {
		return true
	}
	standby, hasStandby := ec.Server(a.StandbyID)
	replaced, hasReplaced := ec.Server(a.ReplacesID)
	return (hasStandby && standby.Role == RoleVoter) || !hasReplaced || replaced.Role != RoleVoter
}

// desiredVoters are Gateway's voters with a pending local activation applied.
func desiredVoters(ec EngineConfig, act *activation) []KeeperServer {
	voters := ec.Voters()
	if act == nil || act.adopted(ec) {
		return voters
	}
	out := make([]KeeperServer, 0, len(voters)+1)
	for _, voter := range voters {
		if voter.ID != act.ReplacesID {
			out = append(out, voter)
		}
	}
	if standby, ok := ec.Server(act.StandbyID); ok {
		standby.Role = RoleVoter
		out = append(out, standby)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// keeperAction is one reconfiguration step of the holder.
type keeperAction struct {
	add    *KeeperServer
	remove uint32
}

func (a keeperAction) command(ec EngineConfig) string {
	if a.add != nil {
		return "reconfig add '" + ec.ReconfigEntry(*a.add) + "'"
	}
	return "reconfig remove '" + strconv.FormatUint(uint64(a.remove), 10) + "'"
}

// planKeeper is the holder's next reconfiguration step toward the desired
// voters and learners, at most one per call:
//   - a missing server is added as soon as it is reachable (a joining Keeper
//     that is not in the leader's configuration stops within seconds, P0-T02
//     item 7), unless it was removed and has not been down since (it must come
//     back with a wiped Keeper state);
//   - a learner that must become a voter is removed first (its member wipes
//     its Keeper state and joins again; an in-place role change crashed Keeper
//     25.8); a voter is never demoted in place;
//   - a server that is not desired is removed only once every desired server
//     is in the configuration with its role and settled, never this member's
//     own Keeper nor the last voter.
func planKeeper(selfID uint32, current map[uint32]keeperEntry, voters, learners []KeeperServer,
	reachable func(KeeperServer) bool, blocked func(uint32) bool, since map[uint32]time.Duration,
	now time.Duration) (keeperAction, bool) {
	pending := false
	for _, voter := range voters {
		entry, ok := current[voter.ID]
		switch {
		case ok && !entry.learner:
			continue
		case ok && entry.learner && voter.ID != selfID:
			return keeperAction{remove: voter.ID}, true
		case ok:
			pending = true
			continue
		}
		pending = true
		if !blocked(voter.ID) && reachable(voter) {
			add := voter
			add.Role = RoleVoter
			return keeperAction{add: &add}, true
		}
	}
	for _, learner := range learners {
		if _, ok := current[learner.ID]; ok {
			continue
		}
		pending = true
		if !blocked(learner.ID) && reachable(learner) {
			add := learner
			return keeperAction{add: &add}, true
		}
	}
	if pending {
		return keeperAction{}, false
	}
	wanted := map[uint32]bool{}
	for _, server := range append(append([]KeeperServer(nil), voters...), learners...) {
		wanted[server.ID] = true
		at, ok := since[server.ID]
		if !ok || now-at < settleAfterAdd {
			return keeperAction{}, false
		}
	}
	ids := make([]int, 0, len(current))
	votersLeft := 0
	for id, entry := range current {
		ids = append(ids, int(id))
		if !entry.learner {
			votersLeft++
		}
	}
	sort.Ints(ids)
	for _, id := range ids {
		if uint32(id) == selfID || wanted[uint32(id)] {
			continue
		}
		if !current[uint32(id)].learner && votersLeft <= 1 {
			continue
		}
		return keeperAction{remove: uint32(id)}, true
	}
	return keeperAction{}, false
}

// activationDue decides the holder's Gateway-down activation of a standby
// witness (decision 8): Gateway down, the active witness dead for
// witnessDeadFor, this member's Keeper in the quorum (the two data Keepers),
// a standby named by Gateway, and nothing activated yet.
func activationDue(gatewayDown, witnessDown time.Duration, keeperQuorum bool, pending *activation, ec EngineConfig) bool {
	return pending == nil && gatewayDown >= gatewayDownFor && witnessDown >= witnessDeadFor && keeperQuorum &&
		len(standbys(ec)) > 0
}

func standbys(ec EngineConfig) []KeeperServer {
	out := []KeeperServer{}
	for _, server := range ec.KeeperServers {
		if server.Role == RoleStandby {
			out = append(out, server)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
