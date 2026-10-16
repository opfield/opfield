package docker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every system log the user's config enables without its own TTL or engine
// gets a 7-day TTL; everything else in the fragment stays byte for byte.
func TestClickHouseFragmentGetsSystemLogTTLs(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"no system log", `<clickhouse><max_concurrent_queries>50</max_concurrent_queries></clickhouse>`,
			`<clickhouse><max_concurrent_queries>50</max_concurrent_queries></clickhouse>`},
		{"enabled without ttl", "<clickhouse>\n  <query_log>\n    <database>system</database>\n    <table>query_log</table>\n  </query_log>\n</clickhouse>",
			"<clickhouse>\n  <query_log>\n    <database>system</database>\n    <table>query_log</table>\n  <ttl>event_date + INTERVAL 7 DAY DELETE</ttl></query_log>\n</clickhouse>"},
		{"self-closing", `<clickhouse><text_log/></clickhouse>`,
			`<clickhouse><text_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></text_log></clickhouse>`},
		{"own ttl", `<clickhouse><query_log><ttl>event_date + INTERVAL 30 DAY</ttl></query_log></clickhouse>`,
			`<clickhouse><query_log><ttl>event_date + INTERVAL 30 DAY</ttl></query_log></clickhouse>`},
		{"own engine", `<clickhouse><part_log><engine>ENGINE = MergeTree ORDER BY event_time</engine></part_log></clickhouse>`,
			`<clickhouse><part_log><engine>ENGINE = MergeTree ORDER BY event_time</engine></part_log></clickhouse>`},
		{"removed again", `<clickhouse><metric_log remove="remove"/></clickhouse>`, `<clickhouse><metric_log remove="remove"/></clickhouse>`},
		{"span log", `<clickhouse><opentelemetry_span_log><table>spans</table></opentelemetry_span_log></clickhouse>`,
			`<clickhouse><opentelemetry_span_log><table>spans</table><ttl>finish_date + INTERVAL 7 DAY DELETE</ttl></opentelemetry_span_log></clickhouse>`},
		{"nested name is not a log", `<clickhouse><profiles_x><query_log>1</query_log></profiles_x></clickhouse>`,
			`<clickhouse><profiles_x><query_log>1</query_log></profiles_x></clickhouse>`},
		{"two logs", `<clickhouse><query_log></query_log><!-- c --><trace_log><flush_interval_milliseconds>7500</flush_interval_milliseconds></trace_log></clickhouse>`,
			`<clickhouse><query_log><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></query_log><!-- c --><trace_log><flush_interval_milliseconds>7500</flush_interval_milliseconds><ttl>event_date + INTERVAL 7 DAY DELETE</ttl></trace_log></clickhouse>`},
		{"broken", `<clickhouse><query_log>`, `<clickhouse><query_log>`},
	} {
		got := clickHouseFragmentWithSystemLogTTL(tc.in)
		if got != tc.want {
			t.Errorf("%s:\n got %s\nwant %s", tc.name, got, tc.want)
			continue
		}
		if err := validateClickHouseFragment(got); tc.name != "broken" && err != nil {
			t.Errorf("%s: result does not validate: %v", tc.name, err)
		}
		if again := clickHouseFragmentWithSystemLogTTL(got); again != got {
			t.Errorf("%s: not idempotent: %s", tc.name, again)
		}
	}
}

// Every log the runtime profile removes is one the TTL covers.
func TestClickHouseRemovedSystemLogsMatchTheRuntimeProfile(t *testing.T) {
	for _, name := range clickHouseRemovedSystemLogs {
		if !strings.Contains(clickHouseRuntimeConfig, "<"+name+` remove="remove"/>`) {
			t.Errorf("%s is not removed by the runtime profile", name)
		}
	}
	if got, want := strings.Count(clickHouseRuntimeConfig, `remove="remove"`), len(clickHouseRemovedSystemLogs); got != want {
		t.Errorf("runtime profile removes %d logs, the TTL list has %d", got, want)
	}
}

// An existing install heals at daemon start: its user config file gets the
// TTLs once; a missing file or one that needs nothing is not written.
func TestHealClickHouseManagedConfig(t *testing.T) {
	dir := t.TempDir()
	if healed, err := healClickHouseManagedConfig(dir); healed || err != nil {
		t.Fatalf("missing file: %v %v", healed, err)
	}
	path := filepath.Join(dir, "gateway-managed.xml")
	if err := os.WriteFile(path, []byte(`<clickhouse><query_log/></clickhouse>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if healed, err := healClickHouseManagedConfig(dir); !healed || err != nil {
		t.Fatalf("first heal: %v %v", healed, err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "<ttl>event_date + INTERVAL 7 DAY DELETE</ttl>") {
		t.Fatalf("healed file %s", raw)
	}
	if healed, err := healClickHouseManagedConfig(dir); healed || err != nil {
		t.Fatalf("second heal: %v %v", healed, err)
	}
}
