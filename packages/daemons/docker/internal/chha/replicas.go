package chha

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Replicas of removed members. A member that leaves the set keeps its
// replica in Keeper: in every Replicated database (/gw/db/<db>/replicas/
// s1|<member>) and in every ReplicatedMergeTree table of it. Nothing reads
// them, but the tables keep replication log entries for them (up to
// max_replicated_logs_to_keep) and the databases list them as replicas. The
// holder drops them (SYSTEM DROP REPLICA / DROP DATABASE REPLICA) from a
// remaining member.
//
// Only a replica that is provably a removed member's is dropped: its name is
// a member id, no member of the set (a member being removed included) has it,
// its database replica is not active, and it has been so for at least
// removedReplicaGrace (two sweeps). ClickHouse itself refuses to drop an
// active replica or the local one.
const (
	replicaSweepPeriod  = 10 * time.Minute
	removedReplicaGrace = 10 * time.Minute
)

// holderDropRemovedReplicas drops the replicas of removed members, at most
// once per replicaSweepPeriod.
func (e *engine) holderDropRemovedReplicas(ctx context.Context, snap *configSnapshot, now time.Duration) {
	e.mu.Lock()
	due := e.lastReplicaSweep == 0 || now-e.lastReplicaSweep >= replicaSweepPeriod
	if due {
		e.lastReplicaSweep = now
	}
	e.mu.Unlock()
	if !due {
		return
	}
	databases, err := e.setDatabases(ctx, snap.ec)
	if err != nil {
		return
	}
	members := map[string]bool{}
	for _, peer := range snap.config.Members {
		members[peer.MemberID] = true
	}
	seen := map[string]bool{}
	for _, database := range databases {
		path := DatabasePathPrefix + "/" + database + "/replicas"
		text, err := e.rt.Query(ctx, fmt.Sprintf("SELECT name FROM system.zookeeper WHERE path = %s FORMAT TabSeparatedRaw", quoteLiteral(path)))
		if err != nil {
			continue
		}
		for _, full := range strings.Fields(text) {
			shard, replica, ok := strings.Cut(full, "|")
			if !ok || shard != Shard || !uuidPattern.MatchString(replica) || members[replica] {
				continue
			}
			active, err := e.rt.Query(ctx, fmt.Sprintf("SELECT count() FROM system.zookeeper WHERE path = %s AND name = 'active' FORMAT TabSeparatedRaw",
				quoteLiteral(path+"/"+full)))
			if err != nil || strings.TrimSpace(active) != "0" {
				continue
			}
			key := database + "/" + replica
			seen[key] = true
			e.mu.Lock()
			since, known := e.removedReplicas[key]
			if !known {
				e.removedReplicas[key] = now
			}
			e.mu.Unlock()
			if !known || now-since < removedReplicaGrace {
				continue
			}
			// The tables first: a database replica dropped while a table
			// drop failed would not be found again.
			if _, err := e.rt.Query(ctx, fmt.Sprintf("SYSTEM DROP REPLICA %s FROM DATABASE %s", quoteLiteral(replica), quoteIdent(database))); err != nil {
				e.logger.Warn("could not drop a removed member's ClickHouse table replicas", "set_id", snap.config.SetID,
					"database", database, "replica", replica, "error", err)
				continue
			}
			if _, err := e.rt.Query(ctx, fmt.Sprintf("SYSTEM DROP DATABASE REPLICA %s FROM SHARD %s FROM DATABASE %s",
				quoteLiteral(replica), quoteLiteral(shard), quoteIdent(database))); err != nil {
				e.logger.Warn("could not drop a removed member's ClickHouse database replica", "set_id", snap.config.SetID,
					"database", database, "replica", replica, "error", err)
				continue
			}
			e.logger.Info("dropped a removed member's ClickHouse replica", "set_id", snap.config.SetID,
				"database", database, "replica", replica)
			delete(seen, key)
		}
	}
	e.mu.Lock()
	for key := range e.removedReplicas {
		if !seen[key] {
			delete(e.removedReplicas, key)
		}
	}
	e.mu.Unlock()
}
