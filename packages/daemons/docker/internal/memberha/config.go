package memberha

import (
	"errors"
	"fmt"
	"regexp"
)

// Modes of a set.
const (
	ModeAutomatic = "automatic"
	ModeManual    = "manual"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Peer is one member of the set as this node knows it.
type Peer struct {
	MemberID    string `json:"memberId"`
	NodeID      string `json:"nodeId"`
	MemberIndex uint32 `json:"memberIndex"`
	Priority    int32  `json:"priority"`
	Removing    bool   `json:"removing,omitempty"`
}

// Assignment is a manual pair's primary assignment: Gateway names the primary
// under a generation that grows with every switch.
type Assignment struct {
	PrimaryMemberID string `json:"primaryMemberId"`
	Generation      uint64 `json:"generation"`
	// SigningKeyID and Signature: Gateway signs every assignment with its
	// relay policy key (AssignmentStatement); a member accepts one, from
	// Gateway or from its peer, only once Deps.VerifyAssignment verified it.
	SigningKeyID string `json:"signingKeyId,omitempty"`
	Signature    []byte `json:"signature,omitempty"`
}

// Config is what Gateway configures for this node's member of one set.
type Config struct {
	SetID     string `json:"setId"`
	MemberID  string `json:"memberId"`
	NodeID    string `json:"nodeId"`
	Engine    string `json:"engine"`
	OwnerKind string `json:"ownerKind"`
	OwnerID   string `json:"ownerId"`
	Mode      string `json:"mode"`
	// LeasePolicyID is the set's lease policy (automatic mode).
	LeasePolicyID string `json:"leasePolicyId,omitempty"`
	Durability    string `json:"durability,omitempty"`
	// SyncDegradeAfterSeconds and MaxLagBytes: engine durability settings.
	SyncDegradeAfterSeconds uint32 `json:"syncDegradeAfterSeconds,omitempty"`
	MaxLagBytes             uint64 `json:"maxLagBytes,omitempty"`
	Members                 []Peer `json:"members"`
	ConfigRevision          uint64 `json:"configRevision"`
	// EngineConfig is the engine's own configuration (opaque here).
	EngineConfig []byte `json:"engineConfig,omitempty"`
	// PublishedPort is the member proxy's port (direct publication); 0: none.
	PublishedPort uint32 `json:"publishedPort,omitempty"`
}

// Key is the lease key of the set's primary role (slot 0).
func (c Config) Key() Key { return Key{PolicyID: c.LeasePolicyID, Slot: 0} }

// Validate checks what the runtime relies on.
func (c Config) Validate() error {
	if !uuidPattern.MatchString(c.SetID) || !uuidPattern.MatchString(c.MemberID) {
		return errors.New("availability member set and member ids must be UUIDs")
	}
	if c.NodeID == "" || c.Engine == "" {
		return errors.New("availability member node and engine are required")
	}
	switch c.Mode {
	case ModeAutomatic:
		if !uuidPattern.MatchString(c.LeasePolicyID) {
			return errors.New("an automatic availability member needs its set's lease policy")
		}
	case ModeManual:
		if c.LeasePolicyID != "" {
			return errors.New("a manual availability member has no lease policy")
		}
	default:
		return fmt.Errorf("unknown availability mode %q", c.Mode)
	}
	if _, ok := c.Peer(c.MemberID); !ok {
		return errors.New("the member must be listed among the set's members")
	}
	return nil
}

// Peer returns the member with memberID.
func (c Config) Peer(memberID string) (Peer, bool) {
	for _, peer := range c.Members {
		if peer.MemberID == memberID {
			return peer, true
		}
	}
	return Peer{}, false
}

// PeerByNode returns the member on nodeID.
func (c Config) PeerByNode(nodeID string) (Peer, bool) {
	for _, peer := range c.Members {
		if peer.NodeID == nodeID {
			return peer, true
		}
	}
	return Peer{}, false
}

// Others are the other members, removing ones included.
func (c Config) Others() []Peer {
	out := make([]Peer, 0, len(c.Members))
	for _, peer := range c.Members {
		if peer.MemberID != c.MemberID {
			out = append(out, peer)
		}
	}
	return out
}
