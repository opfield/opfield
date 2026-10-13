package pgha

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

var rolePattern = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// Defaults of the durability settings (plan decision 4).
const (
	DefaultMaxLagBytes      = 1 << 20
	DefaultSyncDegradeAfter = 10 * time.Second
	minSyncDegradeAfter     = 2 * time.Second
	maxSyncDegradeAfter     = 10 * time.Minute
)

// Parameters are the Postgres settings the daemon owns identically on every
// member (M4). Zero keeps the image default.
type Parameters struct {
	MaxConnections          int   `json:"maxConnections,omitempty"`
	MaxWalSenders           int   `json:"maxWalSenders,omitempty"`
	MaxReplicationSlots     int   `json:"maxReplicationSlots,omitempty"`
	MaxWorkerProcesses      int   `json:"maxWorkerProcesses,omitempty"`
	MaxPreparedTransactions int   `json:"maxPreparedTransactions,omitempty"`
	MaxLocksPerTransaction  int   `json:"maxLocksPerTransaction,omitempty"`
	MaxSlotWalKeepSizeMB    int64 `json:"maxSlotWalKeepSizeMb,omitempty"`
}

// EngineConfig is the Postgres part of a member's configuration
// (AvailabilityMemberConfig.engine_config, JSON).
type EngineConfig struct {
	// ReplicationRoles maps every member id to its own REPLICATION role
	// (M6: one role per member, matched with application_name).
	ReplicationRoles map[string]string `json:"replicationRoles"`
	// RewindRole is the set's pg_rewind role (no superuser).
	RewindRole string     `json:"rewindRole"`
	Parameters Parameters `json:"parameters,omitempty"`
	// ReplicationPassword and RewindPassword are this member's secrets for
	// its passfile (it streams, rewinds and rebuilds while Gateway is down).
	ReplicationPassword string `json:"replicationPassword,omitempty"`
	RewindPassword      string `json:"rewindPassword,omitempty"`
	// Identities are the HA principals the primary converges (every
	// member's replication role with its password, the rewind role); every
	// member carries them so a new primary converges them too.
	Identities *Identities `json:"identities,omitempty"`
}

// Identities are the HA principals the primary maintains (M6).
type Identities struct {
	// Replication maps every replication role to its password.
	Replication    map[string]string `json:"replication"`
	RemoveRoles    []string          `json:"removeRoles,omitempty"`
	RewindRole     string            `json:"rewindRole"`
	RewindPassword string            `json:"rewindPassword,omitempty"`
}

// Hash identifies identities for the holder's "applied" bookkeeping.
func (i *Identities) Hash() string {
	if i == nil {
		return ""
	}
	data, _ := json.Marshal(i)
	return string(data)
}

// Peer is one member of the set as Postgres needs it.
type Peer struct {
	MemberID        string
	NodeID          string
	Priority        int32
	MemberIndex     uint32
	ReplicationRole string
	Removing        bool
}

// Config is a member's configuration: the runtime's and the engine's.
type Config struct {
	SetID      string
	MemberID   string
	NodeID     string
	DatabaseID string
	Mode       string
	// Durability is synchronous or asynchronous.
	Durability              string
	MaxLagBytes             uint64
	SyncDegradeAfterSeconds uint32
	Members                 []Peer
	Engine                  EngineConfig
}

// ParseConfig reads a member configuration for the Postgres engine.
func ParseConfig(config memberha.Config) (Config, error) {
	var engine EngineConfig
	if len(config.EngineConfig) == 0 {
		return Config{}, errors.New("a Postgres availability member needs its engine configuration")
	}
	if err := json.Unmarshal(config.EngineConfig, &engine); err != nil {
		return Config{}, fmt.Errorf("parse the Postgres member configuration: %w", err)
	}
	out := Config{SetID: config.SetID, MemberID: config.MemberID, NodeID: config.NodeID, DatabaseID: config.OwnerID,
		Mode: config.Mode, Durability: config.Durability, MaxLagBytes: config.MaxLagBytes,
		SyncDegradeAfterSeconds: config.SyncDegradeAfterSeconds, Engine: engine}
	if out.Durability == "" {
		out.Durability = DurabilitySynchronous
	}
	for _, peer := range config.Members {
		out.Members = append(out.Members, Peer{MemberID: peer.MemberID, NodeID: peer.NodeID, Priority: peer.Priority,
			MemberIndex: peer.MemberIndex, ReplicationRole: engine.ReplicationRoles[peer.MemberID], Removing: peer.Removing})
	}
	return out, out.Validate()
}

// Validate checks what the engine relies on.
func (c Config) Validate() error {
	switch {
	case c.DatabaseID == "":
		return errors.New("the member's database id is required")
	case c.Durability != DurabilitySynchronous && c.Durability != DurabilityAsynchronous:
		return fmt.Errorf("durability %q is invalid", c.Durability)
	case c.SyncDegradeAfterSeconds != 0 && (time.Duration(c.SyncDegradeAfterSeconds)*time.Second < minSyncDegradeAfter ||
		time.Duration(c.SyncDegradeAfterSeconds)*time.Second > maxSyncDegradeAfter):
		return errors.New("syncDegradeAfterSeconds is out of range")
	case !rolePattern.MatchString(c.Engine.RewindRole):
		return errors.New("the rewind role name is invalid")
	}
	seen := map[string]bool{c.Engine.RewindRole: true}
	for _, peer := range c.Members {
		if !rolePattern.MatchString(peer.ReplicationRole) {
			return fmt.Errorf("the replication role of member %s is missing or invalid", peer.MemberID)
		}
		if seen[peer.ReplicationRole] {
			// M6: one REPLICATION role per member.
			return errors.New("replication roles must be distinct per member")
		}
		seen[peer.ReplicationRole] = true
	}
	if _, ok := c.Peer(c.MemberID); !ok {
		return errors.New("the member is not in its member list")
	}
	p := c.Engine.Parameters
	for _, value := range []int{p.MaxConnections, p.MaxWalSenders, p.MaxReplicationSlots, p.MaxWorkerProcesses, p.MaxPreparedTransactions, p.MaxLocksPerTransaction} {
		if value < 0 || value > 100000 {
			return errors.New("a Postgres parameter is out of range")
		}
	}
	if p.MaxSlotWalKeepSizeMB < 0 {
		return errors.New("maxSlotWalKeepSizeMb cannot be negative")
	}
	if id := c.Engine.Identities; id != nil {
		for role := range id.Replication {
			if !rolePattern.MatchString(role) {
				return fmt.Errorf("replication role %q is invalid", role)
			}
		}
		for _, role := range id.RemoveRoles {
			if !rolePattern.MatchString(role) {
				return fmt.Errorf("role %q is invalid", role)
			}
		}
		if id.RewindRole != "" && !rolePattern.MatchString(id.RewindRole) {
			return errors.New("the identities' rewind role is invalid")
		}
	}
	return nil
}

// SyncDegradeAfter is the stall bound before a sync member is dropped.
func (c Config) SyncDegradeAfter() time.Duration {
	if c.SyncDegradeAfterSeconds == 0 {
		return DefaultSyncDegradeAfter
	}
	return time.Duration(c.SyncDegradeAfterSeconds) * time.Second
}

// MaxLag is the asynchronous loss bound as an LSN distance.
func (c Config) MaxLag() LSN {
	if c.MaxLagBytes == 0 {
		return DefaultMaxLagBytes
	}
	return LSN(c.MaxLagBytes)
}

// Self is this member's entry.
func (c Config) Self() Peer {
	peer, _ := c.Peer(c.MemberID)
	return peer
}

// Peer finds a member by id.
func (c Config) Peer(memberID string) (Peer, bool) {
	for _, peer := range c.Members {
		if peer.MemberID == memberID {
			return peer, true
		}
	}
	return Peer{}, false
}

// Others are the other members, best sync candidates first: higher
// priority, then lower member index (the lease candidates' order).
func (c Config) Others() []Peer {
	var out []Peer
	for _, peer := range c.Members {
		if peer.MemberID != c.MemberID {
			out = append(out, peer)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Priority != out[j].Priority {
			return out[i].Priority > out[j].Priority
		}
		if out[i].MemberIndex != out[j].MemberIndex {
			return out[i].MemberIndex < out[j].MemberIndex
		}
		return out[i].MemberID < out[j].MemberID
	})
	return out
}

// ActiveOthers are Others without members being removed.
func (c Config) ActiveOthers() []Peer {
	var out []Peer
	for _, peer := range c.Others() {
		if !peer.Removing {
			out = append(out, peer)
		}
	}
	return out
}

// StandbyConfig is what the member writes before every start.
func (c Config) StandbyConfig() StandbyConfig {
	self := c.Self()
	return StandbyConfig{MemberID: c.MemberID, ReplicationRole: self.ReplicationRole, SlotName: SlotName(c.MemberID),
		Parameters: c.Engine.Parameters}
}

// SlotName is the physical replication slot of a member on the primary.
func SlotName(memberID string) string {
	cleaned := strings.ToLower(strings.ReplaceAll(memberID, "-", ""))
	var b strings.Builder
	for _, r := range cleaned {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		}
	}
	name := "gw_ha_" + b.String()
	if len(name) > 63 {
		name = name[:63]
	}
	return name
}

func slotNames(peers []Peer) []string {
	out := make([]string, 0, len(peers))
	for _, peer := range peers {
		out = append(out, SlotName(peer.MemberID))
	}
	sort.Strings(out)
	return out
}
