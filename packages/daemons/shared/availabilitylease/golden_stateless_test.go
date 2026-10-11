package availabilitylease

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// Stateless keys keep main's wire and store bytes exactly (lease v2), so a
// relay or daemon with the v3 library interoperates with older peers. The
// expected bytes were produced by the library before v3 (main b4a6a38c9).
func TestStatelessAcceptIsByteIdenticalToV2(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	policy := ed25519.NewKeyFromSeed(seed)
	clock := &manualClock{}
	node, err := NewNode(Config{ID: "w", Clock: clock, Store: NewMemoryStore(), Signer: digestSigner{}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.TrustPolicyKey("k1", policy.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	if _, err := node.AdoptManifest(manifestBlock(t, policy, nil)); err != nil {
		t.Fatal(err)
	}
	now := time.Hour
	clock.now = now
	node.abstainUntil = 0
	key := Key{PolicyID: "p1"}
	ballot := Ballot{Round: 7, Incarnation: 3, Proposer: "d1"}
	node.onPrepare("d1", &pb.LeasePrepare{Key: key.proto(), Ballot: ballot.proto(), Epoch: 1, ManifestVersion: 1}, now)
	items := node.outbox["d1"]
	if len(items) != 1 || items[0].GetPromise() == nil {
		t.Fatalf("prepare reply %v", items)
	}
	promise := items[0].GetPromise()
	node.onPropose("d1", &pb.LeasePropose{Key: key.proto(), Ballot: ballot.proto(), Epoch: 1, ManifestVersion: 1, Echo: promise.GetEcho()}, now)
	items = node.outbox["d1"]
	if len(items) != 2 || items[1].GetAccepted() == nil {
		t.Fatalf("propose reply %v", items)
	}
	node.onQuery("d1", &pb.LeaseQuery{Keys: []*pb.LeaseKey{key.proto()}}, now)
	items = node.outbox["d1"]
	if len(items) != 3 || items[2].GetStatus() == nil {
		t.Fatalf("query reply %v", items)
	}
	record := encodeKeyRecord(node.acceptors[key].rec)

	golden := map[string]string{
		"promise":  "12180a040a0270311208080710031a0264311881808080102801",
		"accepted": "223b0a040a0270311208080710031a026431180120012a017730013a20e7d6425298583b5e6f7a4c365e4b2f129b7b5ee87508d1dc8a59f6e7c2c4866a",
		"status":   "521a0a040a02703110021a0264312208080710031a02643130013801",
		"record":   "7b2270726f6d69736564223a7b22526f756e64223a372c22496e6361726e6174696f6e223a332c2250726f706f736572223a226431227d2c226163636570746564223a7b2262616c6c6f74223a7b22526f756e64223a372c22496e6361726e6174696f6e223a332c2250726f706f736572223a226431227d2c2261744e73223a333630303030303030303030307d7d",
	}
	got := map[string]string{
		"promise":  marshalHex(t, items[0]),
		"accepted": marshalHex(t, items[1]),
		"status":   marshalHex(t, items[2]),
		"record":   hex.EncodeToString(record),
	}
	for name, want := range golden {
		if got[name] != want {
			t.Errorf("stateless %s bytes changed\n got %s\nwant %s", name, got[name], want)
		}
	}
}

func marshalHex(t *testing.T, item *pb.LeaseItem) string {
	t.Helper()
	data, err := proto.MarshalOptions{Deterministic: true}.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(data)
}

// digestSigner signs with the statement's sha256, so the golden bytes cover
// the signed accept statement too.
type digestSigner struct{}

func (digestSigner) Sign(message []byte) ([]byte, error) {
	sum := sha256.Sum256(message)
	return sum[:], nil
}
