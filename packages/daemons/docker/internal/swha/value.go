package swha

import (
	"encoding/json"
	"errors"
	"time"
)

// Value is the certified state of a SeaweedFS set (lease v3 holder value).
type Value struct {
	V int `json:"v"`
	// MaxVolumeID is the highest volume id the primary's master handed out.
	MaxVolumeID uint32 `json:"maxVolumeId"`
	// MetaProgressNs is the primary's metadata heartbeat (its wall clock, ns)
	// at certification: a copy whose filer has a heartbeat within
	// metaTolerance of it is eligible.
	MetaProgressNs int64 `json:"metaProgressNs"`
	// DegradedSince (unix ms) is set while new objects are written with one
	// copy because a volume server was lost; 0 when every member is back and
	// the replication was repaired.
	DegradedSince int64 `json:"degradedSince,omitempty"`
}

const valueVersion = 1

// metaTolerance is how far a copy's metadata may be behind the certified
// progress and still take over (decision 5: about 1 s of metadata).
const metaTolerance = time.Second

func decodeValue(raw []byte) (Value, error) {
	if len(raw) == 0 {
		return Value{}, errors.New("no certified SeaweedFS state")
	}
	var value Value
	if err := json.Unmarshal(raw, &value); err != nil {
		return Value{}, err
	}
	if value.V != valueVersion {
		return Value{}, errors.New("unknown certified SeaweedFS state version")
	}
	return value, nil
}

func (v Value) encode() ([]byte, error) {
	v.V = valueVersion
	return json.Marshal(v)
}
