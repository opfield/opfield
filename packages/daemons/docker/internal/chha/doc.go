// Package chha is the ClickHouse engine of database availability sets on a
// storage-profile docker daemon (memberha.Engine).
//
// Topology (decision 8/14 of the plan, prototype findings in P0-T02):
//
//   - Every member runs clickhouse-server with an embedded Keeper. With two
//     data members the third Keeper voter is a witness Keeper on a relay (or
//     a staged standby witness that the holder may activate while Opfield is
//     down). Sets have 2 or 3 data members.
//   - User databases use the Replicated database engine under /gw/db/<name>
//     (the Keeper ensemble is the set's own, so the path needs no set id and
//     stays valid when availability is turned off and on again), with
//     database_replicated_allow_only_replicated_engine and
//     default_table_engine=ReplicatedMergeTree in the default profile. Access
//     entities live in Keeper (user_directories.replicated, /gw/access).
//   - Each member's ZooKeeper client uses only its own Keeper (in_order,
//     5 s sessions): a member whose Keeper is in the minority has no session
//     and its tables are read-only, which is what a minority member must be.
//
// Addressing. Keeper keeps one endpoint string per server in its replicated
// cluster configuration, so every node must reach every server under the
// same host:port. All endpoints of a set use one loopback address
// 127.a.b.1 (derived from the set id by Opfield) and a port per server: on a
// relay the supervisor binds forwarders there (WitnessPeer), and inside a
// member's container the daemon binds forwarders in the container's network
// namespace that carry each connection over the member mesh
// ("member-<id>-ch-keeper", "witness-<id>-ch-keeper",
// "member-<id>-ch-interserver"). A member's own Keeper and interserver port
// listen on all addresses of its container, so its own endpoint reaches it.
//
// Roles. ClickHouse replicas accept writes on every replica; the primary role
// is the settings profile legacycompat.ClickHouseClientProfile (every client user has it):
// read-only on copies, writable on the holder. The profile file is rewritten
// only while the container is stopped (standby at rest) or by Promote, and
// set member containers are never restarted by Docker itself.
//
// Durability (decision 5): synchronous sets run insert_quorum=2 with
// insert_quorum_timeout = syncDegradeAfterSeconds; when the copies stop being
// active for that long the holder certifies "degraded" in the lease first and
// then falls back to quorum 1; it restores quorum 2 in the engine before it
// certifies the set healthy again.
package chha
