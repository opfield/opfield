package chha

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Eligibility limits (decision 12).
const (
	// MaxEligibleDelay: a copy whose replicas are further behind than this
	// (system.replicas.absolute_delay) is not eligible.
	MaxEligibleDelay = 10 * time.Second
	// restoreStable: the copies must stay active this long before the holder
	// restores quorum 2 and certifies the set healthy again.
	restoreStable       = 10 * time.Second
	defaultDegradeAfter = 10 * time.Second
)

// Value is the ClickHouse state certified in the lease (v3 holder value).
type Value struct {
	V int `json:"v"`
	// Quorum is the insert quorum the holder runs (2 synchronous and
	// healthy, 1 asynchronous or degraded).
	Quorum int `json:"quorum"`
	// Degraded: a synchronous set lost its quorum copy; acknowledged inserts
	// may exist on the holder only, so no copy is eligible.
	Degraded bool `json:"degraded"`
	// DegradedSinceMs is the wall time (unix ms) the holder certified it.
	DegradedSinceMs int64 `json:"degradedSinceMs,omitempty"`
}

// DecodeValue reads a certified value; an empty value is the zero value.
func DecodeValue(raw []byte) (Value, error) {
	var v Value
	if len(raw) == 0 {
		return v, nil
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, err
	}
	if v.V != 1 {
		return v, errors.New("unknown ClickHouse certified value version")
	}
	return v, nil
}

func (v Value) encode() ([]byte, error) {
	v.V = 1
	if v.Quorum < 1 {
		v.Quorum = 1
	}
	return json.Marshal(v)
}

// Engine status fields the value logic reads (Position keys).
const (
	posQuorum         = "insertQuorum"
	posMinActive      = "minActiveReplicas"
	posTables         = "replicatedTables"
	posReadonly       = "readonlyTables"
	posDelay          = "maxAbsoluteDelaySeconds"
	posKeeper         = "keeperMode"
	posKeeperVoters   = "keeperVoters"
	posDatabasesLate  = "databasesSyncing"
	posActivated      = "activatedWitness"
	posConvert        = "convert"
	posKeeperLearners = "keeperLearners"
	posRecovery       = "keeperRecovery"
	posRejoin         = "keeperRejoin"
)

// sample is the parsed engine status the value logic uses.
type sample struct {
	quorum       int
	minActive    int
	tables       int
	readonly     int
	delay        time.Duration
	keeperQuorum bool
	keeperMode   string
	dbSyncing    bool
}

// policy is the durability of the member's set.
type policy struct {
	synchronous  bool
	degradeAfter time.Duration
	members      int
}

func policyOf(config memberha.Config) policy {
	p := policy{synchronous: config.Durability == "synchronous", degradeAfter: defaultDegradeAfter}
	if config.SyncDegradeAfterSeconds > 0 {
		p.degradeAfter = time.Duration(config.SyncDegradeAfterSeconds) * time.Second
	}
	for _, peer := range config.Members {
		if !peer.Removing {
			p.members++
		}
	}
	return p
}

// wantQuorum is the insert quorum of a healthy set.
func (p policy) wantQuorum() int {
	if p.synchronous && p.members >= 2 {
		return 2
	}
	return 1
}

// copiesActive: enough replicas have a live Keeper session for the healthy
// quorum (a set without replicated tables has nothing to wait for).
func (s sample) copiesActive(p policy) bool {
	return s.tables == 0 || s.minActive >= p.wantQuorum()
}

// eligible decides whether a copy may take the primary role over under the
// certified value (decision 12): its Keeper has quorum, no replicated table
// is read-only, its replicas are at most MaxEligibleDelay behind, its
// databases have every table, and a synchronous set is not degraded (unless
// this node certified that state itself: it holds every acknowledged insert).
func eligible(p policy, value Value, certifiedByMe bool, s sample) (bool, string) {
	switch {
	case !s.keeperQuorum:
		return false, "keeper_no_quorum"
	case s.readonly > 0:
		return false, "replicas_readonly"
	case s.dbSyncing:
		return false, "databases_syncing"
	case s.delay > MaxEligibleDelay:
		return false, "replication_delay"
	case p.synchronous && value.Degraded && !certifiedByMe:
		return false, "degraded"
	}
	return true, ""
}

// degradeTracker remembers since when the copies are inactive or active
// again (holder side, for NextValue).
type degradeTracker struct {
	inactiveSince time.Duration
	activeSince   time.Duration
}

// next is the holder's steady-state change of the certified value (AS5
// order): the degraded state is certified before the engine falls back to
// quorum 1; quorum 2 runs in the engine (status) before healthy is
// certified again.
func (t *degradeTracker) next(p policy, value Value, s sample, now time.Duration, wall time.Time) (Value, string, bool) {
	active := s.copiesActive(p)
	if active {
		t.inactiveSince = 0
		if t.activeSince == 0 {
			t.activeSince = now
		}
	} else {
		t.activeSince = 0
		if t.inactiveSince == 0 {
			t.inactiveSince = now
		}
	}
	want := p.wantQuorum()
	switch {
	case !p.synchronous || want == 1:
		if value.Quorum != 1 || value.Degraded {
			return Value{Quorum: 1}, "asynchronous", true
		}
	case !value.Degraded && !active && now-t.inactiveSince >= p.degradeAfter:
		return Value{Quorum: 1, Degraded: true, DegradedSinceMs: wall.UnixMilli()}, "degraded", true
	case value.Degraded && active && now-t.activeSince >= restoreStable && s.quorum >= want:
		return Value{Quorum: want}, "restored", true
	case !value.Degraded && value.Quorum != want:
		return Value{Quorum: want}, "quorum", true
	}
	return value, "", false
}

// engineQuorum is the insert quorum the holder's engine must run under the
// certified value: degraded → 1, except while the copies are active again
// and the holder prepares the restore (quorum 2 first, then healthy).
func engineQuorum(p policy, value Value, s sample, activeFor time.Duration) int {
	want := p.wantQuorum()
	if want == 1 {
		return 1
	}
	if !value.Degraded {
		return want
	}
	if s.copiesActive(p) && activeFor >= restoreStable/2 {
		return want
	}
	return 1
}
