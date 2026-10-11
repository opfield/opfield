// Package swha is the SeaweedFS engine of availability set members (managed
// storage pairs): it implements memberha.Engine on top of a Host the docker
// daemon provides (containers, the set's member mesh, files).
//
// Layout per member (decision 13 of the plan): a volume server container and
// a filer container (filer + S3, embedded leveldb2 store, built-in peer
// metadata sync) on every member, and a master container that runs only on
// the primary (the lease holder, or a manual pair's assigned primary). The
// master is stateless: its sequencer is a snowflake one with id member index
// + 1, so two masters never hand out the same file id, and it rebuilds its
// topology from volume heartbeats.
//
// The "engine container" of the member runtime is the master: the watchdog
// deadline record is written for it, a fence kills it, and standby at rest
// means it is not running (it never restarts on its own). The member counts
// as running while its volume server and filer run.
//
// Promotion (Promote) follows the P0-T01 findings:
//  1. Remote volume servers are kept off the new master (the member refuses
//     peer connections to its master ports) until step 4.
//  2. The master starts and the member's own volume server restarts, so it
//     leaves a dead master at once instead of after ~25 s; the filer stays
//     stopped until the gate passed (it is what makes the master grow
//     volumes), then starts on the new master.
//  3. Volume-id gate: when the topology's highest volume id is below the
//     certified maxVolumeId (or the last one this member saw), throw-away
//     volumes are grown to raise the master's id counter and deleted again
//     while no other volume server can register, so no volume id is ever
//     handed out twice.
//  4. The master port opens to the other members; the member serves.
//
// While it holds, a background worker writes a metadata heartbeat into the
// filer every second (the copies' filers receive it through peer sync: their
// metadata progress), probes the other members' volume servers through the
// mesh, switches new bucket writes to one copy (fs.configure 000) after a
// volume server was unreachable for 10 s and restarts the master so it drops
// the silent server, and repairs the replication (volume.configure.replication
// 001, volume.fix.replication, fs.configure back) once every member is back.
//
// Certified state (lease v3 value): {maxVolumeId, metaProgressNs,
// degradedSince}. A copy is eligible when its volume server registered with
// the primary's master recently and its filer's metadata progress is within
// one second of the certified progress.
package swha
