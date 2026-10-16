package nginx

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeLog(t *testing.T, dir, name string, size int, age time.Duration, now time.Time) string {
	t.Helper()
	path := filepath.Join(dir, name)
	line := []byte("127.0.0.1 - - \"GET / HTTP/1.1\" 200 12\n")
	content := bytes.Repeat(line, size/len(line)+1)[:size]
	if err := os.WriteFile(path, content, 0o640); err != nil {
		t.Fatal(err)
	}
	stamp := now.Add(-age)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	return path
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func sizeOf(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func testPolicy() LogBudgetPolicy {
	return LogBudgetPolicy{
		MaxFileBytes:  1000,
		TailBytes:     200,
		BudgetBytes:   1 << 30,
		MaxAge:        30 * 24 * time.Hour,
		InactiveGrace: time.Hour,
	}
}

func TestLogBudgetCutsALiveLogOverItsCapAndKeepsWholeTailLines(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	const size = 38 * 130 // whole lines, as nginx writes them
	live := writeLog(t, dir, "proxy-a.access.log", size, time.Minute, now)
	refs := map[string]bool{"proxy-a.access.log": true}

	result, err := EnforceLogBudget(dir, refs, testPolicy(), now)
	if err != nil {
		t.Fatal(err)
	}
	if sizeOf(t, live) != 0 {
		t.Fatalf("live log not truncated: %d", sizeOf(t, live))
	}
	tail, err := os.ReadFile(live + ".1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) == 0 || len(tail) > 200 || !strings.HasPrefix(string(tail), "127.0.0.1") || !strings.HasSuffix(string(tail), "\n") {
		t.Fatalf("tail is not whole lines within the tail size: %q", tail)
	}
	if result.TruncatedFiles != 1 || result.FreedBytes != size-int64(len(tail)) {
		t.Fatalf("result = %+v", result)
	}
	if result.Files != 2 || result.Bytes != int64(len(tail)) {
		t.Fatalf("usage = %+v", result)
	}
}

func TestLogBudgetKeepsLiveLogsOfConfiguredRoutesHoweverQuiet(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	quiet := writeLog(t, dir, "proxy-a.error.log", 100, 400*24*time.Hour, now)
	refs := map[string]bool{"proxy-a.error.log": true}

	if _, err := EnforceLogBudget(dir, refs, testPolicy(), now); err != nil {
		t.Fatal(err)
	}
	if !exists(quiet) {
		t.Fatal("the live log of a configured route was deleted; nginx would write into the unlinked inode")
	}
}

func TestLogBudgetRemovesEveryLogOfARemovedRouteOnceNginxStoppedWritingIt(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	gone := []string{
		writeLog(t, dir, "proxy-gone.access.log", 100, 2*time.Hour, now),
		writeLog(t, dir, "proxy-gone.access.log.1", 100, 2*time.Hour, now),
		writeLog(t, dir, "proxy-gone.error.log-20261001", 100, 2*time.Hour, now),
		writeLog(t, dir, "proxy-gone.access.log.2.gz", 100, 3*24*time.Hour, now),
	}
	stillWritten := writeLog(t, dir, "proxy-justgone.access.log", 100, time.Minute, now)
	kept := writeLog(t, dir, "proxy-a.access.log.1", 100, 2*time.Hour, now)
	refs := map[string]bool{"proxy-a.access.log": true}

	result, err := EnforceLogBudget(dir, refs, testPolicy(), now)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range gone {
		if exists(path) {
			t.Fatalf("%s of a removed route was kept", filepath.Base(path))
		}
	}
	if !exists(stillWritten) {
		t.Fatal("a log nginx may still write was deleted")
	}
	if !exists(kept) {
		t.Fatal("a rotated log of a configured route was deleted")
	}
	if result.RemovedFiles != len(gone) {
		t.Fatalf("removed = %d", result.RemovedFiles)
	}
}

func TestLogBudgetRemovesNoRouteLogWhenTheConfigsAreUnknown(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	log := writeLog(t, dir, "proxy-a.access.log", 100, 2*time.Hour, now)
	if _, err := EnforceLogBudget(dir, nil, testPolicy(), now); err != nil {
		t.Fatal(err)
	}
	if !exists(log) {
		t.Fatal("a route log was deleted without knowing the configs")
	}
}

func TestLogBudgetDeletesRotatedLogsPastTheRetention(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	old := writeLog(t, dir, "access.log-20260801", 100, 40*24*time.Hour, now)
	recent := writeLog(t, dir, "access.log-20261010", 100, 5*24*time.Hour, now)
	live := writeLog(t, dir, "access.log", 100, 40*24*time.Hour, now)

	if _, err := EnforceLogBudget(dir, map[string]bool{}, testPolicy(), now); err != nil {
		t.Fatal(err)
	}
	if exists(old) || !exists(recent) || !exists(live) {
		t.Fatalf("old=%v recent=%v live=%v", exists(old), exists(recent), exists(live))
	}

	noLimit := testPolicy()
	noLimit.MaxAge = 0
	older := writeLog(t, dir, "error.log.3", 100, 400*24*time.Hour, now)
	if _, err := EnforceLogBudget(dir, map[string]bool{}, noLimit, now); err != nil {
		t.Fatal(err)
	}
	if !exists(older) {
		t.Fatal("a retention of 0 must not delete by age")
	}
}

func TestLogBudgetLeavesOtherLogsAlone(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	other := []string{
		writeLog(t, dir, "mysite.access.log", 5000, 400*24*time.Hour, now),
		writeLog(t, dir, "mysite.access.log.1", 5000, 400*24*time.Hour, now),
		writeLog(t, dir, "notes.txt", 5000, 400*24*time.Hour, now),
	}
	policy := testPolicy()
	policy.BudgetBytes = 10
	result, err := EnforceLogBudget(dir, map[string]bool{}, policy, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range other {
		if !exists(path) || sizeOf(t, path) != 5000 {
			t.Fatalf("%s was touched", filepath.Base(path))
		}
	}
	if result.Files != 0 {
		t.Fatalf("other logs counted: %+v", result)
	}
}

func TestLogBudgetFreesRotatedLogsOldestFirstThenTruncatesLiveLogs(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	refs := map[string]bool{"proxy-a.access.log": true, "proxy-b.access.log": true}
	oldest := writeLog(t, dir, "proxy-a.access.log.2", 400, 3*24*time.Hour, now)
	older := writeLog(t, dir, "proxy-a.access.log.1", 400, 2*24*time.Hour, now)
	newer := writeLog(t, dir, "proxy-b.access.log.1", 400, 24*time.Hour, now)
	liveA := writeLog(t, dir, "proxy-a.access.log", 900, time.Minute, now)
	liveB := writeLog(t, dir, "proxy-b.access.log", 300, time.Minute, now)
	policy := testPolicy()

	policy.BudgetBytes = 2000 // 2400 in total: the oldest rotated log goes
	if _, err := EnforceLogBudget(dir, refs, policy, now); err != nil {
		t.Fatal(err)
	}
	if exists(oldest) || !exists(older) || !exists(newer) {
		t.Fatalf("oldest=%v older=%v newer=%v", exists(oldest), exists(older), exists(newer))
	}

	policy.BudgetBytes = 500 // only live logs fit: the largest goes first
	result, err := EnforceLogBudget(dir, refs, policy, now)
	if err != nil {
		t.Fatal(err)
	}
	if exists(older) || exists(newer) {
		t.Fatal("rotated logs kept over the budget")
	}
	if sizeOf(t, liveA) != 0 || sizeOf(t, liveB) != 300 {
		t.Fatalf("liveA=%d liveB=%d", sizeOf(t, liveA), sizeOf(t, liveB))
	}
	if result.Bytes != 300 || result.Files != 2 {
		t.Fatalf("usage = %+v", result)
	}
}

func TestReferencedRouteLogsReadsEveryConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "proxy-host-a.conf"), []byte("access_log /var/log/nginx/proxy-a.access.log opfield_combined;\nerror_log /var/log/nginx/proxy-a.error.log warn;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "raw.conf"), []byte("access_log /var/log/nginx/proxy-b.access.log;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("proxy-c.access.log"), 0o644); err != nil {
		t.Fatal(err)
	}
	refs, ok := ReferencedRouteLogs(dir, filepath.Join(dir, "missing-nginx.conf"))
	if !ok {
		t.Fatal("configs not read")
	}
	for _, name := range []string{"proxy-a.access.log", "proxy-a.error.log", "proxy-b.access.log"} {
		if !refs[name] {
			t.Fatalf("%s not referenced: %v", name, refs)
		}
	}
	if refs["proxy-c.access.log"] {
		t.Fatal("a non-config file counted")
	}
	if _, ok := ReferencedRouteLogs(filepath.Join(dir, "missing"), ""); ok {
		t.Fatal("a missing config dir must be unknown, not empty")
	}
}

func TestDefaultLogBudgetPolicyFitsSmallAndLargeDisks(t *testing.T) {
	small := DefaultLogBudgetPolicy(2<<30, DefaultLogRetention)
	if small.BudgetBytes != (2<<30)/20 || small.MaxFileBytes != small.BudgetBytes/4 {
		t.Fatalf("2 GiB disk: %+v", small)
	}
	large := DefaultLogBudgetPolicy(1<<40, DefaultLogRetention)
	if large.BudgetBytes != 2<<30 || large.MaxFileBytes != 100<<20 || large.TailBytes != 10<<20 {
		t.Fatalf("1 TiB disk: %+v", large)
	}
	tiny := DefaultLogBudgetPolicy(100<<20, 0)
	if tiny.BudgetBytes != 64<<20 || tiny.MaxFileBytes != 16<<20 || tiny.MaxAge != 0 {
		t.Fatalf("100 MiB disk: %+v", tiny)
	}
}
