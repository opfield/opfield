package docker

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/pgha"
)

func writeSizedFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func TestPrunePGDivergedCopiesKeepsTheTwoNewestWithinTheBudget(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"20260101T000000Z", "20260201T000000Z", "20260301T000000Z", "20260401T000000Z"} {
		writeSizedFile(t, filepath.Join(dir, name, "000000010000000000000001"), 1000)
	}
	// Budget 5% of 1 MB = 50 kB: the count bounds.
	removed := prunePGDivergedCopies(dir, 1_000_000)
	if len(removed) != 2 {
		t.Fatalf("removed %v", removed)
	}
	if got := dirNames(t, dir); !reflect.DeepEqual(got, []string{"20260301T000000Z", "20260401T000000Z"}) {
		t.Fatalf("kept %v, want the two newest", got)
	}
	// Budget 5% of 40 kB = 2 kB: only the newest fits next to nothing else.
	writeSizedFile(t, filepath.Join(dir, "20260401T000000Z", "000000010000000000000002"), 500)
	prunePGDivergedCopies(dir, 40_000)
	if got := dirNames(t, dir); !reflect.DeepEqual(got, []string{"20260401T000000Z"}) {
		t.Fatalf("kept %v, want the newest within the budget", got)
	}
	// A copy larger than the budget alone goes too.
	prunePGDivergedCopies(dir, 20_000)
	if got := dirNames(t, dir); len(got) != 0 {
		t.Fatalf("kept %v, want none over the budget", got)
	}
	if removed := prunePGDivergedCopies(filepath.Join(dir, "missing"), 1<<30); removed != nil {
		t.Fatalf("a missing directory removes nothing: %v", removed)
	}
}

func TestCopyPGDivergedWALRefusesACopyOverTheBudget(t *testing.T) {
	pgdata := filepath.Join(t.TempDir(), "pgdata")
	dest := filepath.Join(t.TempDir(), "diverged")
	writeSizedFile(t, filepath.Join(pgdata, "pg_wal", "000000010000000000000003"), 4096)
	writeSizedFile(t, filepath.Join(pgdata, "pg_wal", "000000010000000000000004"), 4096)
	if kept := copyPGDivergedWAL(pgdata, dest, 0, 100_000, 0); kept != "" {
		t.Fatalf("8 kB over a 5 kB budget must not be copied, kept %q", kept)
	}
	kept := copyPGDivergedWAL(pgdata, dest, pgha.LSN(3<<24), 1<<30, 0)
	if kept == "" {
		t.Fatal("a copy within the budget is kept")
	}
	if got := dirNames(t, kept); !reflect.DeepEqual(got, []string{"000000010000000000000003", "000000010000000000000004"}) {
		t.Fatalf("copied %v", got)
	}
	if kept := copyPGDivergedWAL(pgdata, dest, 0, 1<<30, 1<<62); kept != "" {
		t.Fatal("a copy that leaves less than the minimum free is not made")
	}
}

func TestPGDiskSettingsBoundSmallVolumes(t *testing.T) {
	small := pgDiskSettings(100 << 20)
	if small["max_wal_size"] != "64MB" || small["min_wal_size"] != "32MB" || small["temp_file_limit"] != "25MB" {
		t.Fatalf("100 MB volume: %v", small)
	}
	medium := pgDiskSettings(4 << 30)
	if medium["max_wal_size"] != "409MB" || medium["min_wal_size"] != "80MB" || medium["temp_file_limit"] != "1024MB" {
		t.Fatalf("4 GB volume: %v", medium)
	}
	large := pgDiskSettings(100 << 30)
	if large["max_wal_size"] != "1024MB" || large["min_wal_size"] != "80MB" {
		t.Fatalf("100 GB volume keeps the engine's 1 GB: %v", large)
	}
	if len(pgDiskSettings(0)) != 0 {
		t.Fatal("an unknown volume size sets nothing")
	}
}

func TestPGSlotWALKeepFollowsFreeSpace(t *testing.T) {
	for _, tc := range []struct {
		configured, storage, free, want int64
	}{
		{0, 8 << 30, -1, 2 << 30},          // a quarter of the volume
		{0, 8 << 30, 10 << 30, 2 << 30},    // free space does not raise it
		{0, 8 << 30, 1 << 30, 512 << 20},   // half the free space
		{0, 8 << 30, 10 << 20, 64 << 20},   // floor for a streaming copy
		{0, 100 << 20, 10 << 20, 32 << 20}, // never above the volume bound
		{100, 8 << 30, -1, 100 << 20},      // configured
	} {
		if got := pgSlotWALKeepBytes(tc.configured, tc.storage, tc.free); got != tc.want {
			t.Fatalf("keep(%d, %d, %d) = %d, want %d", tc.configured, tc.storage, tc.free, got, tc.want)
		}
	}
}

func writePGData(t *testing.T, autoConf string) string {
	t.Helper()
	managedDatabaseChown = func(string, int, int) error { return nil }
	t.Cleanup(func() { managedDatabaseChown = os.Chown })
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "PG_VERSION"), []byte("17\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if autoConf != "" {
		if err := os.WriteFile(filepath.Join(dir, "postgresql.auto.conf"), []byte(autoConf), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func readAutoConf(t *testing.T, dir string) map[string]string {
	t.Helper()
	values, err := pgReadAutoConf(filepath.Join(dir, "postgresql.auto.conf"))
	if err != nil {
		t.Fatal(err)
	}
	return values
}

func TestPGApplyManagedSettingsNeverOverridesTheUser(t *testing.T) {
	dir := writePGData(t, "work_mem = '64MB'\ntemp_file_limit = '10GB'\n")
	changed, err := pgApplyManagedSettings(dir, map[string]string{"max_wal_size": "128MB", "temp_file_limit": "256MB"})
	if err != nil || !changed {
		t.Fatalf("first write: %v %v", changed, err)
	}
	values := readAutoConf(t, dir)
	if values["max_wal_size"] != "128MB" || values[pgManagedMarkerPrefix+"max_wal_size"] != "128MB" {
		t.Fatalf("Opfield's value with its marker: %v", values)
	}
	if values["temp_file_limit"] != "10GB" || values["work_mem"] != "64MB" {
		t.Fatalf("the user's values stay: %v", values)
	}
	if _, marked := values[pgManagedMarkerPrefix+"temp_file_limit"]; marked {
		t.Fatal("a user value gets no marker")
	}
	// A grown volume: Opfield's own value follows.
	if changed, err := pgApplyManagedSettings(dir, map[string]string{"max_wal_size": "512MB"}); err != nil || !changed {
		t.Fatalf("follow-up write: %v %v", changed, err)
	}
	if values := readAutoConf(t, dir); values["max_wal_size"] != "512MB" {
		t.Fatalf("after a grow: %v", values)
	}
	// Unchanged: no write.
	if changed, err := pgApplyManagedSettings(dir, map[string]string{"max_wal_size": "512MB"}); err != nil || changed {
		t.Fatalf("an unchanged value is not written again: %v %v", changed, err)
	}
	// The user's ALTER SYSTEM after Opfield's value: kept from now on.
	conf := strings.Replace(string(mustRead(t, filepath.Join(dir, "postgresql.auto.conf"))), "max_wal_size = '512MB'", "max_wal_size = '2GB'", 1)
	if err := os.WriteFile(filepath.Join(dir, "postgresql.auto.conf"), []byte(conf), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := pgApplyManagedSettings(dir, map[string]string{"max_wal_size": "64MB"}); err != nil {
		t.Fatal(err)
	}
	values = readAutoConf(t, dir)
	if values["max_wal_size"] != "2GB" {
		t.Fatalf("the user's ALTER SYSTEM is kept: %v", values)
	}
	if _, marked := values[pgManagedMarkerPrefix+"max_wal_size"]; marked {
		t.Fatal("the stale marker of a user value is dropped")
	}
	// ALTER SYSTEM RESET: the setting is Opfield's again.
	conf = strings.Replace(string(mustRead(t, filepath.Join(dir, "postgresql.auto.conf"))), "max_wal_size = '2GB'\n", "", 1)
	if err := os.WriteFile(filepath.Join(dir, "postgresql.auto.conf"), []byte(conf), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := pgApplyManagedSettings(dir, map[string]string{"max_wal_size": "64MB"}); err != nil {
		t.Fatal(err)
	}
	if values := readAutoConf(t, dir); values["max_wal_size"] != "64MB" {
		t.Fatalf("after a reset: %v", values)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestPGApplyManagedSettingsLeavesAnUninitializedDirectory(t *testing.T) {
	dir := t.TempDir()
	if changed, err := pgApplyManagedSettings(dir, pgDiskSettings(1<<30)); err != nil || changed {
		t.Fatalf("an empty directory must stay empty for initdb: %v %v", changed, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("wrote %v", entries)
	}
}

func TestPGStandaloneDiskSettingsBoundSlots(t *testing.T) {
	settings := pgStandaloneDiskSettings(8<<30, 1<<30)
	if settings["max_slot_wal_keep_size"] != "512MB" || settings["max_wal_size"] != "819MB" {
		t.Fatalf("standalone settings = %v", settings)
	}
}

func TestPGMemberAutoConfWritesDiskSettingsAndKeepsUserValues(t *testing.T) {
	previous := pgFreeBytesAt
	pgFreeBytesAt = func(string) int64 { return 1 << 30 }
	t.Cleanup(func() { pgFreeBytesAt = previous })
	dir := writePGData(t, "temp_file_limit = '5GB'\n")
	config := pgha.StandbyConfig{MemberID: "m", ReplicationRole: "r", SlotName: "gw_ha_m"}
	if err := writePGMemberAutoConf(dir, 8<<30, config); err != nil {
		t.Fatal(err)
	}
	values := readAutoConf(t, dir)
	if values["max_slot_wal_keep_size"] != "512MB" || values[pgManagedMarkerPrefix+"max_slot_wal_keep_size"] != "512MB" {
		t.Fatalf("slot keep bounded by half the free space, with its marker: %v", values)
	}
	if values["max_wal_size"] != "819MB" || values["min_wal_size"] != "80MB" || values["temp_file_limit"] != "5GB" {
		t.Fatalf("member disk settings: %v", values)
	}
}

func TestParsePGSlotObservation(t *testing.T) {
	output := "\n(gw_ha_b,)\n" + pgSlotIdleTag + "gw_ha_b\n" + pgSlotIdleTag + "gw_ha_c\n" + pgSlotKeepTag + "2048\n"
	idle, keep, primary := parsePGSlotObservation(output)
	if !reflect.DeepEqual(idle, []string{"gw_ha_b", "gw_ha_c"}) || keep != 2048 || !primary {
		t.Fatalf("primary observation = %v %d %v", idle, keep, primary)
	}
	idle, _, primary = parsePGSlotObservation(pgSlotKeepTag + "standby\n")
	if len(idle) != 0 || primary {
		t.Fatal("a standby observes nothing to reset")
	}
}

func TestPGSlotKeepUpdatesOnlyBeyondTheTolerance(t *testing.T) {
	for _, tc := range []struct {
		current, want int64
		update        bool
	}{
		{-1, 1024, true}, {1024, 1024, false}, {1024, 1000, false}, {1024, 900, true}, {1024, 1200, true},
	} {
		if got := pgSlotKeepNeedsUpdate(tc.current, tc.want); got != tc.update {
			t.Fatalf("update(%d, %d) = %v", tc.current, tc.want, got)
		}
	}
}

func TestPGIdleSlotsAreResetAfterADay(t *testing.T) {
	member := &pgMember{}
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	member.trackIdleSlots(start, []string{"gw_ha_b", "gw_ha_c"}, nil)
	member.trackIdleSlots(start.Add(time.Hour), []string{"gw_ha_b"}, nil)
	if due := member.idleSlotsDue(start.Add(pgIdleSlotReset - time.Minute)); len(due) != 0 {
		t.Fatalf("no slot is reset within a day: %v", due)
	}
	// gw_ha_c streamed again: its clock is gone; gw_ha_b is due.
	member.trackIdleSlots(start.Add(2*time.Hour), []string{"gw_ha_b", "gw_ha_c"}, nil)
	due := member.idleSlotsDue(start.Add(pgIdleSlotReset))
	if !reflect.DeepEqual(due, []string{"gw_ha_b"}) {
		t.Fatalf("due = %v", due)
	}
	// After the reset its clock starts again.
	member.trackIdleSlots(start.Add(pgIdleSlotReset), []string{"gw_ha_b", "gw_ha_c"}, due)
	if due := member.idleSlotsDue(start.Add(pgIdleSlotReset + time.Hour)); len(due) != 0 {
		t.Fatalf("a reset slot waits another day: %v", due)
	}
}

func TestPGCronSettingsFromTheCommandLine(t *testing.T) {
	preloaded, database := pgCronSettings([]string{"postgres", "-c", "max_connections=100", "-c", "shared_preload_libraries=pg_stat_statements,pg_cron", "-c", "cron.database_name=shop"})
	if !preloaded || database != "shop" {
		t.Fatalf("pg_cron = %v %q", preloaded, database)
	}
	if preloaded, database := pgCronSettings([]string{"postgres", "-c", "shared_preload_libraries=pg_stat_statements"}); preloaded || database != "postgres" {
		t.Fatalf("without pg_cron = %v %q", preloaded, database)
	}
	if !strings.Contains(pgCronPurgeSQL, "interval '7 days'") || !strings.Contains(pgCronPurgeSQL, "NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname") {
		t.Fatal("the purge job keeps 7 days and leaves an existing job alone")
	}
}
