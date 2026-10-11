// Package memberha is the member runtime of database and storage
// availability sets on a storage-profile docker daemon, shared by every engine
// (Postgres, Valkey, SeaweedFS, ClickHouse). An engine implements Engine; the
// framework owns the safety rules that do not depend on the engine.
//
// One Manager runs every member of the node (one member per set). In
// automatic mode it is the lease runtime's controller for the sets' lease
// policies: the runtime drives the protocol node (availabilitylease v3) and
// calls Step every loop iteration; Step never blocks on Docker or the engine,
// which run in background operations, one at a time per member. In manual
// mode (a replicated pair without a witness) there is no lease: the primary is
// the member Gateway names in the primary assignment.
//
// Safety rules implemented here:
//
//   - Standby at rest: every start is preceded by Engine.PrepareStandby, so a
//     member always boots read-only (a copy); only the holder path, or a
//     manual pair's assigned primary, promotes.
//   - Holder: the watchdog deadline record is written before any promotion
//     or start of the holder's container; Promote runs only while the lease
//     says MayStart; the promotion is certified in the lease (the engine's
//     PromotedValue) before the member serves (relay endpoints SERVING and
//     the member proxy admitting). A holder whose engine came back read-only
//     promotes again while it holds.
//   - Transitions: at most one proposed transition per member; the runtime
//     acts on the certified state only (CommittedState), never on what it
//     proposed.
//   - Fence: serving closed and tunnels ended, kill, cgroup confirmed empty,
//     standby at rest written, deadline record deleted, then the fence is
//     complete and the member starts as a copy. A stop that cannot be
//     confirmed abandons the key: the watchdog kills at the deadline.
//   - Release (health, planned switchover): the same order, then the release
//     with the designated successor.
//   - Health release (decision 17): the engine down or not answering on two
//     samples at least 10 s apart releases to an eligible copy; without one
//     the holder restarts locally up to 3 times in 10 minutes, then alerts.
//     A full disk is never a release reason.
//   - Startup: a running container with a live deadline record of the set's
//     policy recovers the key with the recorded deadline; a running primary
//     without one is unowned and fenced.
//   - Manual mode (decision 6): the assigned primary demotes itself (fence
//     and restart as a copy) when it reached neither the Gateway session nor
//     its peer for 30 s, and resumes when either comes back without a newer
//     assignment; a member that sees a newer generation (from Gateway or the
//     peer) than the one it served under steps down and rejoins.
//   - Events (failover, fence, rejoin, ...) are kept on disk with their
//     original time until Gateway acknowledges them (decision 18).
package memberha
