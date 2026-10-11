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

// keeperConfigQuery reads the Keeper's replicated cluster configuration.
const keeperConfigQuery = `SELECT value FROM system.zookeeper WHERE path = '/keeper' AND name = 'config' FORMAT TabSeparatedRaw`

// parseKeeperConfig reads "server.<id>=<host>:<port>;<role>;<priority>" lines.
func parseKeeperConfig(text string) (map[uint32]string, error) {
	out := map[uint32]string{}
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
		endpoint, _, _ := strings.Cut(value, ";")
		out[uint32(id)] = endpoint
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the Keeper configuration lists no server")
	}
	return out, nil
}

func voterList(current map[uint32]string) string {
	ids := make([]int, 0, len(current))
	for id := range current {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(id)
	}
	return strings.Join(parts, ",")
}

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
// voters, at most one per call: a missing voter is added as soon as it is
// reachable (a joining Keeper that is not in the leader's configuration stops
// within seconds, P0-T02 item 7); a server that is not desired is removed
// only once every desired voter is in the configuration and settled, never
// this member's own Keeper.
func planKeeper(selfID uint32, current map[uint32]string, desired []KeeperServer, reachable func(KeeperServer) bool,
	since map[uint32]time.Duration, now time.Duration) (keeperAction, bool) {
	missing := false
	for _, voter := range desired {
		if _, ok := current[voter.ID]; ok {
			continue
		}
		missing = true
		if reachable(voter) {
			add := voter
			return keeperAction{add: &add}, true
		}
	}
	if missing {
		return keeperAction{}, false
	}
	for _, voter := range desired {
		at, ok := since[voter.ID]
		if !ok || now-at < settleAfterAdd {
			return keeperAction{}, false
		}
	}
	wanted := map[uint32]bool{}
	for _, voter := range desired {
		wanted[voter.ID] = true
	}
	ids := make([]int, 0, len(current))
	for id := range current {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	for _, id := range ids {
		if uint32(id) == selfID || wanted[uint32(id)] {
			continue
		}
		if len(current) <= 1 {
			break
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
