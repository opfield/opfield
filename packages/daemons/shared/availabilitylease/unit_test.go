package availabilitylease

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

type manualClock struct{ now time.Duration }

func (c *manualClock) Now() time.Duration { return c.now }

type captureTransport struct{ frames []*pb.CoordinationFrame }

func (c *captureTransport) Send(frame *pb.CoordinationFrame) { c.frames = append(c.frames, frame) }

func TestBallotOrderingPutsRoundFirst(t *testing.T) {
	a := Ballot{Round: 2, Incarnation: 1, Proposer: "z"}
	b := Ballot{Round: 1, Incarnation: 99, Proposer: "a"}
	c := Ballot{Round: 2, Incarnation: 2, Proposer: "a"}
	d := Ballot{Round: 2, Incarnation: 2, Proposer: "b"}
	if !b.Less(a) || !a.Less(c) || !c.Less(d) || d.Less(c) || a.Compare(a) != 0 {
		t.Fatal("ballot order must be (round, incarnation, proposer)")
	}
}

// The accept statement is part of the wire contract: Opfield or any
// other implementation verifying QCs must produce these exact bytes.
func TestAcceptStatementGolden(t *testing.T) {
	got := hex.EncodeToString(acceptStatement(Key{PolicyID: "p", Slot: 1}, Ballot{Round: 2, Incarnation: 3, Proposer: "d"}, 4, 5, "r", 6))
	want := hex.EncodeToString([]byte("gateway-availability-lease/accept/v1\x00")) +
		"0000000170" + "0000000000000001" + "0000000000000002" + "0000000000000003" + "0000000164" +
		"0000000000000004" + "0000000000000005" + "0000000172" + "0000000000000006"
	if got != want {
		t.Fatalf("accept statement\n got %s\nwant %s", got, want)
	}
}

func newIdentity(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key, der
}

// wireNode builds a relay node with real ECDSA identities, trusting a policy
// key and holding a manifest whose voters are the given identities.
func wireNode(t *testing.T, id string, key *ecdsa.PrivateKey, members map[string][]byte) (*Node, *captureTransport, ed25519.PrivateKey) {
	t.Helper()
	_, policy, _ := ed25519.GenerateKey(rand.Reader)
	transport := &captureTransport{}
	node, err := NewNode(Config{ID: id, Clock: &manualClock{now: time.Hour}, Store: NewMemoryStore(), Transport: transport, Signer: ECDSASigner{Key: key}})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.TrustPolicyKey("k1", policy.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	block := manifestBlock(t, policy, func(m *pb.LeaseManifest) {
		m.Candidates, m.Members = nil, nil
		var voters []string
		for _, member := range sortedKeys(members) {
			m.Candidates = append(m.Candidates, &pb.LeaseCandidate{Id: member, PublicKey: members[member]})
			m.Members = append(m.Members, &pb.LeaseMember{Id: member, PublicKey: members[member], Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY})
			voters = append(voters, member)
		}
		m.QuorumSets = []*pb.LeaseQuorumSet{{VoterIds: voters}}
	})
	if _, err := node.AdoptManifest(block); err != nil {
		t.Fatal(err)
	}
	return node, transport, policy
}

// Relays route frames but cannot forge them: a changed payload or a frame
// signed with the relay's own key under another sender id is rejected.
func TestFramesAreAuthenticatedAgainstMemberKeys(t *testing.T) {
	relayKey, relayDER := newIdentity(t)
	senderKey, senderDER := newIdentity(t)
	node, _, _ := wireNode(t, "r1", relayKey, map[string][]byte{"r1": relayDER, "r2": senderDER})
	batch := &pb.LeaseBatch{MessageId: "m1", SenderId: "r2", SenderIncarnation: 1, DestinationId: "r1",
		Items: []*pb.LeaseItem{{Body: &pb.LeaseItem_Query{Query: &pb.LeaseQuery{}}}}}
	frame, err := SealFrame(batch, ECDSASigner{Key: senderKey})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.ReceiveFrame(frame); err != nil {
		t.Fatalf("genuine frame rejected: %v", err)
	}
	tampered := proto.Clone(frame).(*pb.CoordinationFrame)
	tampered.Payload = append(append([]byte(nil), tampered.Payload...), 0x28, 0x01)
	if err := node.ReceiveFrame(tampered); err == nil {
		t.Fatal("tampered frame accepted")
	}
	forged, _ := SealFrame(batch, ECDSASigner{Key: relayKey})
	if err := node.ReceiveFrame(forged); err == nil {
		t.Fatal("frame signed by another member's key accepted")
	}
	misrouted := proto.Clone(frame).(*pb.CoordinationFrame)
	misrouted.SenderId = "r1"
	if err := node.ReceiveFrame(misrouted); err == nil {
		t.Fatal("frame whose routing disagrees with its payload accepted")
	}
}

func TestKeyChainFollowsSignedRotations(t *testing.T) {
	_, k1, _ := ed25519.GenerateKey(rand.Reader)
	_, k2, _ := ed25519.GenerateKey(rand.Reader)
	_, k3, _ := ed25519.GenerateKey(rand.Reader)
	_, rogue, _ := ed25519.GenerateKey(rand.Reader)
	chain := newKeyChain()
	if _, err := chain.trust("k1", k1.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	link12 := SignPolicyKeyRotation("k1", k1, "k2", k2.Public().(ed25519.PublicKey))
	link23 := SignPolicyKeyRotation("k2", k2, "k3", k3.Public().(ed25519.PublicKey))
	if !chain.adoptAll([]*pb.LeasePolicyKeyRotation{link23, link12}) {
		t.Fatal("chain not adopted out of order")
	}
	if _, ok := chain.lookup("k3"); !ok {
		t.Fatal("k3 not reachable from k1")
	}
	block := SignPolicyBlock("k3", k3, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, []byte("payload"))
	if err := chain.verifyBlock(block, domainManifest); err != nil {
		t.Fatalf("block signed by a reachable key rejected: %v", err)
	}
	if err := chain.verifyBlock(block, domainKeyRotation); err == nil {
		t.Fatal("signature verified under another domain")
	}
	// The relay policy envelope signs raw payload bytes; such a signature
	// must never verify as a lease block.
	raw := &pb.LeaseSignedBlock{SigningKeyId: "k3", Kind: pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST,
		Payload: []byte("payload"), Signature: ed25519.Sign(k3, []byte("payload"))}
	if err := chain.verifyBlock(raw, domainManifest); err == nil {
		t.Fatal("policy-envelope style signature accepted as a lease block")
	}
	if _, err := chain.adopt(SignPolicyKeyRotation("rogue", rogue, "k4", rogue.Public().(ed25519.PublicKey))); err == nil {
		t.Fatal("rotation from an untrusted key adopted")
	}
	bad := SignPolicyKeyRotation("k3", k3, "k5", rogue.Public().(ed25519.PublicKey))
	bad.PublicKeyFingerprint = "sha256:00"
	if _, err := chain.adopt(bad); err == nil {
		t.Fatal("rotation with a wrong fingerprint adopted")
	}
	if _, err := chain.trust("k1", k2.Public().(ed25519.PublicKey)); err == nil {
		t.Fatal("key id reused with other material")
	}
}

func manifestBlock(t *testing.T, key ed25519.PrivateKey, mutate func(*pb.LeaseManifest)) *pb.LeaseSignedBlock {
	t.Helper()
	value := &pb.LeaseManifest{
		SchemaVersion: 1, PolicyId: "p1", ManifestVersion: 1, Mode: pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER,
		PartitionMode: pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT, Slots: 1, VoterEpoch: 1, LeaseTermMs: 30000,
		Candidates: []*pb.LeaseCandidate{{Id: "d1", PublicKey: []byte("pk:d1")}, {Id: "d2", PublicKey: []byte("pk:d2")}},
		QuorumSets: []*pb.LeaseQuorumSet{{VoterIds: []string{"d1", "d2", "w"}}},
	}
	for _, id := range []string{"d1", "d2", "w"} {
		value.Members = append(value.Members, &pb.LeaseMember{Id: id, PublicKey: []byte("pk:" + id), Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON})
	}
	if mutate != nil {
		mutate(value)
	}
	payload, _ := proto.Marshal(value)
	return SignPolicyBlock("k1", key, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
}

func TestManifestValidation(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := parseManifest(manifestBlock(t, key, nil)); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	cases := map[string]func(*pb.LeaseManifest){
		"timing is fixed":                  func(m *pb.LeaseManifest) { m.LeaseTermMs = 20000 },
		"failover has one slot":            func(m *pb.LeaseManifest) { m.Slots = 2 },
		"bootstrap holder is a candidate":  func(m *pb.LeaseManifest) { m.BootstrapId = 1; m.Bootstrap = []*pb.LeaseBootstrapSlot{{HolderId: "x"}} },
		"bootstrap needs an id":            func(m *pb.LeaseManifest) { m.Bootstrap = []*pb.LeaseBootstrapSlot{{HolderId: "d1"}} },
		"duplicate candidates":             func(m *pb.LeaseManifest) { m.Candidates = append(m.Candidates, m.Candidates[0]) },
		"partition mode must be specified": func(m *pb.LeaseManifest) { m.PartitionMode = 0 },
		"duplicate member ids":             func(m *pb.LeaseManifest) { m.Members = append(m.Members, m.Members[0]) },
		"voter must be a member":           func(m *pb.LeaseManifest) { m.QuorumSets[0].VoterIds[2] = "x" },
		"voter epoch is required":          func(m *pb.LeaseManifest) { m.VoterEpoch = 0 },
		"at most seven voters": func(m *pb.LeaseManifest) {
			for i := 0; i < 5; i++ {
				id := string(rune('a' + i))
				m.Members = append(m.Members, &pb.LeaseMember{Id: id, PublicKey: []byte("pk:" + id)})
				m.QuorumSets[0].VoterIds = append(m.QuorumSets[0].VoterIds, id)
			}
		},
		"member key matches candidate key": func(m *pb.LeaseManifest) { m.Members[0].PublicKey = []byte("pk:other") },
	}
	for name, mutate := range cases {
		if _, err := parseManifest(manifestBlock(t, key, mutate)); err == nil {
			t.Errorf("%s: invalid manifest accepted", name)
		}
	}
}

func testCommit(policyID string, epoch uint64, ids ...string) *pb.LeaseCommit {
	key := Key{PolicyID: policyID}
	ballot := Ballot{Round: 1, Incarnation: 1, Proposer: "d1"}
	c := &pb.LeaseCommit{Key: key.proto(), Ballot: ballot.proto(), Epoch: epoch, ManifestVersion: 1}
	for _, id := range ids {
		c.Quorum = append(c.Quorum, &pb.LeaseAccepted{Key: key.proto(), Ballot: ballot.proto(), Epoch: epoch, ManifestVersion: 1,
			AcceptorId: id, AcceptorIncarnation: 1, Signature: []byte(id)})
	}
	return c
}

func observerNode(t *testing.T, id string) (*Node, ed25519.PrivateKey, *manualClock) {
	t.Helper()
	_, policy, _ := ed25519.GenerateKey(rand.Reader)
	clock := &manualClock{}
	node, err := NewNode(Config{ID: id, Clock: clock, Store: NewMemoryStore(), Signer: fakeSigner{id: id}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	_ = node.TrustPolicyKey("k1", policy.Public().(ed25519.PublicKey))
	return node, policy, clock
}

func withVoters(epoch uint64, sets ...[]string) func(*pb.LeaseManifest) {
	return func(m *pb.LeaseManifest) {
		m.VoterEpoch, m.Members, m.QuorumSets = epoch, nil, nil
		members := map[string]bool{}
		for _, set := range sets {
			m.QuorumSets = append(m.QuorumSets, &pb.LeaseQuorumSet{VoterIds: set})
			for _, id := range set {
				members[id] = true
			}
		}
		for _, id := range sortedKeys(members) {
			m.Members = append(m.Members, &pb.LeaseMember{Id: id, PublicKey: []byte("pk:" + id), Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON})
		}
	}
}

// Joint consensus (D2, A4, A18): a commit needs a majority of every quorum
// set of the policy's voter epoch.
func TestCommitNeedsMajorityOfEveryQuorumSetDuringJointEpoch(t *testing.T) {
	node, policy, _ := observerNode(t, "obs")
	if _, err := node.AdoptManifest(manifestBlock(t, policy, withVoters(7, []string{"a", "b", "c"}, []string{"c", "d", "e"}))); err != nil {
		t.Fatal(err)
	}
	manifest := node.manifests["p1"]
	if err := node.verifyCommit(testCommit("p1", 7, "a", "b", "d"), manifest); err == nil {
		t.Fatal("old-set majority alone accepted")
	}
	if err := node.verifyCommit(testCommit("p1", 7, "c", "d", "e"), manifest); err == nil {
		t.Fatal("new-set majority alone accepted")
	}
	if err := node.verifyCommit(testCommit("p1", 7, "a", "c", "d"), manifest); err != nil {
		t.Fatalf("majority of both sets rejected: %v", err)
	}
	forged := testCommit("p1", 7, "a", "c", "d")
	forged.Quorum[1].Signature = []byte("x")
	if err := node.verifyCommit(forged, manifest); err == nil {
		t.Fatal("commit with a forged accept accepted")
	}
	// The joint epoch stays verifiable after the policy settles (A4).
	settled := manifestBlock(t, policy, func(m *pb.LeaseManifest) {
		withVoters(8, []string{"c", "d", "e"})(m)
		m.ManifestVersion = 2
	})
	if _, err := node.AdoptManifest(settled); err != nil {
		t.Fatal(err)
	}
	if err := node.verifyCommit(testCommit("p1", 7, "a", "c", "d"), node.manifests["p1"]); err != nil {
		t.Fatalf("commit of the previous voter epoch no longer verifies: %v", err)
	}
	backwards := manifestBlock(t, policy, func(m *pb.LeaseManifest) {
		withVoters(6, []string{"a", "b", "c"})(m)
		m.ManifestVersion = 3
	})
	if _, err := node.AdoptManifest(backwards); err == nil {
		t.Fatal("manifest with an older voter epoch adopted")
	}
}

// A18: voters are per policy. A vote of a node that votes for policy A never
// counts for policy B, and a node votes only in the policies whose quorum
// sets name it.
func TestVotersArePerPolicy(t *testing.T) {
	node, policy, clock := observerNode(t, "d1")
	p2 := func(m *pb.LeaseManifest) {
		withVoters(1, []string{"d3", "d4", "w2"})(m)
		m.PolicyId = "p2"
		m.Candidates = []*pb.LeaseCandidate{{Id: "d3", PublicKey: []byte("pk:d3")}, {Id: "d4", PublicKey: []byte("pk:d4")}}
	}
	if _, err := node.AdoptManifest(manifestBlock(t, policy, withVoters(1, []string{"d1", "d2", "w1"}))); err != nil {
		t.Fatal(err)
	}
	if _, err := node.AdoptManifest(manifestBlock(t, policy, p2)); err != nil {
		t.Fatal(err)
	}
	clock.now = AbstainAfterStart + time.Second
	if !node.voting("p1", clock.now) || node.voting("p2", clock.now) {
		t.Fatal("d1 must vote for p1 only")
	}
	if err := node.verifyCommit(testCommit("p2", 1, "d1", "d2", "w1"), node.manifests["p2"]); err == nil {
		t.Fatal("p1 voters formed a commit for p2")
	}
	if err := node.verifyCommit(testCommit("p2", 1, "d3", "w2"), node.manifests["p2"]); err != nil {
		t.Fatalf("p2 voters rejected: %v", err)
	}
	if node.Epoch("p1") != 1 || node.Epoch("p2") != 1 || node.Epoch("p3") != 0 {
		t.Fatal("epochs are per policy")
	}
}

// A3: incarnation and promises survive a restart; every start abstains.
func TestRestartPersistsIncarnationAndAbstains(t *testing.T) {
	store := NewMemoryStore()
	clock := &manualClock{now: time.Minute}
	first, err := NewNode(Config{ID: "r1", Clock: clock, Store: store, Signer: fakeSigner{id: "r1"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	first.mu.Lock()
	first.acceptorFor(keyP1).rec.Promised = Ballot{Round: 9, Incarnation: 1, Proposer: "d1"}
	first.markDirty(keyP1)
	first.commitLocked(clock.now)
	first.mu.Unlock()
	clock.now = 10 * time.Second // a new boot: the monotonic clock restarted
	second, err := NewNode(Config{ID: "r1", Clock: clock, Store: store, Signer: fakeSigner{id: "r1"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	if second.Incarnation() != first.Incarnation()+1 {
		t.Fatalf("incarnation %d after %d", second.Incarnation(), first.Incarnation())
	}
	if got := second.acceptors[keyP1].rec.Promised; got.Round != 9 {
		t.Fatalf("promised ballot lost: %s", got)
	}
	floor, err := NewNode(Config{ID: "r1", Clock: clock, Store: NewMemoryStore(), Signer: fakeSigner{id: "r1"}, IncarnationFloor: 5000})
	if err != nil || floor.Incarnation() != 5000 {
		t.Fatalf("incarnation floor ignored: %v %d", err, floor.Incarnation())
	}
	if !second.Abstaining() || second.abstainUntil != clock.now+AbstainAfterStart || AbstainAfterStart != LeaseTerm*11/10 {
		t.Fatal("a start on another boot must abstain for T x 1.1")
	}
}

type bootClock struct {
	now    time.Duration
	origin uint64
}

func (c *bootClock) Now() time.Duration { return c.now }
func (c *bootClock) Origin() uint64     { return c.origin }

// A3 amended: a restart within the same boot (the store's boot stamp has this
// clock's origin and an earlier reading) keeps voting and restores the hold of
// its latest counted accept exactly, unless that holder released it; a stale
// accept whose hold lapsed restores nothing.
func TestRestartWithinTheSameBootHoldsInsteadOfAbstaining(t *testing.T) {
	store := NewMemoryStore()
	clock := &bootClock{now: 10 * time.Minute, origin: 42}
	start := func() *Node {
		t.Helper()
		node, err := NewNode(Config{ID: "r1", Clock: clock, Store: store, Signer: fakeSigner{id: "r1"}, Verifier: fakeVerifier{}})
		if err != nil {
			t.Fatal(err)
		}
		return node
	}
	first := start()
	clock.now += AbstainAfterStart + time.Second
	keyP2, keyP3 := Key{PolicyID: "p2"}, Key{PolicyID: "p3"}
	acceptedAt := clock.now
	first.mu.Lock()
	held := first.acceptorFor(keyP1)
	held.rec.Promised = Ballot{Round: 9, Incarnation: 1, Proposer: "d1"}
	held.rec.Accepted = &acceptedRecord{Ballot: held.rec.Promised, AtNs: int64(acceptedAt)}
	released := first.acceptorFor(keyP2)
	released.rec.Promised = Ballot{Round: 4, Incarnation: 1, Proposer: "d3"}
	released.rec.Accepted = &acceptedRecord{Ballot: released.rec.Promised, AtNs: int64(acceptedAt)}
	released.rec.Released = map[string]Ballot{"d3": {Round: 4, Incarnation: 1, Proposer: "d3"}}
	stale := first.acceptorFor(keyP3)
	stale.rec.Promised = Ballot{Round: 7, Incarnation: 1, Proposer: "d5"}
	stale.rec.Accepted = &acceptedRecord{Ballot: Ballot{Round: 6, Incarnation: 1, Proposer: "d4"}, AtNs: int64(acceptedAt - AcceptorHold)}
	for _, key := range []Key{keyP1, keyP2, keyP3} {
		first.markDirty(key)
	}
	first.commitLocked(clock.now)
	first.mu.Unlock()

	clock.now += 5 * time.Second
	second := start()
	if second.Abstaining() {
		t.Fatal("a restart within the same boot abstains")
	}
	if lease := second.acceptors[keyP1].lease; lease.holder != "d1" || lease.at != acceptedAt || !lease.openAt(acceptedAt+AcceptorHold-time.Millisecond) || lease.openAt(acceptedAt+AcceptorHold) {
		t.Fatalf("hold after restart = %+v, want d1 until T x 1.1 after the accept", lease)
	}
	if lease := second.acceptors[keyP2].lease; lease.openAt(clock.now) {
		t.Fatalf("a released key is held after restart: %+v", lease)
	}
	if lease := second.acceptors[keyP3].lease; lease.openAt(clock.now) {
		t.Fatalf("a lapsed hold came back after restart: %+v", lease)
	}

	// Restarted again inside a fresh start's abstention: it keeps abstaining
	// until the recorded deadline.
	fresh := NewMemoryStore()
	clock.now += time.Minute
	firstFresh, err := NewNode(Config{ID: "r2", Clock: clock, Store: fresh, Signer: fakeSigner{id: "r2"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	until := firstFresh.abstainUntil
	clock.now += 10 * time.Second
	again, err := NewNode(Config{ID: "r2", Clock: clock, Store: fresh, Signer: fakeSigner{id: "r2"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	if again.abstainUntil != until || !again.Abstaining() {
		t.Fatalf("restart shortened the abstention of a fresh start: %s, want %s", again.abstainUntil, until)
	}

	// A boot stamp from another boot, or from later on this clock (a store
	// restored from elsewhere), proves nothing.
	for name, restart := range map[string]bootClock{
		"other origin":    {now: 200 * time.Second, origin: 43},
		"clock went back": {now: 50 * time.Second, origin: 42},
	} {
		written := NewMemoryStore()
		writer := &bootClock{now: 100 * time.Second, origin: 42}
		if _, err := NewNode(Config{ID: "r3", Clock: writer, Store: written, Signer: fakeSigner{id: "r3"}}); err != nil {
			t.Fatal(err)
		}
		writer.now += AbstainAfterStart + time.Second
		node, err := NewNode(Config{ID: "r3", Clock: &restart, Store: written, Signer: fakeSigner{id: "r3"}})
		if err != nil {
			t.Fatal(err)
		}
		if !node.Abstaining() {
			t.Fatalf("%s: restart did not abstain", name)
		}
	}
}
