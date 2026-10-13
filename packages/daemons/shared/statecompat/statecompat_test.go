package statecompat

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// oldSchemas are the gateway.v1 schemas of releases a node may be rolled back
// to: v2.10.0 (embedded), v2.11.0-rc.4 (the stand's docker-daemon.previous)
// and v2.11.0-rc.18 (the stand's docker-daemon.pre-rc18pre).
func oldSchemas(t *testing.T) map[string]*protoregistry.Files {
	t.Helper()
	out := map[string]*protoregistry.Files{}
	load := func(name string, data []byte) {
		set := &descriptorpb.FileDescriptorSet{}
		if err := proto.Unmarshal(data, set); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		files, err := protodesc.NewFiles(set)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out[name] = files
	}
	load("v2.10.0", legacyStateSchema)
	for _, tag := range []string{"v2.11.0-rc.4", "v2.11.0-rc.18"} {
		data, err := os.ReadFile(filepath.Join("testdata", "gateway-v1-"+tag+".binpb"))
		if err != nil {
			t.Fatal(err)
		}
		load(tag, data)
	}
	return out
}

func oldMessage(t *testing.T, files *protoregistry.Files, name protoreflect.FullName) *dynamicpb.Message {
	t.Helper()
	descriptor, err := files.FindDescriptorByName(LegacyName(name))
	if err != nil {
		t.Fatal(err)
	}
	return dynamicpb.NewMessage(descriptor.(protoreflect.MessageDescriptor))
}

// populate sets every field of m, recursively, so a test covers every field
// the current schema has, including the ones added after old releases.
func populate(m protoreflect.Message, depth int) {
	fields := m.Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		if oneof := field.ContainingOneof(); oneof != nil && !oneof.IsSynthetic() && m.WhichOneof(oneof) != nil {
			continue
		}
		switch {
		case field.IsMap():
			continue
		case field.IsList():
			list := m.Mutable(field).List()
			if field.Kind() == protoreflect.MessageKind || field.Kind() == protoreflect.GroupKind {
				if depth > 0 {
					element := list.NewElement()
					populate(element.Message(), depth-1)
					list.Append(element)
				}
				continue
			}
			list.Append(scalar(field))
		case field.Kind() == protoreflect.MessageKind || field.Kind() == protoreflect.GroupKind:
			if depth > 0 {
				populate(m.Mutable(field).Message(), depth-1)
			}
		default:
			m.Set(field, scalar(field))
		}
	}
}

func scalar(field protoreflect.FieldDescriptor) protoreflect.Value {
	number := int64(field.Number())
	switch field.Kind() {
	case protoreflect.BoolKind:
		return protoreflect.ValueOfBool(true)
	case protoreflect.StringKind:
		return protoreflect.ValueOfString(fmt.Sprintf("%s-%d", field.Name(), number))
	case protoreflect.BytesKind:
		return protoreflect.ValueOfBytes([]byte{byte(number), 1, 2})
	case protoreflect.EnumKind:
		values := field.Enum().Values()
		return protoreflect.ValueOfEnum(values.Get(values.Len() - 1).Number())
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		return protoreflect.ValueOfInt32(int32(number + 100))
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		return protoreflect.ValueOfInt64(number + 1000)
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		return protoreflect.ValueOfUint32(uint32(number + 100))
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		return protoreflect.ValueOfUint64(uint64(number + 1000))
	case protoreflect.FloatKind:
		return protoreflect.ValueOfFloat32(1.5)
	case protoreflect.DoubleKind:
		return protoreflect.ValueOfFloat64(2.5)
	}
	panic(fmt.Sprintf("unhandled kind %s", field.Kind()))
}

func fullMessages() []proto.Message {
	grants := &pb.SyncRelayGrantsCommand{}
	populate(grants.ProtoReflect(), 6)
	links := &pb.SyncProxySecureLinksCommand{}
	populate(links.ProtoReflect(), 6)
	return []proto.Message{grants, links}
}

// B-10: what the current daemon writes where older binaries look must decode
// with their strict protojson, for every release a node can roll back to.
func TestLegacyCopyDecodesStrictlyWithEveryOldSchema(t *testing.T) {
	schemas := oldSchemas(t)
	for _, message := range fullMessages() {
		name := message.ProtoReflect().Descriptor().FullName()
		plain, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		// The rc.20 bug: the plain file breaks rc.4.
		if err := protojson.Unmarshal(plain, oldMessage(t, schemas["v2.11.0-rc.4"], name)); err == nil {
			t.Fatalf("%s: the plain file decodes with rc.4; the test does not cover the new fields", name)
		}
		legacy, err := LegacyJSON(message)
		if err != nil {
			t.Fatal(err)
		}
		for release, files := range schemas {
			old := oldMessage(t, files, name)
			if err := protojson.Unmarshal(legacy, old); err != nil {
				t.Fatalf("%s: %s cannot read the legacy copy: %v\n%s", name, release, err, legacy)
			}
		}
	}
}

// The legacy copy keeps everything v2.10.0 knows, nested fields included.
func TestLegacyCopyKeepsTheFieldsOldReleasesKnow(t *testing.T) {
	grants := &pb.SyncRelayGrantsCommand{
		PolicyRevision: 9, GeneratedAtUnixMs: 12, DataLanes: 4, ReadChunkBytes: 65536,
		Grants: []*pb.RelayGrantAssignment{{
			Role: "endpoint", OwnerKind: "container", OwnerId: "c1", EndpointId: "e1",
			Grant:      &pb.RelaySignedGrant{KeyId: "k", Payload: []byte{1}, Signature: []byte{2}},
			Candidates: []*pb.RelayDataCandidate{{RelayInstanceId: "r1", Port: 7443, Addresses: []string{"10.0.0.1"}, Topology: &pb.RelayCandidateTopology{Role: "primary"}}},
		}},
		RelayLatencyTargets: []*pb.RelayLatencyTarget{{RelayInstanceId: "r2"}},
		RevocationFences:    []*pb.RelayRevocationFence{{RelayInstanceId: "r3", EndpointId: "e1"}},
	}
	legacy, err := LegacyJSON(grants)
	if err != nil {
		t.Fatal(err)
	}
	back := &pb.SyncRelayGrantsCommand{}
	if err := protojson.Unmarshal(legacy, back); err != nil {
		t.Fatal(err)
	}
	want := proto.Clone(grants).(*pb.SyncRelayGrantsCommand)
	want.RelayLatencyTargets, want.RevocationFences, want.Grants[0].Candidates[0].Topology = nil, nil, nil
	if !proto.Equal(back, want) {
		t.Fatalf("legacy copy lost v2.10.0 fields:\n got %v\nwant %v", back, want)
	}
}

func testFile(t *testing.T) File {
	dir := t.TempDir()
	return File{Legacy: filepath.Join(dir, "state.json"), Full: filepath.Join(dir, "state.full.json")}
}

func grantsAt(revision uint64) *pb.SyncRelayGrantsCommand {
	return &pb.SyncRelayGrantsCommand{PolicyRevision: revision, RelayLatencyTargets: []*pb.RelayLatencyTarget{{RelayInstanceId: "r1"}}}
}

func TestReadPrefersTheFullCopyWrittenWithItsLegacyCopy(t *testing.T) {
	file := testFile(t)
	if err := file.Write(grantsAt(5)); err != nil {
		t.Fatal(err)
	}
	got := &pb.SyncRelayGrantsCommand{}
	if found, err := file.Read(got); err != nil || !found || got.PolicyRevision != 5 || len(got.RelayLatencyTargets) != 1 {
		t.Fatalf("read = %v found=%v err=%v", got, found, err)
	}
	info, err := os.Stat(file.Legacy)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("legacy copy mode = %v, %v", info, err)
	}
}

// After a rollback the older binary rewrites the legacy copy; once the node
// runs the current binary again that copy is the newest state.
func TestReadTakesALegacyCopyAnOlderBinaryRewrote(t *testing.T) {
	file := testFile(t)
	if err := file.Write(grantsAt(5)); err != nil {
		t.Fatal(err)
	}
	old := oldMessage(t, oldSchemas(t)["v2.11.0-rc.4"], "gateway.v1.SyncRelayGrantsCommand")
	old.Set(old.Descriptor().Fields().ByName("policy_revision"), protoreflect.ValueOfUint64(8))
	written, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file.Legacy, written, 0o600); err != nil {
		t.Fatal(err)
	}
	got := &pb.SyncRelayGrantsCommand{}
	if found, err := file.Read(got); err != nil || !found || got.PolicyRevision != 8 {
		t.Fatalf("read = %v found=%v err=%v, want the rewritten revision 8", got, found, err)
	}
}

// An older binary that finished a pending apply removed the legacy marker:
// the full copy written next to it is stale.
func TestReadIgnoresAFullCopyWhoseLegacyCopyWasRemoved(t *testing.T) {
	file := testFile(t)
	if err := file.Write(grantsAt(5)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(file.Legacy); err != nil {
		t.Fatal(err)
	}
	if found, err := file.Read(&pb.SyncRelayGrantsCommand{}); err != nil || found {
		t.Fatalf("stale full copy used: found=%v err=%v", found, err)
	}
	if file.Exists(&pb.SyncRelayGrantsCommand{}) {
		t.Fatal("stale full copy counts as present")
	}
}

// The first start of the current binary reads what the older one wrote.
func TestReadUpgradesFromTheFilesOlderBinariesWrote(t *testing.T) {
	for release, files := range oldSchemas(t) {
		file := testFile(t)
		old := oldMessage(t, files, "gateway.v1.SyncRelayGrantsCommand")
		populate(old, 6)
		written, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(old)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file.Legacy, written, 0o600); err != nil {
			t.Fatal(err)
		}
		got := &pb.SyncRelayGrantsCommand{}
		if found, err := file.Read(got); err != nil || !found {
			t.Fatalf("%s: read found=%v err=%v", release, found, err)
		}
		encoded, _ := proto.Marshal(old)
		want := &pb.SyncRelayGrantsCommand{}
		if err := proto.Unmarshal(encoded, want); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(got, want) {
			t.Fatalf("%s: current binary read\n%v\nwant\n%v", release, got, want)
		}
	}
}

func TestReadFallsBackToTheLegacyCopyWhenTheFullCopyIsDamaged(t *testing.T) {
	file := testFile(t)
	if err := file.Write(grantsAt(5)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file.Full, []byte("{\"format\":"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := &pb.SyncRelayGrantsCommand{}
	if found, err := file.Read(got); err != nil || !found || got.PolicyRevision != 5 {
		t.Fatalf("read = %v found=%v err=%v", got, found, err)
	}
}

func TestPruneOnlyAffectsTheLegacyCopy(t *testing.T) {
	file := testFile(t)
	file.Prune = func(message proto.Message) { message.(*pb.SyncRelayGrantsCommand).Grants = nil }
	command := grantsAt(3)
	command.Grants = []*pb.RelayGrantAssignment{{OwnerId: "kept-in-full"}}
	if err := file.Write(command); err != nil {
		t.Fatal(err)
	}
	legacy, err := os.ReadFile(file.Legacy)
	if err != nil || strings.Contains(string(legacy), "kept-in-full") {
		t.Fatalf("pruned entry in the legacy copy: %s %v", legacy, err)
	}
	got := &pb.SyncRelayGrantsCommand{}
	if found, err := file.Read(got); err != nil || !found || len(got.Grants) != 1 || len(command.Grants) != 1 {
		t.Fatalf("full copy lost the entry: %v found=%v err=%v", got, found, err)
	}
}
