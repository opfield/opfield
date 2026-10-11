// Package pgha is the Postgres engine of database availability sets: a
// memberha.Engine (plus the optional extensions) on a storage-profile docker
// daemon. The generic member runtime (internal/memberha) owns the lease
// rules shared by every engine (standby at rest, deadline records, fence and
// release order, health release, manual pairs, events); this package owns
// what is Postgres:
//
//   - Standby at rest: standby.signal and the daemon's settings in
//     postgresql.auto.conf (primary_conninfo through the member mesh alias
//     primary-pg-repl, application_name = member id, the member's own
//     replication role and slot), fsynced, before every start; standby.signal
//     again right after every promotion.
//   - Promotion: synchronous_standby_names set to what the certified and
//     pending states require before pg_promote (M4); the new timeline is
//     certified before clients are admitted (M3); a holder whose Postgres
//     came back in recovery promotes again and certifies its new timeline.
//   - Sync manager (HolderWork + NextValue): names ⊇ certified ∪ pending
//     SyncSet; an addition waits for the member's walsender to load the
//     names, a CHECKPOINT barrier and the member's flush before it is
//     certified; a reduction is certified before the names relax (AS5);
//     stalls are judged by the oldest SyncRep waiter and flush progress
//     (M5); cancelled or terminated waits raise the certified eligibility
//     floor (AS4); asynchronous durability certifies the progress floor every
//     maxLag/4 of flushed WAL, at most once a second (AS7).
//   - Eligibility: sync member at or above the floor; async within maxLag/2
//     of the certified progress floor (M2); the previous holder unless it
//     released or its data was replaced (AS6); timeline history on the
//     certified branch (M3).
//     Asynchronous loss bound: the WAL a failover discards is at most
//     maxLag/2 + max(maxLag/4, WAL of one second) + the WAL written during
//     one lease round.
//   - Rejoin: a clean shutdown (a killed primary first runs as a standby),
//     the diverged WAL copied aside when the disk allows, pg_rewind; a
//     rebuild with pg_basebackup when the rewind is impossible or failed
//     part-way (H3: such a directory is never started) and to seed a new
//     member.
//   - Planned switchover (AS11): the successor first becomes the certified
//     sync member (synchronous durability), then clients end, a checkpoint,
//     the final LSN, and the release only once the successor replayed it.
//   - Forced promotion (AS10): the certified value records the forced flag,
//     timeline and fork LSN.
package pgha
