package handover

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/relayresume"
	"google.golang.org/protobuf/encoding/protowire"
)

func snapshotFixture() *Snapshot {
	return &Snapshot{
		DaemonType: "docker", FromVersion: "v2.11.4", CreatedAt: time.UnixMilli(1_790_000_000_000),
		Items: []SnapshotItem{
			{Kind: KindSession, Conns: []string{"conn/1"}, Inodes: []uint64{4242}, Labels: Labels{"owner_kind": "container_link", "owner_id": "x"},
				Session: []byte{0x08, 0x01}},
			{Kind: KindPipe, Conns: []string{"conn/2", "conn/3"}, Inodes: []uint64{7, 8}, Labels: Labels{"link": "y"},
				Pending: [2][]byte{[]byte("left"), nil}, Done: [2]bool{false, true}},
		},
		Tombstones: []relayresume.Tombstone{{Key: relayresume.TargetKey{RouteID: "route-1", SourceKind: "daemon", SourceID: "node-1",
			SessionID: [16]byte{1, 2, 3}}, Reject: relayresume.RejectFinished, Expires: time.UnixMilli(1_790_000_120_000)}},
	}
}

// The snapshot format version 1 is frozen: the release before and the
// release after this one read it. The golden file was written once; never
// regenerate it for a change that is not a pure addition of fields.
func TestSnapshotGoldenV1(t *testing.T) {
	path := filepath.Join("testdata", "snapshot-v1.bin")
	encoded := snapshotFixture().Encode()
	if os.Getenv("HANDOVER_WRITE_GOLDEN") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, golden) {
		t.Fatal("the version 1 encoding of a snapshot changed")
	}
	decoded, err := DecodeSnapshot(golden)
	if err != nil {
		t.Fatal(err)
	}
	want := snapshotFixture()
	// Absent bytes decode as nil.
	want.Items[1].Pending[1] = nil
	if !reflect.DeepEqual(decoded, want) {
		t.Fatalf("decoded %+v", decoded)
	}
}

// A later release adds fields at every level: this one skips them.
func TestSnapshotSkipsUnknownFields(t *testing.T) {
	encoded := snapshotFixture().Encode()
	body := encoded[:len(encoded)-sha256.Size]
	body = protowire.AppendTag(append([]byte(nil), body...), 77, protowire.BytesType)
	body = protowire.AppendBytes(body, []byte("later"))
	var item []byte
	item = protowire.AppendTag(item, itemFieldKind, protowire.VarintType)
	item = protowire.AppendVarint(item, uint64(KindSession))
	item = appendString(item, itemFieldConn, "conn/9")
	item = protowire.AppendTag(item, itemFieldInode, protowire.VarintType)
	item = protowire.AppendVarint(item, 9)
	item = protowire.AppendTag(item, itemFieldSession, protowire.BytesType)
	item = protowire.AppendBytes(item, []byte{1})
	item = protowire.AppendTag(item, 50, protowire.VarintType)
	item = protowire.AppendVarint(item, 1)
	body = protowire.AppendTag(body, snapshotFieldItem, protowire.BytesType)
	body = protowire.AppendBytes(body, item)
	sum := sha256.Sum256(body)
	decoded, err := DecodeSnapshot(append(body, sum[:]...))
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded.Items) != 3 || decoded.Items[2].Conns[0] != "conn/9" || decoded.DaemonType != "docker" {
		t.Fatalf("decoded %+v", decoded)
	}
}

func TestSnapshotRejectsDamage(t *testing.T) {
	encoded := snapshotFixture().Encode()
	damaged := append([]byte(nil), encoded...)
	damaged[len(snapshotMagic)+5] ^= 1
	if _, err := DecodeSnapshot(damaged); err == nil {
		t.Fatal("accepted a snapshot that does not match its checksum")
	}
	later := append([]byte(nil), encoded...)
	later[len(snapshotMagic)] = SnapshotVersion + 1
	if _, err := DecodeSnapshot(later); err == nil {
		t.Fatal("accepted another format version")
	}
	if _, err := DecodeSnapshot(encoded[:10]); err == nil {
		t.Fatal("accepted a truncated snapshot")
	}
}

// budgetKeeper takes every file and passes nothing on.
type budgetKeeper struct{ kept []string }

func (*budgetKeeper) HandsOver() bool { return true }
func (k *budgetKeeper) Keep(name string, file *os.File) error {
	k.kept = append(k.kept, name)
	return nil
}
func (*budgetKeeper) Drop(string) error            { return nil }
func (*budgetKeeper) Take(string) (*os.File, bool) { return nil, false }
func (*budgetKeeper) Inherited(string) []string    { return nil }
func (*budgetKeeper) Flush(time.Duration) error    { return nil }
func (*budgetKeeper) EnvBytes([]string) int        { return 0 }

// budgetItem is a stopped connection without sockets.
type budgetItem struct{ thawed bool }

func (*budgetItem) freeze()                 {}
func (i *budgetItem) thaw()                 { i.thawed = true }
func (*budgetItem) handedOver()             {}
func (*budgetItem) quiescent() (bool, bool) { return true, true }
func (*budgetItem) pinned() bool            { return false }

// A handover never writes a snapshot the next process refuses as a whole
// (maxSnapshotBytes): streams whose state no longer fits (windows up to 32 MiB
// each way with the window extension) stay with this process, the rest goes.
func TestKeepSocketsKeepsTheSnapshotReadable(t *testing.T) {
	saved := snapshotItemBytes
	snapshotItemBytes = 1000
	defer func() { snapshotItemBytes = saved }()
	items := []*budgetItem{{}, {}, {}, {}}
	sizes := []int{400, 500, 200, 50}
	var candidates []candidate
	for i, it := range items {
		candidates = append(candidates, candidate{it: it, files: 1,
			snapshot: SnapshotItem{Kind: KindSession, Session: make([]byte, sizes[i])}})
	}
	cut := map[string]int{}
	kept, snapshot := keepSockets(&budgetKeeper{}, candidates, cut, Options{}, time.Now())
	// 400+256 fits; 344 left: 500+256 and 200+256 do not, 50+256 does.
	if len(kept) != 2 || kept[0].it != items[0] || kept[1].it != items[3] {
		t.Fatalf("kept %d items, want the first and the last", len(kept))
	}
	if cut[CutOverLimit] != 2 || !items[1].thawed || !items[2].thawed || items[0].thawed || items[3].thawed {
		t.Fatalf("cut %v, thawed %v %v %v %v", cut, items[0].thawed, items[1].thawed, items[2].thawed, items[3].thawed)
	}
	if got := len(snapshot.Encode()); got > 1000+snapshotReserve {
		t.Fatalf("snapshot of %d bytes", got)
	}
	if snapshot.Items[0].Conns[0] != connPrefix+"1" || snapshot.Items[1].Conns[0] != connPrefix+"2" {
		t.Fatalf("keeper names %v %v", snapshot.Items[0].Conns, snapshot.Items[1].Conns)
	}
}
