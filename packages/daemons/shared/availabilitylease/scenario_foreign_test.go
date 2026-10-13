package availabilitylease

import (
	"errors"
	"fmt"
	"math"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// foreignWorld runs p1 (candidates d1, d2) and p2 (candidates p2Candidates),
// both voted by the relays r1-r3.
func foreignWorld(t *testing.T, p2Candidates ...string) (*simWorld, Key) {
	t.Helper()
	w := newScenario(t, scenarioSpec{
		relays:     voterRelays(1, "r1", "r2", "r3"),
		daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}, {id: "x"}},
		candidates: []string{"d1", "d2"},
	})
	keyP2 := w.addPolicy("p2", p2Candidates, []string{"r1", "r2", "r3"})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.waitHolder(t, keyP2, 60*time.Second)
	w.runUntil(w.now + 10*time.Second)
	return w, keyP2
}

func TestNextRoundSaturates(t *testing.T) {
	if nextRound(7) != 8 || nextRound(math.MaxUint64-1) != math.MaxUint64 || nextRound(math.MaxUint64) != math.MaxUint64 {
		t.Fatal("next round must count up and stop at the top, never wrap to 0")
	}
}

// T-1: x is a candidate of p2, which it shares with p1's holder d1, and is in
// nothing of p1. It tells d1 that p1's key is promised at the top of the round
// range (a status, a NACK and an unverified commit), and asks p1's acceptors
// to promise p2's key there. Neither moves any round: d1 keeps renewing p1
// with ordinary rounds, no acceptor promises a ballot far above what it
// knows, and both keys keep a holder.
func TestForeignSenderCannotPushRoundsToTheTop(t *testing.T) {
	w, keyP2 := foreignWorld(t, "x", "d1")
	since := w.now
	top := Ballot{Round: math.MaxUint64 - 1, Incarnation: 1, Proposer: "x"}
	inject := func() {
		manifest := w.nodes["d1"].node.manifests["p1"]
		w.injectFrom("x", "d1",
			&pb.LeaseItem{Body: &pb.LeaseItem_Status{Status: &pb.LeaseStatus{
				Key: keyP1.proto(), State: pb.LeaseKeyState_LEASE_KEY_STATE_FREE, Promised: top.proto(),
				Epoch: manifest.Epoch, ManifestVersion: manifest.Version,
			}}},
			&pb.LeaseItem{Body: &pb.LeaseItem_Nack{Nack: &pb.LeaseNack{
				Key: keyP1.proto(), Ballot: w.nodes["d1"].node.proposers[keyP1].lastIssued.proto(),
				Reason: pb.LeaseNackReason_LEASE_NACK_REASON_BALLOT_TOO_LOW, Promised: top.proto(),
			}}},
			&pb.LeaseItem{Body: &pb.LeaseItem_Commit{Commit: &pb.LeaseCommit{
				Key: keyP1.proto(), Ballot: top.proto(), Epoch: manifest.Epoch, ManifestVersion: manifest.Version,
			}}},
		)
		p2 := w.nodes["x"].node.manifests["p2"]
		own := Ballot{Round: math.MaxUint64 - 1, Incarnation: w.nodes["x"].node.incarnation, Proposer: "x"}
		for _, relay := range []string{"r1", "r2", "r3"} {
			w.injectFrom("x", relay, &pb.LeaseItem{Body: &pb.LeaseItem_Prepare{Prepare: &pb.LeasePrepare{
				Key: keyP2.proto(), Ballot: own.proto(), Epoch: p2.Epoch, ManifestVersion: p2.Version,
			}}})
		}
	}
	for end := w.now + 3*time.Minute; w.now < end; {
		inject()
		w.runUntil(w.now + RenewInterval)
	}
	w.requireClean(t)
	if holder := w.holder(keyP1); holder != "d1" || w.fencesSince("d1", keyP1, since) != 0 {
		t.Fatalf("p1 holder %q, fences on d1 %d: the foreign rounds disturbed the holder", holder, w.fencesSince("d1", keyP1, since))
	}
	if holder := w.holder(keyP2); holder == "" {
		t.Fatal("p2 lost its holder to the forged prepares")
	}
	if round := w.nodes["d1"].node.proposers[keyP1].maxRound; round >= maxBallotJump {
		t.Fatalf("d1 took round %d of p1 from a sender outside p1", round)
	}
	for _, relay := range []string{"r1", "r2", "r3"} {
		for _, key := range []Key{keyP1, keyP2} {
			if view, ok := w.acceptorViewOn(relay, key); !ok || view.Promised.Round >= maxBallotJump {
				t.Fatalf("%s promised %s for %s", relay, view.Promised, key)
			}
		}
	}
}

// injectClock sends a batch from `from` that carries only a sender clock,
// optionally echoing the destination's current clock so that the batch
// counts as round-trip bounded (D4).
func (w *simWorld) injectClock(from, to string, clock time.Duration, echo bool) {
	src, dst := w.nodes[from].node, w.nodes[to]
	src.mu.Lock()
	src.messageSeq++
	batch := &pb.LeaseBatch{
		MessageId: fmt.Sprintf("%s/forged/%d", from, src.messageSeq), SenderId: from, SenderIncarnation: src.incarnation,
		DestinationId: to, SenderClockMs: clockMillis(clock), SenderClockOrigin: src.clockOrigin,
	}
	src.mu.Unlock()
	if echo {
		batch.EchoClockMs, batch.EchoClockOrigin = clockMillis(dst.local()), dst.node.clockOrigin
	}
	w.send(from, to, batch)
}

// T-2: a sender forges a freeze of the holder's host: a batch that echoes the
// holder's clock, so it forms the freeze reference, then 600 ms later one
// whose clock jumped an hour. From x, a candidate of another policy only,
// the holder drops both and keeps its lease. From r1, a member of the
// holder's policy, the clock is trusted by design (D4) and the holder
// fences: the batches are a real freeze signal.
func TestForeignSenderCannotForgeAFreeze(t *testing.T) {
	for _, tc := range []struct {
		sender string
		fence  bool
	}{{"x", false}, {"r1", true}} {
		t.Run(tc.sender, func(t *testing.T) {
			w, _ := foreignWorld(t, "x")
			since := w.now
			sender := w.nodes[tc.sender]
			w.injectClock(tc.sender, "d1", sender.local(), true)
			w.runUntil(w.now + 600*time.Millisecond)
			w.injectClock(tc.sender, "d1", sender.local()+time.Hour, false)
			w.runUntil(w.now + 10*time.Second)
			fences := w.fencesSince("d1", keyP1, since)
			if tc.fence {
				if fences == 0 {
					t.Fatal("the forged clock jump from a member did not fence: the test does not reach the detector")
				}
				return
			}
			w.requireClean(t)
			if fences != 0 || w.holder(keyP1) != "d1" {
				t.Fatalf("fences on d1 since the injection: %d, holder %q", fences, w.holder(keyP1))
			}
			if len(w.nodes["d1"].node.peerClocks["x"].samplesOrNil()) != 0 {
				t.Fatal("d1 kept clock samples of a sender outside its policies")
			}
		})
	}
}

func (pc *peerClock) samplesOrNil() []clockSample {
	if pc == nil {
		return nil
	}
	return pc.samples
}

// A forwarded manifest is adopted only when it names the receiver or updates
// a policy it holds, and a sender that no adopted manifest names together
// with the receiver is refused like an unknown one.
func TestForwardedManifestsAndSendersOutsideSharedPolicies(t *testing.T) {
	relayKey, relayDER := newIdentity(t)
	peerKey, peerDER := newIdentity(t)
	strangerKey, strangerDER := newIdentity(t)
	node, _, policy := wireNode(t, "r1", relayKey, map[string][]byte{"r1": relayDER, "r2": peerDER})
	identities := map[string][]byte{"r1": relayDER, "r2": peerDER, "s1": strangerDER}
	signers := map[string]Signer{"r2": ECDSASigner{Key: peerKey}, "s1": ECDSASigner{Key: strangerKey}}
	manifest := func(policyID string, version uint64, ids ...string) *pb.LeaseSignedBlock {
		return manifestBlock(t, policy, func(m *pb.LeaseManifest) {
			m.PolicyId, m.ManifestVersion, m.Candidates, m.Members = policyID, version, nil, nil
			for _, id := range ids {
				m.Candidates = append(m.Candidates, &pb.LeaseCandidate{Id: id, PublicKey: identities[id]})
				m.Members = append(m.Members, &pb.LeaseMember{Id: id, PublicKey: identities[id], Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY})
			}
			m.QuorumSets = []*pb.LeaseQuorumSet{{VoterIds: ids}}
		})
	}
	sent := 0
	send := func(from string, blocks ...*pb.LeaseSignedBlock) error {
		t.Helper()
		sent++
		batch := &pb.LeaseBatch{MessageId: fmt.Sprintf("%s/%d", from, sent), SenderId: from, SenderIncarnation: 1, DestinationId: "r1", Blocks: blocks}
		frame, err := SealFrame(batch, signers[from])
		if err != nil {
			t.Fatal(err)
		}
		return node.ReceiveFrame(frame)
	}
	// p9 names only the stranger: it is not adopted from a frame, and the
	// stranger stays unknown.
	if err := send("s1", manifest("p9", 1, "s1")); !errors.Is(err, ErrUnknownSender) {
		t.Fatalf("frame from a sender of an unrelated policy: %v, want ErrUnknownSender", err)
	}
	if node.ManifestVersion("p9") != 0 {
		t.Fatal("a forwarded manifest that does not name the receiver was adopted")
	}
	// p8 names the stranger and r2 but not r1: the Gateway delivered it, so
	// the stranger authenticates, yet it shares no policy with r1.
	if _, err := node.AdoptManifest(manifest("p8", 1, "r2", "s1")); err != nil {
		t.Fatal(err)
	}
	if err := send("s1"); !errors.Is(err, ErrUnknownSender) {
		t.Fatalf("frame from a sender sharing no policy: %v, want ErrUnknownSender", err)
	}
	// r2 forwards a newer p8 (a policy r1 holds) and p7, which names r1.
	if err := send("r2", manifest("p8", 2, "r2", "s1"), manifest("p7", 1, "r1", "s1")); err != nil {
		t.Fatalf("frame from a peer of a shared policy: %v", err)
	}
	if node.ManifestVersion("p8") != 2 || node.ManifestVersion("p7") != 1 {
		t.Fatalf("forwarded manifests p8 v%d, p7 v%d; want v2 and v1", node.ManifestVersion("p8"), node.ManifestVersion("p7"))
	}
	// p7 names both: now the stranger coordinates with r1.
	if err := send("s1"); err != nil {
		t.Fatalf("frame from a sender of a shared policy: %v", err)
	}
}
