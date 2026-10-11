package pgha

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
)

// Durability of a replicated database (S1).
const (
	DurabilitySynchronous  = "synchronous"
	DurabilityAsynchronous = "asynchronous"
)

// ValueVersion is the schema of the certified application value.
const ValueVersion = 1

// maxValueBytes mirrors availabilitylease.MaxStateValueBytes.
const maxValueBytes = 1024

// Value is the database part of the lease holder state: what a quorum of
// voters certified about the primary role. Every eligibility decision of a
// candidate rests on the Value of the highest KNOWN accepted ballot (AS1, AS2),
// never on a member's own Postgres configuration.
type Value struct {
	Version int `json:"v"`
	// Timeline and SwitchLSN name the certified timeline and the LSN where it
	// branched off its parent (M3). SwitchLSN is 0 for timeline 1 or when the
	// timeline predates HA (bootstrap).
	Timeline  uint32 `json:"tl"`
	SwitchLSN LSN    `json:"sw,omitempty"`
	// ParentTimeline is the timeline the certified one branched off at
	// SwitchLSN (0 for timeline 1 or when unknown).
	ParentTimeline uint32 `json:"ptl,omitempty"`
	// Durability is synchronous or asynchronous (S1).
	Durability string `json:"d"`
	// SyncSet lists the members (application_name = member id) that
	// acknowledged every commit the holder acknowledged (AS5). Sorted. The
	// holder itself is never in the set once it promoted.
	SyncSet []string `json:"s,omitempty"`
	// Degraded: synchronous durability with an empty SyncSet while another
	// member exists (R1.7).
	Degraded bool `json:"dg,omitempty"`
	// EligibilityFloor is the primary flush LSN certified after a cancelled
	// or terminated synchronous wait (AS4): a sync member is eligible only
	// while its flush is at or above it.
	EligibilityFloor LSN `json:"ef,omitempty"`
	// ProgressFloor is the coarse certified primary flush LSN of asynchronous
	// durability (AS7).
	ProgressFloor LSN `json:"pf,omitempty"`
	// Final is set by a planned switchover once the old primary stopped taking
	// writes (AS11).
	Final *Final `json:"fin,omitempty"`
	// Forced records the last forced promotion (AS10), for reports and audit.
	Forced *Forced `json:"fr,omitempty"`
	// SystemID is the database cluster's system identifier, certified by the
	// holder: a member whose cluster has another one never takes over.
	SystemID string `json:"sid,omitempty"`
}

// Final is the designated successor of a planned switchover and the LSN it
// must have replayed before it acquires (AS11).
type Final struct {
	Successor string `json:"m"`
	LSN       LSN    `json:"l"`
	Operation string `json:"o,omitempty"`
}

// Forced is the certified record of a forced promotion (AS10).
type Forced struct {
	Operation string `json:"o"`
	Timeline  uint32 `json:"tl"`
	ForkLSN   LSN    `json:"l"`
	AtUnixMs  int64  `json:"at,omitempty"`
	// Promoted: the forced holder certified its promotion; Timeline and
	// ForkLSN name the timeline it promoted to and its switch point.
	Promoted bool `json:"pr,omitempty"`
}

// Synchronous reports synchronous durability.
func (v Value) Synchronous() bool { return v.Durability != DurabilityAsynchronous }

// InSyncSet reports whether member is in the certified SyncSet.
func (v Value) InSyncSet(member string) bool { return slices.Contains(v.SyncSet, member) }

// Clone returns a deep copy.
func (v Value) Clone() Value {
	out := v
	out.SyncSet = slices.Clone(v.SyncSet)
	if v.Final != nil {
		final := *v.Final
		out.Final = &final
	}
	if v.Forced != nil {
		forced := *v.Forced
		out.Forced = &forced
	}
	return out
}

// WithSyncSet returns a copy with the set replaced (sorted, deduplicated).
func (v Value) WithSyncSet(members []string) Value {
	out := v.Clone()
	out.SyncSet = normalizeSet(members)
	return out
}

func normalizeSet(members []string) []string {
	if len(members) == 0 {
		return nil
	}
	out := slices.Clone(members)
	sort.Strings(out)
	return slices.Compact(out)
}

// Encode returns the canonical bytes of v (the library hashes them).
func (v Value) Encode() ([]byte, error) {
	v.Version = ValueVersion
	v.SyncSet = normalizeSet(v.SyncSet)
	if v.Durability == "" {
		v.Durability = DurabilitySynchronous
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(data) > maxValueBytes {
		return nil, fmt.Errorf("database HA state is %d bytes, above the %d byte limit", len(data), maxValueBytes)
	}
	return data, nil
}

// DecodeValue reads a certified value. Empty input is an error: a stateful
// key without a value is never evidence of anything.
func DecodeValue(data []byte) (Value, error) {
	if len(data) == 0 {
		return Value{}, errors.New("database HA state is empty")
	}
	var v Value
	if err := json.Unmarshal(data, &v); err != nil {
		return Value{}, fmt.Errorf("decode database HA state: %w", err)
	}
	if v.Version != ValueVersion {
		return Value{}, fmt.Errorf("database HA state version %d is not supported", v.Version)
	}
	if v.Durability != DurabilitySynchronous && v.Durability != DurabilityAsynchronous {
		return Value{}, fmt.Errorf("database HA state has unknown durability %q", v.Durability)
	}
	return v, nil
}

// Equal compares two values by their canonical encoding.
func (v Value) Equal(other Value) bool {
	a, errA := v.Encode()
	b, errB := other.Encode()
	return errA == nil && errB == nil && string(a) == string(b)
}
