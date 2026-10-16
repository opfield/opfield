package docker

import (
	"context"
	"log/slog"
	"testing"
)

const (
	absentSetID      = "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7"
	absentDatabaseID = "b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8"
)

// F-8: a member Opfield configured before its create command made the
// database here reports itself absent, not a failure (no rejoin of a copy
// that does not exist yet).
func TestMemberHostsReportAMemberNotCreatedYetAsAbsent(t *testing.T) {
	m := &managedDatabaseManager{root: t.TempDir(), logger: slog.New(slog.DiscardHandler)}
	pg := &pgMember{m: m, id: absentDatabaseID, setID: absentSetID}
	state, err := pg.Container(context.Background())
	if err != nil || !state.Absent || state.Exists {
		t.Fatalf("Postgres member without a record = %+v, %v; want absent, no error", state, err)
	}
	kv := &kvSetHost{m: m, id: absentDatabaseID}
	info, err := kv.Container(context.Background())
	if err != nil || !info.Absent || info.Exists {
		t.Fatalf("Valkey member without a record = %+v, %v; want absent, no error", info, err)
	}
}
