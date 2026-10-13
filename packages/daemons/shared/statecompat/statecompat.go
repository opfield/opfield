// Package statecompat keeps daemon state files readable by older daemon
// binaries (stand run rc.20, B-10).
//
// The updater keeps the previous binary (*.previous) and may roll a node back
// to any 2.10.x or 2.11 release candidate. Those binaries decode their state
// files with protojson's default options, which reject every field they do
// not know, and fail to start on it: rc.4 crash-looped with "decode relay
// grants: proto: unknown field" on a file rc.20 wrote.
//
// A File therefore keeps two copies of one message:
//   - the legacy path, the file older binaries read, holds only what the
//     oldest supported release (v2.10.0) knows: the message is transcoded
//     through that release's schema (embedded below), and Prune removes what
//     an older binary must not act on at all;
//   - the full path holds the whole message plus a digest of the legacy copy
//     written with it. It is read with unknown fields discarded, so later
//     releases can add fields without breaking this one either.
//
// Read prefers the full copy while the legacy copy is the one written with
// it. When an older binary rewrote the legacy copy after a rollback, that copy
// is newer and wins; when it removed it, the full copy is stale too.
package statecompat

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// legacyStateSchema is the compiled gateway/v1/nginx-daemon.proto of v2.10.0,
// the oldest release a node may be rolled back to. Fields were only ever
// added since, so what it decodes every later release decodes too.
//
//go:embed legacy/gateway-v1-v2.10.0.binpb
var legacyStateSchema []byte

// LegacyRelease names the release whose schema legacy copies follow.
const LegacyRelease = "v2.10.0"

const fullFormat = "gateway-daemon-state/v1"

var legacyFiles = sync.OnceValues(func() (*protoregistry.Files, error) {
	set := &descriptorpb.FileDescriptorSet{}
	if err := proto.Unmarshal(legacyStateSchema, set); err != nil {
		return nil, fmt.Errorf("decode the %s state schema: %w", LegacyRelease, err)
	}
	return protodesc.NewFiles(set)
})

// legacy-name: the v2.10.0 schema names its package gateway.v1; the same messages are opfield.v1 now — remove once every node reports none
const (
	currentPackage = "opfield.v1."
	legacyPackage  = "gateway.v1."
)

// LegacyName is the name of an opfield.v1 message in the schemas of released
// versions (gateway.v1); other names are returned as they are.
func LegacyName(name protoreflect.FullName) protoreflect.FullName {
	if rest, ok := strings.CutPrefix(string(name), currentPackage); ok {
		return protoreflect.FullName(legacyPackage + rest)
	}
	return name
}

// LegacyDescriptor returns the v2.10.0 schema of an opfield.v1 message (its
// gateway.v1 name in that schema). Field numbers and names are the same, so
// only the package part of the name differs.
func LegacyDescriptor(name protoreflect.FullName) (protoreflect.MessageDescriptor, error) {
	files, err := legacyFiles()
	if err != nil {
		return nil, err
	}
	descriptor, err := files.FindDescriptorByName(LegacyName(name))
	if err != nil {
		return nil, fmt.Errorf("%s has no %s schema: %w", name, LegacyRelease, err)
	}
	message, ok := descriptor.(protoreflect.MessageDescriptor)
	if !ok {
		return nil, fmt.Errorf("%s is not a message", name)
	}
	return message, nil
}

// LegacyJSON renders msg as protojson that every release since v2.10.0
// decodes: fields and enum values that release does not know are dropped.
func LegacyJSON(msg proto.Message) ([]byte, error) {
	descriptor, err := LegacyDescriptor(msg.ProtoReflect().Descriptor().FullName())
	if err != nil {
		return nil, err
	}
	encoded, err := proto.Marshal(msg)
	if err != nil {
		return nil, err
	}
	legacy := dynamicpb.NewMessage(descriptor)
	if err := (proto.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(encoded, legacy); err != nil {
		return nil, err
	}
	return protojson.MarshalOptions{UseProtoNames: true}.Marshal(legacy)
}

// File is one persisted message kept readable by older binaries.
type File struct {
	// Legacy is the path older binaries read.
	Legacy string
	// Full is the path with the whole message.
	Full string
	// Prune, when set, edits a clone of the message before it becomes the
	// legacy copy (for example: drop entries an older binary would serve).
	Prune func(proto.Message)
}

type fullEnvelope struct {
	Format       string          `json:"format"`
	LegacySHA256 string          `json:"legacySha256,omitempty"`
	Message      json.RawMessage `json:"message"`
}

// Write stores msg: the legacy copy first, then the full copy that names it,
// each durably (temporary file, fsync, rename, directory fsync). A crash in
// between leaves the new legacy copy, which Read then takes as the newest.
func (f File) Write(msg proto.Message) error {
	legacyMessage := proto.Clone(msg)
	if f.Prune != nil {
		f.Prune(legacyMessage)
	}
	legacy, err := LegacyJSON(legacyMessage)
	if err != nil {
		return err
	}
	full, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(msg)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(legacy)
	envelope, err := json.Marshal(fullEnvelope{Format: fullFormat, LegacySHA256: hex.EncodeToString(sum[:]), Message: full})
	if err != nil {
		return err
	}
	if err := WriteAtomic(f.Legacy, legacy); err != nil {
		return err
	}
	return WriteAtomic(f.Full, envelope)
}

// Read loads the newest stored copy into msg, which it resets first. found
// is false when there is none.
func (f File) Read(msg proto.Message) (found bool, err error) {
	proto.Reset(msg)
	legacy, legacyErr := os.ReadFile(f.Legacy)
	if legacyErr != nil && !errors.Is(legacyErr, os.ErrNotExist) {
		return false, legacyErr
	}
	haveLegacy := legacyErr == nil
	if full, fullErr := os.ReadFile(f.Full); fullErr == nil {
		var envelope fullEnvelope
		if json.Unmarshal(full, &envelope) == nil && envelope.Format == fullFormat && len(envelope.Message) > 0 {
			companion := envelope.LegacySHA256 == ""
			if haveLegacy && !companion {
				sum := sha256.Sum256(legacy)
				companion = hex.EncodeToString(sum[:]) == envelope.LegacySHA256
			}
			if companion {
				if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(envelope.Message, msg); err != nil {
					return false, fmt.Errorf("decode %s: %w", f.Full, err)
				}
				return true, nil
			}
		}
	} else if !errors.Is(fullErr, os.ErrNotExist) {
		return false, fullErr
	}
	// No full copy, an unreadable one, or one an older binary superseded.
	if !haveLegacy {
		return false, nil
	}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(legacy, msg); err != nil {
		return false, fmt.Errorf("decode %s: %w", f.Legacy, err)
	}
	return true, nil
}

// Exists reports whether Read would find a copy.
func (f File) Exists(msg proto.Message) bool {
	found, err := f.Read(msg)
	return found || err != nil
}

// Remove deletes both copies; missing files are fine.
func (f File) Remove() error {
	var errs []error
	for _, path := range []string{f.Full, f.Legacy} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// WriteAtomic replaces path with data durably: temporary file, fsync,
// rename, fsync of the directory. The file is private to the daemon (0600).
func WriteAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.pending-%d", path, os.Getpid())
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	err = directory.Sync()
	if closeErr := directory.Close(); err == nil {
		err = closeErr
	}
	return err
}
