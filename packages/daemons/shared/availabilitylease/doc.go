// Package availabilitylease is the data-plane lease protocol for Docker
// Availability failover: a PaxosLease variant in which relays and a bounded
// set of daemons are acceptors and candidate docker daemons are proposers.
// The Gateway only publishes signed manifests; it never decides failover.
//
// The package is pure protocol logic. It performs no I/O of its own: time
// comes from a Clock, durability from a Store, frames leave through a
// Transport, and identity signatures come from a Signer. Everything is
// deterministic given those inputs, which is what the seeded simulator in
// the tests relies on.
//
// # Keys, ballots, roles
//
// A lease key is (policyId, slot): failover policies use slot 0, replicated
// policies slots 0..desiredReplicaCount-1 (D1). A ballot is (round,
// incarnation, proposer id), ordered in that order; the incarnation is
// persisted and bumped on every start (A3). Every acquisition and every
// renewal is a fresh prepare/propose round with a new ballot (A11).
//
// Voters are per policy (A18). Every manifest carries its policy's voter
// set: members (the voters plus every relay serving the policy, with their
// identity keys), one quorum set (two during a joint-consensus change) and a
// per-policy voter epoch. There is no cluster-wide voter set. A node that
// votes for policy A has no vote in policy B: every membership check, QC and
// gate is evaluated against the key's own policy.
//
// One Node per process plays every role it is configured for:
//   - acceptor, per policy, when the policy's manifest lists the node as a
//     member. Members in a quorum set vote; other members (relays that are
//     not the witness) and voters inside their restart abstention only record
//     shadow promises and accepts, which the relay gate uses;
//   - proposer, for every slot of every policy whose manifest lists the node
//     as a candidate and that the daemon marked ready. Candidates need not be
//     voters (A18 cap of 7). A node never acquires a slot while it holds,
//     recovers, fences or releases another slot of the policy (designated
//     successor or bootstrap holder included), and takes its own last slot
//     back before a foreign one. A slot the latest manifest removed (scale-down,
//     lowered surge) gets no new rounds or queries; a holder of it keeps its
//     deadline until the daemon releases it (A6) or the timer fences it;
//   - relay gate evaluator (Gate), on relays.
//
// # Timing (D5, A1, A3, A11)
//
//	LeaseTerm          T = 30 s
//	AcceptorHold       T x 1.1 = 33 s: an acceptor refuses other proposers
//	                   until 33 s after its last accept of the holder
//	AbstainAfterStart  33 s: no votes after fresh state, a start on another
//	                   boot or a failed write; a restart within the same
//	                   boot (the store's boot stamp) restores the persisted
//	                   hold of each key's last counted accept instead
//	RenewInterval      5 s, one schedule per node so renewals of all keys
//	                   share frames
//	SoftFenceAfter     15 s after the send time of the last successful round
//	FenceCompleteAfter 24 s: the container must be dead (watchdog deadline)
//	RankStep           2 s per manifest rank before a takeover
//	SuccessorWindow    10 s during which only the designated successor may
//	                   acquire after a release
//	GateWindow         24 s: a relay admits the holder for at most this long
//	                   after its own promise of the committed ballot
//
// A 10% slow holder is dead 26.7 real seconds after the send time of its
// last successful round; a 10% fast acceptor refuses others for 30 real
// seconds after an accept that happened after that send. A 10% slow relay
// closes its gate 26.7 s after its promise, which precedes the propose and
// therefore every accept of the ballot (see Gate below).
//
// # Wiring
//
//	node, err := availabilitylease.NewNode(availabilitylease.Config{
//		ID:        identityID,               // voter/candidate id in manifests
//		Clock:     availabilitylease.SystemClock(), // CLOCK_BOOTTIME on Linux
//		Store:     store,                    // durable, fsync before return
//		Transport: transport,                // sends *relayv1.CoordinationFrame
//		Signer:    availabilitylease.ECDSASigner{Key: tlsIdentityKey},
//		IncarnationFloor: uint64(time.Now().UnixMilli()),
//	})
//
// Store.Apply must be atomic and durable: promised ballots are written
// through it before any reply leaves (A3). A failed write drops the replies
// and restarts the abstention window. The relay backs Store with a relay.db
// bucket; daemons with a file in their state directory. Pass the wall clock
// as IncarnationFloor so incarnations keep increasing when the store is lost
// (relay.db renamed): peers drop frames from lower incarnations (A9).
//
// Trust and blocks. Call TrustPolicyKey with the Gateway policy signing key
// received over an authenticated channel (daemon CommandStream; relay
// verified policy envelope), AdoptKeyRotation for rotation links, and
// AdoptManifest for signed manifests, which include the policy's voters. It
// returns true once the manifest is durably adopted: that is the "persisted
// ack" the Gateway waits for (A4). A manifest whose voter epoch goes back is
// rejected. Epoch(policy) and ManifestVersion(policy) report what is adopted. Nodes also adopt newer blocks (of a policy they hold
// or that names them) and rotation links that arrive inside frames, and forward theirs to lagging peers on first
// contact, on NACKs and on lag reports, so failover never waits for the
// Gateway (A4, A14).
//
// Driving. Hand every frame addressed to this node to ReceiveFrame. A frame
// (and an accept statement) is authentic when any of its signatures verifies
// under any key listed for the sender in any adopted manifest or remembered
// voter config; votes still count only in the key's own policy (A18) and
// replay binding (A9) is unchanged. Only a sender that an adopted manifest
// names together with this node coordinates with it. ErrUnknownSender means
// the node lacks such blocks; it answers with a lag report. Call Tick
// at NextWakeup (a local clock value) or at least every 250 ms.
//
// Identity-key renewal (relay and daemon certificates). Call
// RotateIdentityKey(nextSigner, nextPublicKeyDER) as soon as the renewed key
// is in use. The node then signs every frame and accept with the new key and
// also with the previous one (additional_signatures), until every adopted
// manifest that names the node lists the new key, or IdentityKeyOverlap
// (24 h) passed; IdentityOverlap reports it. The overlap is in memory: after
// a restart during it, call RotateIdentityKey again with the previous key as
// Config.Signer. The Gateway republishes manifests with the new key (T3).
//
// # Docker daemon (T4)
//
//   - SetCandidateReady(policy, ready): ready only while the standby is
//     prepared and the watchdog heartbeat is fresh (A12.4). A node acquires
//     keys by rank on its own; one slot per node in replicated mode.
//   - HolderStatus(key) is the whole contract for the container:
//     MayStart: start or restart the container only while true (A2.1, A5);
//     Deadline: write the watchdog record (container id, cgroup, Deadline)
//     after create and before every start, and on every change (A12.1);
//     FenceNow/SoftFenceAt: stop the container now (docker stop with
//     min(stop timeout, 10 s), then kill); the watchdog kills the cgroup at
//     Deadline regardless.
//   - FenceComplete(key) once the cgroup is confirmed empty, never before.
//     After any local fence (timer, recovery, host freeze, lost watchdog,
//     abandoned renewals, lease closed, slot removed) the node then releases
//     the key, to the relays, the members and every candidate, so the next
//     candidate by rank takes over at once (B-9). Only a fence for another
//     holder's commit releases nothing.
//   - Release(key, successor) for a planned handoff or a health release
//     (D6, D9), only after the cgroup is empty and the endpoint is
//     deregistered (A6). The node relinquishes every relay gate first and
//     releases the acceptors only when all relays acked or RelinquishWait
//     passed. If the stop does not complete, call Abandon(key) instead: the
//     node stops renewing and the watchdog fences. AbandonFor names the
//     reason of the fence event (for example FenceWatchdogLost).
//   - Recover(key, deadline) on daemon start for every lease-mode container
//     found running, with the watchdog record's deadline (A2.3). The node
//     renews until RecoverStopReserve (2 s) before that deadline, else
//     FenceNow turns true, so a slow restart (a rolling update) keeps its
//     slot whenever a round succeeds in time.
//   - LeaseMode(policy): while true refuse every backend start or serve
//     command for the policy's placements unless HolderStatus.MayStart (A5).
//   - BeaconRelays every BeaconInterval: an empty batch that carries only
//     the clock, so relays detect their own freezes (D4). Freezes of this
//     host are detected from the peers' clocks in every batch (freeze.go):
//     every key held when one is detected fences at once (FenceFrozen) with
//     its deadline moved back by the frozen time; DrainFreezes reports them.
//     The wall clock is never evidence of a freeze.
//   - DrainEvents: acquired, fence, released and handoff transitions for
//     lease reports in the heartbeat and audit events (D9). Holders lists
//     current holder statuses.
//
// # Relay (T2)
//
// A relay routes CoordinationFrame by destination_id to the stream of that
// identity; frames addressed to the relay itself go to ReceiveFrame. The
// relay's Node is an acceptor (voting or shadow) and evaluates Gate(key) for
// Secure Link endpoint registrations, tunnels and managed-DB tunnels
// (A2.4, A8, A11):
//
//   - LeaseMode false: no lease manifest for the policy, or it is lease
//     closed. Apply the legacy admission rules.
//   - Open with Holder and Ballot: admit that holder's placement only; cut
//     every other registration or tunnel for the key immediately.
//   - Closed with a reason: admit nobody for the key.
//
// The gate opens only for the holder of the highest valid commit when this
// relay itself accepted (or shadow-accepted) that ballot, or an earlier one
// of the same holder, with an echo of its own promise, while nothing
// supersedes it, and for at most GateWindow of local time after the latest
// such promise. A renewal this relay missed therefore neither closes the gate
// nor extends it. Proposers send a propose to every member whose promise
// arrives before the round deadline, even after the round reached its
// quorum. After a freeze of the relay's host, detected from a member's
// clock, the gate stays closed until the relay promises afresh (D4); the
// relay coordinator calls Beacon for its connected members every
// BeaconInterval and when one connects. Re-evaluate on every registration and
// tunnel and at least every second; Until says when it closes. AcceptorView
// feeds GetHealth. A relay votes for a policy only when it is that policy's
// witness; to keep shadow accepts for its gate it must be listed as a member
// of every policy whose traffic it carries (A18). Only relays of
// operator-owned pools may be witnesses (A9), enforced by the Gateway.
//
// # nginx daemon (T5)
//
// nginx daemons are observers only (A18): they are never voters. Socket
// state comes from the relay gate views they learn, each with a TTL of at
// most T.
//
// # Gateway obligations (T3, T6)
//
//   - Sign manifests with the relay policy key (Ed25519) over
//     "gateway-availability-lease/manifest/v1" 0x00 || payload. The domain
//     prefix keeps these signatures apart from policy envelopes, which the
//     same key signs over raw bytes.
//   - Manifest: candidates in rank order with their identity keys, mode,
//     partition mode, slots, lease_term_ms 0 or 30000, and the policy's
//     voters (A18, A19, A20): members, quorum_sets, voter_epoch. The voters
//     are the distinct hosts among the candidates in rank order plus
//     witness(es) up to an odd count of at least 3, at most 7 per quorum set,
//     deduplicated by physical host across docker, nginx and relay (the
//     library only rejects duplicate member ids). Members also list every
//     relay that serves the policy (role RELAY, outside the quorum sets) so
//     its gate keeps shadow accepts. Bump manifest_version on every change
//     and voter_epoch on every voter change; voter_epoch never goes back.
//   - Voter change (candidate or witness change), per policy: publish a
//     joint manifest (voter_epoch E+1, quorum sets old and new), then a
//     settled one (E+2, new set only) once a majority of both sets acked E+1
//     (Epoch(policy) >= E+1 after AdoptManifest), every active lease of the
//     policy renewed under E+1, and at least T x 1.1 / 0.9 (37 s) passed
//     since those acks (D2, A4, A16).
//   - Bootstrap (A5): name the serving placement per slot with a new
//     bootstrap_id and keep the entry in every version until that holder
//     reported acquiring. Also the way to switch available to strict (A7):
//     strict counts as active only once every other copy stopped and
//     GateWindow passed.
//   - Lease closed (A5): publish closed=true; stay non-reactive until the
//     holder acks the close, or a majority of acceptors acked it and
//     T x 1.1 plus the fence margin passed.
//   - Key rotation (A14): publish the link signed by the previous key, sign
//     with the new key only after a majority of the voters of every policy
//     trust it (TrustsPolicyKey), then re-sign the current
//     manifests with the new key (same payload) so peers that only trust the
//     new key can verify forwarded blocks.
//
// # Frames and proto mapping (proto/relay/v1)
//
// CoordinationFrame{destination_id, sender_id, payload, signature,
// additional_signatures} carries
// one LeaseBatch per destination. Every batch also carries the sender's lease
// clock with its origin and an echo of the destination's clock (peer-time
// freeze detection, D4, freeze.go); a batch without items is a clock beacon. signature is ECDSA P-256 (ASN.1) by the
// sender's identity key over SHA-256("gateway-availability-lease/frame/v1"
// 0x00 || payload). LeaseBatch repeats sender, incarnation and destination
// inside the signed payload, has a message id for deduplication, and may
// carry LeaseSignedBlock and LeasePolicyKeyRotation entries. Items:
//
//	prepare      proposer -> policy members    phase 1, (voter epoch, manifest version)
//	promise      acceptor -> proposer          echo nonce; shadow when not voting
//	propose      proposer -> each promiser     phase 2, echoes that promise
//	accepted     acceptor -> proposer          signed accept statement
//	nack         acceptor -> proposer          reason, promised ballot,
//	                                           holder, latest commit (A13)
//	commit       holder   -> members and       QC: accepts of a majority of
//	                         candidates        every quorum set (A11)
//	release      holder   -> relays (RELINQUISH), then members and
//	                         successor (FINAL), bound to the ballot (A6, D9)
//	release_ack  member   -> holder
//	query        candidate -> members          status probe
//	status       member   -> candidate         FREE/HELD/RESERVED/ABSTAINING/
//	                                           CLOSED, latest commit; an
//	                                           empty status reports lag
//
// For stateful keys promise and status also carry the acceptor's memory
// (LeaseAcceptedState), propose and commit the state, accepted its hash.
//
// The accept statement signed by acceptors is
//
//	"gateway-availability-lease/accept/v1" 0x00
//	str(policy_id) u64(slot) u64(round) u64(incarnation) str(proposer_id)
//	u64(epoch) u64(manifest_version) str(acceptor_id) u64(acceptor_incarnation)
//
// with str = 4-byte big-endian length then bytes and u64 = 8-byte big
// endian. A rotation link is signed by the previous key over
// "gateway-availability-lease/key-rotation/v1" 0x00 || str(key_id) ||
// public_key. Accepts of stateful keys sign the v2 statement instead
// (below); stateless keys keep exactly these bytes.
//
// # Stateful policies (availability_lease_v3)
//
// A manifest with stateful = true (covered by its signature) gives every key a
// certified holder state, first used for the Postgres primary role. The state
// is a LeaseHolderState: the application's opaque value (at most
// MaxStateValueBytes) plus fields the library maintains: holder,
// pending_promotion, promoted_holder, generation, transition_id and a forced
// marker. Its encoded bytes are hashed as carried and never re-encoded.
// Propose carries the state, accepts sign
//
//	"gateway-availability-lease/accept/v2" 0x00 <v1 fields> u64(1) str(sha256(state))
//
// with the hash also in LeaseAccepted.state_hash, and a commit carries the
// state its QC certifies. A stateful manifest must be strict (the library
// rejects available), and a policy never changes whether it is stateful.
//
// Acceptor memory (AS1). Promises and statuses of a stateful key report the
// acceptor's highest accepted ballot and state, or UNKNOWN: when its store is
// fresh (a renamed relay.db, a lost state file), it has no accepted record,
// or it became a voter of the policy anew (not a voter under the previously
// adopted manifest, or voter epochs were skipped). It leaves UNKNOWN only by
// accepting, as a voting member, a propose that echoes a promise it issued in
// its current incarnation (NACK NO_PROMISE otherwise); a propose whose state
// does not decode or names another holder is refused (NACK STATE_INVALID).
// UNKNOWN and shadow reports never count.
//
// Rounds (AS2). Every round proposes the highest KNOWN accepted state of its
// promise quorum plus at most one transition:
//   - acquisition, including a designated successor: needs a KNOWN majority
//     of every quorum set and the application's StateHandler.Eligible on the
//     adopted state, with its ballot's proposer as PreviousHolder and whether
//     it was released (AS6). The same check runs on fresh query statuses
//     before any prepare, so an ineligible candidate never duels. The
//     proposal is the adopted state unchanged with this node as holder,
//     pending_promotion set and generation + 1. A stale-manifest NACK
//     restarts it under the delivered manifest at once;
//   - renewal and Recover: a strict voting majority. While the lease is
//     continuous (before the soft fence; for Recover, before the recorded
//     deadline) no other proposer can have been chosen, so the holder
//     proposes its own certified state, or a higher KNOWN ballot of its own;
//     a higher KNOWN ballot of another proposer fences it. Without its own
//     holder record the KNOWN-majority rule applies. The queued transition
//     rides along when its base is the adopted state (else it is rejected);
//   - bootstrap: the named holder with no holder record, once every voter of
//     every quorum set promised and nobody remembers anything but its own
//     earlier bootstrap attempts, proposes StateHandler.BootstrapValue (or its
//     highest earlier attempt); otherwise the acquisition rules apply;
//   - forced (ForceAcquire, AS10): skips only the eligibility check (with its
//     KNOWN-majority rule), still needs a strict voting majority, single use,
//     bound to the commit ballot the operator saw, expires after ForceWindow
//     or on any newer commit, and also when its own promise quorum reports
//     a ballot of another proposer accepted after that commit
//     (ForceStatus.Newer; forcing again is a new decision over it); the
//     state records the forced marker.
//
// The application proposes one Transition at a time (ProposeTransition) and
// acts only once CommittedState shows it; until then it configures for the
// certified state AND PendingState (AS5). A Promoted transition clears
// pending_promotion. A local fence of a stateful key does not release it
// (the previous holder stays eligible); successors wait out the hold.
// CommittedState is this node's latest QC over every quorum set, never a
// minority or another node's commit; ObservedCommit is informational.
//
// Persistence (M1). Store stays a generic durable key-value store. The node
// writes, in the transaction that precedes a reply: each voter's accepted
// ballot, time, state and hash with Promised (key/<policy>/<slot>, plus the
// KNOWN flag); the latest commit whenever its holder or state changes; a
// store-created marker (storeinfo); and, on holders, the certified state and
// the pending transition (holder/<policy>/<slot>) before any propose carrying
// it leaves. A holder restarts from that record (CommittedState.Restored)
// and certifies again from the adopted value, never from the application's
// own configuration.
//
// Gateway obligations for stateful policies: publish them only when every
// member and candidate advertises availability_lease_v3; strict only; a new
// policy id per enable (M10); a bootstrap reservation naming the serving
// member; keep a voter change joint until a live holder reports
// HeldCommit(key).epoch >= the joint epoch (a stateful commit is a KNOWN QC
// over both sets); without a live holder it stays joint.
//
// # Invariants and residuals
//
// The simulator checks at every simulated event: I1, strict mode never runs
// two live containers for a key; I2, all relay gates together admit at most
// one holder; I3, a successor commits within 45 s of a holder's death when a
// voter majority is reachable; I4, available mode converges to one copy
// after a partition heals. For stateful policies (strict only, so I4 does not
// apply) it also checks I5, a candidate acquires only when the application
// found it eligible under exactly the adopted state of a KNOWN majority, and
// I6, every certified state descends from every state certified at a lower
// ballot unless an explicit forced acquisition replaced it; I3 there assumes
// an eligible successor and a KNOWN majority without the dead holder. When a
// majority of the voters lost their memory, or no member is eligible, only a
// forced acquisition (data loss accepted) makes progress. Residual (A2.5): a VM whose clocks froze may run
// its container after resuming until the first frame from a peer whose clock
// it knew before the freeze (a relay beacon, within a second of reaching any
// relay), or until its frozen budget ends when it reaches nobody; relays
// refuse its traffic throughout. A frozen relay may keep a stale gate until
// the first member frame after its resume (a daemon beacon, within a
// second). Freezes shorter than the skew budget (2 s) stay inside the timing
// margins.
package availabilitylease
