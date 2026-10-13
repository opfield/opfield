package handover

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/opfield/opfield/daemon-shared/relayresume"
	"google.golang.org/protobuf/encoding/protowire"
)

// The snapshot a daemon hands to its next process (format version 1, frozen
// like relayresume.SessionState): "GWLH", the version byte, a protobuf-encoded
// Snapshot, and the SHA-256 of everything before it. Fields are only ever
// added, and a reader skips the fields it does not know, so the release
// before and the release after read each other's snapshots: a rolled back
// binary takes over what the candidate it replaces never took.

const (
	snapshotMagic   = "GWLH"
	SnapshotVersion = 1
)

// Snapshot is what one handover hands to the next process.
type Snapshot struct {
	DaemonType  string
	FromVersion string
	CreatedAt   time.Time
	Items       []SnapshotItem
	// Tombstones of the target streams that ended: how a later RESUME of one
	// is answered (finished, not unknown).
	Tombstones []relayresume.Tombstone
}

// ItemKind is what a handed over item carries.
type ItemKind uint8

const (
	// KindSession: one local connection and its resumable relay stream.
	KindSession ItemKind = 1
	// KindPipe: two local connections the daemon copies between.
	KindPipe ItemKind = 2
)

// SnapshotItem is one handed over connection.
type SnapshotItem struct {
	Kind ItemKind
	// Conns names the keeper copies of the item's sockets (listenerkeep), and
	// Inodes the sockets they must be.
	Conns  []string
	Inodes []uint64
	Labels Labels
	// Session: the stream (relayresume.AppendSessionState encoding).
	Session []byte
	// Pipe: per direction (left to right, right to left) the bytes read and
	// not written yet, and whether it ended (its half-close passed on).
	Pending [2][]byte
	Done    [2]bool
}

// Field numbers. Never reuse or renumber one.
const (
	snapshotFieldDaemonType  = 1
	snapshotFieldFromVersion = 2
	snapshotFieldCreatedAt   = 3 // unix milliseconds
	snapshotFieldItem        = 4
	snapshotFieldTombstone   = 5

	tombFieldRouteID    = 1
	tombFieldSourceKind = 2
	tombFieldSourceID   = 3
	tombFieldSessionID  = 4
	tombFieldReject     = 5
	tombFieldExpires    = 6 // unix milliseconds

	itemFieldKind    = 1
	itemFieldConn    = 2
	itemFieldInode   = 3
	itemFieldLabel   = 4
	itemFieldSession = 5
	itemFieldPipe    = 6

	labelFieldKey   = 1
	labelFieldValue = 2

	pipeFieldPending = 1
	pipeFieldDone    = 2
)

// Encode writes the snapshot with its header and checksum.
func (s *Snapshot) Encode() []byte {
	size := len(snapshotMagic) + 1 + sha256.Size
	for i := range s.Items {
		size += len(s.Items[i].Session) + len(s.Items[i].Pending[0]) + len(s.Items[i].Pending[1]) + 256
	}
	buffer := make([]byte, 0, size)
	buffer = append(buffer, snapshotMagic...)
	buffer = append(buffer, SnapshotVersion)
	buffer = appendString(buffer, snapshotFieldDaemonType, s.DaemonType)
	buffer = appendString(buffer, snapshotFieldFromVersion, s.FromVersion)
	if !s.CreatedAt.IsZero() {
		buffer = protowire.AppendTag(buffer, snapshotFieldCreatedAt, protowire.VarintType)
		buffer = protowire.AppendVarint(buffer, uint64(s.CreatedAt.UnixMilli()))
	}
	for i := range s.Items {
		buffer = protowire.AppendTag(buffer, snapshotFieldItem, protowire.BytesType)
		buffer = protowire.AppendBytes(buffer, s.Items[i].encode())
	}
	for _, tomb := range s.Tombstones {
		var encoded []byte
		encoded = appendString(encoded, tombFieldRouteID, tomb.Key.RouteID)
		encoded = appendString(encoded, tombFieldSourceKind, tomb.Key.SourceKind)
		encoded = appendString(encoded, tombFieldSourceID, tomb.Key.SourceID)
		encoded = protowire.AppendTag(encoded, tombFieldSessionID, protowire.BytesType)
		encoded = protowire.AppendBytes(encoded, tomb.Key.SessionID[:])
		encoded = protowire.AppendTag(encoded, tombFieldReject, protowire.VarintType)
		encoded = protowire.AppendVarint(encoded, uint64(tomb.Reject))
		encoded = protowire.AppendTag(encoded, tombFieldExpires, protowire.VarintType)
		encoded = protowire.AppendVarint(encoded, uint64(tomb.Expires.UnixMilli()))
		buffer = protowire.AppendTag(buffer, snapshotFieldTombstone, protowire.BytesType)
		buffer = protowire.AppendBytes(buffer, encoded)
	}
	sum := sha256.Sum256(buffer)
	return append(buffer, sum[:]...)
}

// sizeEstimate bounds the item's encoding from above (Encode's estimate, with
// the labels).
func (item *SnapshotItem) sizeEstimate() int {
	size := len(item.Session) + len(item.Pending[0]) + len(item.Pending[1]) + 256
	for key, value := range item.Labels {
		size += len(key) + len(value) + 16
	}
	return size
}

func (item *SnapshotItem) encode() []byte {
	var buffer []byte
	buffer = protowire.AppendTag(buffer, itemFieldKind, protowire.VarintType)
	buffer = protowire.AppendVarint(buffer, uint64(item.Kind))
	for _, name := range item.Conns {
		buffer = appendString(buffer, itemFieldConn, name)
	}
	for _, inode := range item.Inodes {
		buffer = protowire.AppendTag(buffer, itemFieldInode, protowire.VarintType)
		buffer = protowire.AppendVarint(buffer, inode)
	}
	keys := make([]string, 0, len(item.Labels))
	for key := range item.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		var label []byte
		label = appendString(label, labelFieldKey, key)
		label = appendString(label, labelFieldValue, item.Labels[key])
		buffer = protowire.AppendTag(buffer, itemFieldLabel, protowire.BytesType)
		buffer = protowire.AppendBytes(buffer, label)
	}
	if len(item.Session) > 0 {
		buffer = protowire.AppendTag(buffer, itemFieldSession, protowire.BytesType)
		buffer = protowire.AppendBytes(buffer, item.Session)
	}
	if item.Kind == KindPipe {
		for d := range item.Pending {
			var direction []byte
			if len(item.Pending[d]) > 0 {
				direction = protowire.AppendTag(direction, pipeFieldPending, protowire.BytesType)
				direction = protowire.AppendBytes(direction, item.Pending[d])
			}
			if item.Done[d] {
				direction = protowire.AppendTag(direction, pipeFieldDone, protowire.VarintType)
				direction = protowire.AppendVarint(direction, 1)
			}
			buffer = protowire.AppendTag(buffer, itemFieldPipe, protowire.BytesType)
			buffer = protowire.AppendBytes(buffer, direction)
		}
	}
	return buffer
}

func appendString(buffer []byte, field protowire.Number, value string) []byte {
	if value == "" {
		return buffer
	}
	buffer = protowire.AppendTag(buffer, field, protowire.BytesType)
	return protowire.AppendString(buffer, value)
}

var errMalformedSnapshot = errors.New("handover: malformed snapshot")

// DecodeSnapshot reads a snapshot written by Encode (of this or another
// release of format version 1). Byte fields alias data.
func DecodeSnapshot(data []byte) (*Snapshot, error) {
	if len(data) < len(snapshotMagic)+1+sha256.Size || !bytes.Equal(data[:len(snapshotMagic)], []byte(snapshotMagic)) {
		return nil, errMalformedSnapshot
	}
	if version := data[len(snapshotMagic)]; version != SnapshotVersion {
		return nil, fmt.Errorf("handover: snapshot format version %d is not supported", version)
	}
	body, sum := data[:len(data)-sha256.Size], data[len(data)-sha256.Size:]
	if computed := sha256.Sum256(body); !bytes.Equal(computed[:], sum) {
		return nil, errors.New("handover: snapshot checksum does not match")
	}
	snapshot := &Snapshot{}
	err := eachField(body[len(snapshotMagic)+1:], func(field protowire.Number, kind protowire.Type, value uint64, raw []byte) error {
		switch field {
		case snapshotFieldDaemonType:
			snapshot.DaemonType = string(raw)
		case snapshotFieldFromVersion:
			snapshot.FromVersion = string(raw)
		case snapshotFieldCreatedAt:
			if value > 1<<62 {
				return errMalformedSnapshot
			}
			snapshot.CreatedAt = time.UnixMilli(int64(value))
		case snapshotFieldItem:
			item, err := decodeItem(raw)
			if err != nil {
				return err
			}
			snapshot.Items = append(snapshot.Items, *item)
		case snapshotFieldTombstone:
			tomb, err := decodeTombstone(raw)
			if err != nil {
				return err
			}
			snapshot.Tombstones = append(snapshot.Tombstones, tomb)
		}
		return nil
	}, map[protowire.Number]protowire.Type{snapshotFieldDaemonType: protowire.BytesType, snapshotFieldFromVersion: protowire.BytesType,
		snapshotFieldCreatedAt: protowire.VarintType, snapshotFieldItem: protowire.BytesType, snapshotFieldTombstone: protowire.BytesType})
	if err != nil {
		return nil, err
	}
	return snapshot, nil
}

func decodeTombstone(data []byte) (relayresume.Tombstone, error) {
	var tomb relayresume.Tombstone
	sessionID := false
	err := eachField(data, func(field protowire.Number, _ protowire.Type, value uint64, raw []byte) error {
		switch field {
		case tombFieldRouteID:
			tomb.Key.RouteID = string(raw)
		case tombFieldSourceKind:
			tomb.Key.SourceKind = string(raw)
		case tombFieldSourceID:
			tomb.Key.SourceID = string(raw)
		case tombFieldSessionID:
			if len(raw) != len(tomb.Key.SessionID) {
				return errMalformedSnapshot
			}
			copy(tomb.Key.SessionID[:], raw)
			sessionID = true
		case tombFieldReject:
			if value > 255 {
				return errMalformedSnapshot
			}
			tomb.Reject = byte(value)
		case tombFieldExpires:
			if value > 1<<62 {
				return errMalformedSnapshot
			}
			tomb.Expires = time.UnixMilli(int64(value))
		}
		return nil
	}, map[protowire.Number]protowire.Type{tombFieldRouteID: protowire.BytesType, tombFieldSourceKind: protowire.BytesType,
		tombFieldSourceID: protowire.BytesType, tombFieldSessionID: protowire.BytesType, tombFieldReject: protowire.VarintType,
		tombFieldExpires: protowire.VarintType})
	if err == nil && (!sessionID || tomb.Key.RouteID == "") {
		err = errMalformedSnapshot
	}
	return tomb, err
}

func decodeItem(data []byte) (*SnapshotItem, error) {
	item := &SnapshotItem{Labels: Labels{}}
	directions := 0
	err := eachField(data, func(field protowire.Number, kind protowire.Type, value uint64, raw []byte) error {
		switch field {
		case itemFieldKind:
			item.Kind = ItemKind(value)
		case itemFieldConn:
			item.Conns = append(item.Conns, string(raw))
		case itemFieldInode:
			item.Inodes = append(item.Inodes, value)
		case itemFieldLabel:
			var key, labelValue string
			if err := eachField(raw, func(field protowire.Number, _ protowire.Type, _ uint64, raw []byte) error {
				switch field {
				case labelFieldKey:
					key = string(raw)
				case labelFieldValue:
					labelValue = string(raw)
				}
				return nil
			}, map[protowire.Number]protowire.Type{labelFieldKey: protowire.BytesType, labelFieldValue: protowire.BytesType}); err != nil {
				return err
			}
			item.Labels[key] = labelValue
		case itemFieldSession:
			item.Session = raw
		case itemFieldPipe:
			if directions >= 2 {
				return errMalformedSnapshot
			}
			d := directions
			directions++
			return eachField(raw, func(field protowire.Number, _ protowire.Type, value uint64, raw []byte) error {
				switch field {
				case pipeFieldPending:
					item.Pending[d] = raw
				case pipeFieldDone:
					item.Done[d] = value != 0
				}
				return nil
			}, map[protowire.Number]protowire.Type{pipeFieldPending: protowire.BytesType, pipeFieldDone: protowire.VarintType})
		}
		return nil
	}, map[protowire.Number]protowire.Type{itemFieldKind: protowire.VarintType, itemFieldConn: protowire.BytesType,
		itemFieldInode: protowire.VarintType, itemFieldLabel: protowire.BytesType, itemFieldSession: protowire.BytesType,
		itemFieldPipe: protowire.BytesType})
	if err != nil {
		return nil, err
	}
	switch {
	case len(item.Conns) != len(item.Inodes):
		return nil, errMalformedSnapshot
	case item.Kind == KindSession && (len(item.Conns) != 1 || len(item.Session) == 0):
		return nil, errMalformedSnapshot
	case item.Kind == KindPipe && (len(item.Conns) != 2 || directions != 2):
		return nil, errMalformedSnapshot
	}
	return item, nil
}

// eachField walks the fields of a protobuf message, checking the wire type of
// the known ones and skipping the others.
func eachField(data []byte, visit func(protowire.Number, protowire.Type, uint64, []byte) error, kinds map[protowire.Number]protowire.Type) error {
	for len(data) > 0 {
		field, kind, n := protowire.ConsumeTag(data)
		if n < 0 {
			return errMalformedSnapshot
		}
		data = data[n:]
		var value uint64
		var raw []byte
		switch kind {
		case protowire.VarintType:
			value, n = protowire.ConsumeVarint(data)
		case protowire.BytesType:
			raw, n = protowire.ConsumeBytes(data)
		default:
			n = protowire.ConsumeFieldValue(field, kind, data)
		}
		if n < 0 {
			return errMalformedSnapshot
		}
		data = data[n:]
		want, known := kinds[field]
		if !known {
			continue
		}
		if want != kind {
			return errMalformedSnapshot
		}
		if err := visit(field, kind, value, raw); err != nil {
			return err
		}
	}
	return nil
}

// sessionState decodes a session item's stream.
func (item *SnapshotItem) sessionState() (*relayresume.SessionState, error) {
	return relayresume.ParseSessionState(item.Session)
}
