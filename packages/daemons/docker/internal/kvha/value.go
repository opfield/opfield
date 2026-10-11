package kvha

import (
	"encoding/json"
	"errors"
)

// Value is the certified state of a Valkey set (lease v3 holder value).
type Value struct {
	V int `json:"v"`
	// ReplID is the primary's replication id: a copy follows this primary's
	// history when its master_replid (or master_replid2) is it.
	ReplID string `json:"replid"`
	// OffsetFloor is the primary's replication offset at certification: a copy
	// whose offset is within maxLagBytes of it may take over.
	OffsetFloor int64 `json:"offsetFloor"`
	// Degraded: no copy followed the primary for a while.
	Degraded bool `json:"degraded,omitempty"`
}

const valueVersion = 1

func decodeValue(raw []byte) (Value, error) {
	if len(raw) == 0 {
		return Value{}, errors.New("no certified Valkey state")
	}
	var value Value
	if err := json.Unmarshal(raw, &value); err != nil {
		return Value{}, err
	}
	if value.V != valueVersion {
		return Value{}, errors.New("unknown certified Valkey state version")
	}
	return value, nil
}

func (v Value) encode() ([]byte, error) {
	v.V = valueVersion
	return json.Marshal(v)
}
