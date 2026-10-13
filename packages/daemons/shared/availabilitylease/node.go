package availabilitylease

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// Transport hands sealed frames to the relay streams. It must not call back
// into the Node synchronously.
type Transport interface {
	Send(frame *pb.CoordinationFrame)
}

type Config struct {
	// ID is this node's identity: the voter/candidate id in manifests.
	ID        string
	Clock     Clock
	Store     Store
	Transport Transport
	Signer    Signer
	// Verifier defaults to ECDSA P-256.
	Verifier Verifier
	// Logf receives diagnostic messages; optional.
	Logf func(format string, args ...any)
	// IncarnationFloor keeps incarnations increasing when the store was lost
	// (relay.db renamed, state directory wiped): pass the wall clock in
	// milliseconds. Peers drop frames from an incarnation lower than one they
	// saw (A9), and ballots must stay unique (A3).
	IncarnationFloor uint64
	// FreezeSkewBudget and FreezeDriftRate tune the peer-time freeze
	// detector (freeze.go); zero means DefaultFreezeSkewBudget and
	// DefaultFreezeDriftRate.
	FreezeSkewBudget time.Duration
	FreezeDriftRate  float64
}

// Node runs the acceptor and proposer roles of one process. Every method is
// safe for concurrent use; outgoing frames are sent after the lock is released.
type Node struct {
	mu        sync.Mutex
	id        string
	clock     Clock
	store     Store
	transport Transport
	signer    Signer
	// previousSigner dual-signs during an identity-key rotation; currentKey
	// is the public key of signer once rotated.
	previousSigner Signer
	keyCache       map[string][][]byte
	currentKey     []byte
	overlapSince   time.Duration
	verifier       Verifier
	logf           func(format string, args ...any)

	incarnation uint64
	startedAt   time.Duration
	// abstainUntil is when this node's votes start to count (A3).
	abstainUntil time.Duration
	chain        *keyChain
	// history keeps each policy's recent voter configs, oldest first, to
	// verify commits formed under an earlier voter epoch.
	history   map[string][]*VoterConfig
	manifests map[string]*Manifest

	acceptors map[Key]*acceptorKey
	proposers map[Key]*proposerKey
	ready     map[string]bool
	renewAt   time.Duration
	// Stateful policies (v3, state_*.go): application handlers per policy,
	// holder records to persist, and the store-created marker (M1).
	handlers     map[string]*StateHandler
	holderDirty  map[Key]bool
	storeCreated uint64

	outbox     map[string][]*pb.LeaseItem
	attach     map[string]map[string]bool
	loopback   []*pb.LeaseItem
	dirty      map[Key]bool
	dirtyOther map[string][]byte
	deletes    []string
	seen       map[string]struct{}
	seenOrder  []string
	peers      map[string]uint64
	forwarded  map[string]forwardMark
	messageSeq uint64
	echoSeq    uint64
	events     []Event

	// Peer-time freeze detection (D4, freeze.go).
	clockOrigin      uint64
	freezeBudget     time.Duration
	freezeDrift      float64
	peerClocks       map[string]*peerClock
	peerClockSweepAt time.Duration
	beacons          map[string]bool
	freezes          []FreezeEvent
	// freezeBoundary is the local time of the last detected freeze: the
	// relay gate stays closed for accepts anchored at or before it.
	freezeBoundary time.Duration
	frozeOnce      bool

	// rawSend bypasses sealing; the simulator uses it for speed.
	rawSend func(to string, batch *pb.LeaseBatch)
}

type outgoing struct {
	to      string
	batch   *pb.LeaseBatch
	signers []Signer
}

const dedupCapacity = 8192

// NewNode loads persisted state, bumps and persists the incarnation (A3) and
// starts the acceptor abstention window.
func NewNode(cfg Config) (*Node, error) {
	if cfg.ID == "" || cfg.Clock == nil || cfg.Store == nil || cfg.Signer == nil {
		return nil, errors.New("availability lease node needs id, clock, store and signer")
	}
	n := &Node{
		id: cfg.ID, clock: cfg.Clock, store: cfg.Store, transport: cfg.Transport, signer: cfg.Signer,
		verifier: cfg.Verifier, logf: cfg.Logf, chain: newKeyChain(), manifests: map[string]*Manifest{},
		history: map[string][]*VoterConfig{}, acceptors: map[Key]*acceptorKey{}, proposers: map[Key]*proposerKey{}, ready: map[string]bool{},
		outbox: map[string][]*pb.LeaseItem{}, attach: map[string]map[string]bool{}, dirty: map[Key]bool{},
		dirtyOther: map[string][]byte{}, seen: map[string]struct{}{}, peers: map[string]uint64{},
		forwarded: map[string]forwardMark{}, peerClocks: map[string]*peerClock{}, beacons: map[string]bool{},
		handlers: map[string]*StateHandler{}, holderDirty: map[Key]bool{},
		freezeBudget: cfg.FreezeSkewBudget, freezeDrift: cfg.FreezeDriftRate,
	}
	if n.freezeBudget <= 0 {
		n.freezeBudget = DefaultFreezeSkewBudget
	}
	if n.freezeDrift <= 0 {
		n.freezeDrift = DefaultFreezeDriftRate
	}
	if origin, ok := cfg.Clock.(ClockOrigin); ok {
		n.clockOrigin = origin.Origin()
	}
	for n.clockOrigin == 0 {
		var buf [8]byte
		_, _ = rand.Read(buf[:])
		n.clockOrigin = binary.BigEndian.Uint64(buf[:])
	}
	if n.verifier == nil {
		n.verifier = &ECDSAVerifier{}
	}
	if n.logf == nil {
		n.logf = func(string, ...any) {}
	}
	records, err := cfg.Store.Load()
	if err != nil {
		return nil, fmt.Errorf("load availability lease state: %w", err)
	}
	if err := n.restore(records); err != nil {
		return nil, err
	}
	n.incarnation++
	if cfg.IncarnationFloor > n.incarnation {
		n.incarnation = cfg.IncarnationFloor
	}
	now := cfg.Clock.Now()
	n.startedAt = now
	n.renewAt = now
	// A3: votes do not count for AbstainAfterStart unless the store proves it
	// was written earlier in this boot (a process restart); then the hold of
	// every key's last counted accept is restored instead (restoreHolds).
	n.abstainUntil = now + AbstainAfterStart
	if stamp, ok := decodeBootStamp(records[recordBootStamp]); ok && stamp.origin == n.clockOrigin && stamp.clock <= now {
		n.abstainUntil = stamp.abstainUntil
		n.restoreHolds(now)
	}
	puts := map[string][]byte{recordIncarnation: encodeUint64(n.incarnation), recordBootStamp: n.bootStamp(now)}
	n.markStore(records, puts)
	if err := cfg.Store.Apply(puts, nil); err != nil {
		return nil, fmt.Errorf("persist availability lease incarnation: %w", err)
	}
	return n, nil
}

// restoreHolds replaces the restart abstention after a process restart
// within the same boot. Only counted accepts create holds, and every one was
// persisted with its lease clock reading before its reply left, so the hold
// of the latest one is restored exactly: it lapses when it would have without
// the restart. Promises are persisted too. What the restart loses (release
// reservations, echo anchors, shadow state) affects liveness and the relay
// gate only, never whose lease this acceptor protects, so a rolling restart
// of the voters does not cost a quorum.
func (n *Node) restoreHolds(now time.Duration) {
	for _, ak := range n.acceptors {
		accepted := ak.rec.Accepted
		if accepted == nil || accepted.Ballot.IsZero() || time.Duration(accepted.AtNs) > now {
			continue
		}
		if released, ok := ak.rec.Released[accepted.Ballot.Proposer]; ok && !released.Less(accepted.Ballot) {
			continue
		}
		ak.lease = acceptedLease{holder: accepted.Ballot.Proposer, ballot: accepted.Ballot, at: time.Duration(accepted.AtNs), open: true}
	}
}

// Abstaining reports whether this node's votes do not count yet (A3).
func (n *Node) Abstaining() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.clock.Now() < n.abstainUntil
}

func (n *Node) restore(records map[string][]byte) error {
	if data, ok := records[recordIncarnation]; ok {
		value, err := decodeUint64(data)
		if err != nil {
			return err
		}
		n.incarnation = value
	}
	if data, ok := records[recordKeyChain]; ok {
		if err := n.chain.decode(data); err != nil {
			return fmt.Errorf("decode policy key chain: %w", err)
		}
	}
	for _, name := range sortedKeys(records) {
		data := records[name]
		switch {
		case strings.HasPrefix(name, prefixLink):
			link := &pb.LeasePolicyKeyRotation{}
			if proto.Unmarshal(data, link) == nil {
				n.chain.links[link.GetKeyId()] = link
			}
		case strings.HasPrefix(name, prefixVoters):
			block := &pb.LeaseSignedBlock{}
			if proto.Unmarshal(data, block) != nil {
				continue
			}
			if manifest, err := parseManifest(block); err == nil {
				n.rememberVoters(manifest.Voters)
			}
		case strings.HasPrefix(name, prefixManifest):
			block := &pb.LeaseSignedBlock{}
			if proto.Unmarshal(data, block) != nil {
				continue
			}
			if manifest, err := parseManifest(block); err == nil {
				n.manifests[manifest.PolicyID] = manifest
				n.rememberVoters(manifest.Voters)
			}
		case strings.HasPrefix(name, prefixKey):
			record, err := decodeKeyRecord(data)
			key, ok := parseKeyName(name, prefixKey)
			if err != nil || !ok {
				continue
			}
			n.acceptors[key] = restoreAcceptorKey(record)
		case strings.HasPrefix(name, prefixHolder):
			n.restoreHolderRecord(name, data)
		}
	}
	return nil
}

// ID returns the node identity.
func (n *Node) ID() string { return n.id }

// Incarnation returns the persisted incarnation of this process.
func (n *Node) Incarnation() uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.incarnation
}

// run executes fn under the lock, persists dirty state, and sends the
// resulting frames after unlocking.
func (n *Node) run(fn func(now time.Duration)) {
	n.mu.Lock()
	now := n.clock.Now()
	fn(now)
	n.processLoopback(now)
	n.retireIdentityOverlap(now)
	out := n.commitLocked(now)
	n.mu.Unlock()
	n.send(out)
}

// Tick drives timers. Call it at NextWakeup or at least every 250 ms.
func (n *Node) Tick() {
	n.run(func(now time.Duration) { n.tickProposers(now) })
}

// NextWakeup returns the local clock value at which Tick is next needed.
func (n *Node) NextWakeup() time.Duration {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.nextWakeup(n.clock.Now())
}

func (n *Node) receiveLocked(batch *pb.LeaseBatch, now time.Duration) {
	from := batch.GetSenderId()
	if id := batch.GetMessageId(); id != "" {
		if _, dup := n.seen[id]; dup {
			return
		}
		n.seen[id] = struct{}{}
		n.seenOrder = append(n.seenOrder, id)
		if len(n.seenOrder) > dedupCapacity {
			delete(n.seen, n.seenOrder[0])
			n.seenOrder = n.seenOrder[1:]
		}
	}
	// A9: a frame from an older incarnation of the sender is a replay.
	if incarnation := batch.GetSenderIncarnation(); incarnation < n.peers[from] {
		return
	} else if incarnation > n.peers[from] {
		// A restarted peer may have lost its blocks: forward them again.
		n.peers[from] = incarnation
		for name := range n.forwarded {
			if strings.HasPrefix(name, from+"\x00") {
				delete(n.forwarded, name)
			}
		}
	}
	// D4: the sender's clock is checked before the items, so a key held
	// across a freeze of this host fences before anything else it carries
	// can extend or anchor it.
	n.observePeerClock(from, batch, now)
	for _, item := range batch.GetItems() {
		n.handleItem(from, item, now)
	}
}

func (n *Node) processLoopback(now time.Duration) {
	for guard := 0; len(n.loopback) > 0 && guard < 64; guard++ {
		items := n.loopback
		n.loopback = nil
		for _, item := range items {
			n.handleItem(n.id, item, now)
		}
	}
}

func (n *Node) handleItem(from string, item *pb.LeaseItem, now time.Duration) {
	switch body := item.GetBody().(type) {
	case *pb.LeaseItem_Prepare:
		n.onPrepare(from, body.Prepare, now)
	case *pb.LeaseItem_Promise:
		n.onPromise(from, body.Promise, now)
	case *pb.LeaseItem_Propose:
		n.onPropose(from, body.Propose, now)
	case *pb.LeaseItem_Accepted:
		n.onAccepted(from, body.Accepted, now)
	case *pb.LeaseItem_Nack:
		n.onNack(from, body.Nack, now)
	case *pb.LeaseItem_Commit:
		n.reportLag(from, body.Commit)
		n.storeCommit(body.Commit, now)
		n.observeCommit(body.Commit, true, now)
	case *pb.LeaseItem_Release:
		n.onRelease(from, body.Release, now)
	case *pb.LeaseItem_ReleaseAck:
		n.onReleaseAck(from, body.ReleaseAck, now)
	case *pb.LeaseItem_Query:
		n.onQuery(from, body.Query, now)
	case *pb.LeaseItem_Status:
		n.onStatus(from, body.Status, now)
	case *pb.LeaseItem_Retain:
		n.onRetain(from, body.Retain, now)
	case *pb.LeaseItem_Retained:
		n.onRetained(from, body.Retained, now)
	}
}

// queue adds an item for dest; items for this node loop back locally.
func (n *Node) queue(dest string, item *pb.LeaseItem) {
	if dest == n.id {
		n.loopback = append(n.loopback, item)
		return
	}
	n.outbox[dest] = append(n.outbox[dest], item)
}

// commitLocked persists dirty state and builds outgoing batches. If the
// write fails nothing is sent and the node abstains, which is always safe.
func (n *Node) commitLocked(now time.Duration) []outgoing {
	if len(n.dirty) > 0 || len(n.dirtyOther) > 0 || len(n.deletes) > 0 || len(n.holderDirty) > 0 {
		puts := n.dirtyOther
		for key := range n.dirty {
			if ak := n.acceptors[key]; ak != nil {
				puts[keyRecordName(key)] = encodeKeyRecord(ak.rec)
			}
		}
		n.holderPuts(puts)
		puts[recordBootStamp] = n.bootStamp(now)
		err := n.store.Apply(puts, n.deletes)
		n.dirty, n.dirtyOther, n.deletes, n.holderDirty = map[Key]bool{}, map[string][]byte{}, nil, map[Key]bool{}
		if err != nil {
			n.logf("availability lease state write failed, abstaining: %v", err)
			n.abstainUntil = max(n.abstainUntil, now+AbstainAfterStart)
			n.outbox, n.attach, n.beacons = map[string][]*pb.LeaseItem{}, map[string]map[string]bool{}, map[string]bool{}
			return nil
		}
	}
	if len(n.outbox) == 0 && len(n.attach) == 0 && len(n.beacons) == 0 {
		return nil
	}
	dests := map[string]bool{}
	for dest := range n.outbox {
		dests[dest] = true
	}
	for dest := range n.attach {
		dests[dest] = true
	}
	for dest := range n.beacons {
		dests[dest] = true
	}
	out := make([]outgoing, 0, len(dests))
	for _, dest := range sortedKeys(dests) {
		n.messageSeq++
		batch := &pb.LeaseBatch{
			MessageId: fmt.Sprintf("%s/%d/%d", n.id, n.incarnation, n.messageSeq),
			SenderId:  n.id, SenderIncarnation: n.incarnation, DestinationId: dest, Items: n.outbox[dest],
			SenderClockMs: clockMillis(now), SenderClockOrigin: n.clockOrigin,
		}
		n.echoFor(batch, dest, now)
		if policies := n.attach[dest]; len(policies) > 0 {
			for _, policyID := range sortedKeys(policies) {
				if manifest := n.manifests[policyID]; manifest != nil {
					batch.Blocks = append(batch.Blocks, manifest.block)
				}
			}
			batch.KeyRotations = n.chain.chainLinks()
		}
		out = append(out, outgoing{to: dest, batch: batch, signers: n.signers()})
	}
	n.outbox, n.attach, n.beacons = map[string][]*pb.LeaseItem{}, map[string]map[string]bool{}, map[string]bool{}
	return out
}

// clockMillis is the lease clock carried in batches; 0 means "not sent", so a
// clock reading in its first millisecond is sent as 1.
func clockMillis(now time.Duration) uint64 {
	if ms := now.Milliseconds(); ms > 0 {
		return uint64(ms)
	}
	return 1
}

func (n *Node) send(out []outgoing) {
	for _, message := range out {
		if n.rawSend != nil {
			n.rawSend(message.to, message.batch)
			continue
		}
		if n.transport == nil {
			continue
		}
		frame, err := SealFrame(message.batch, message.signers...)
		if err != nil {
			n.logf("seal availability lease frame: %v", err)
			continue
		}
		n.transport.Send(frame)
	}
}

func (n *Node) markDirty(key Key) { n.dirty[key] = true }

func (n *Node) emit(event Event) { n.events = append(n.events, event) }

// DrainEvents returns lease transitions since the last call, for lease
// reports and audit events.
func (n *Node) DrainEvents() []Event {
	n.mu.Lock()
	defer n.mu.Unlock()
	events := n.events
	n.events = nil
	return events
}
