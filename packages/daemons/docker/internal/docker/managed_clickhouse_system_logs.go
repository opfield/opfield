package docker

import (
	"bytes"
	"encoding/xml"
	"errors"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The runtime profile (clickHouseRuntimeConfig, the runtime XML file)
// removes ClickHouse's system log tables, but a user's managed XML file
// loads after it and may enable one again. ClickHouse keeps such a table
// forever unless it has a TTL, so the daemon writes the user's fragment with
// a TTL of clickHouseUserSystemLogDays for every system log it enables
// without a <ttl> of its own. A log with its own <engine> is left as written:
// ClickHouse refuses a <ttl> next to <engine> (the TTL belongs into the
// engine clause there).
const clickHouseUserSystemLogDays = "7"

// clickHouseRemovedSystemLogs are the system logs the runtime profile removes.
var clickHouseRemovedSystemLogs = []string{
	"query_log", "query_thread_log", "query_views_log", "query_metric_log", "trace_log",
	"instrumentation_trace_log", "part_log", "text_log", "error_log", "metric_log",
	"asynchronous_metric_log", "processors_profile_log", "session_log", "crash_log",
	"background_schedule_pool_log", "asynchronous_insert_log", "backup_log", "blob_storage_log",
	"s3queue_log", "opentelemetry_span_log", "zookeeper_log", "zookeeper_connection_log",
	"aggregated_zookeeper_log", "delta_lake_metadata_log", "iceberg_metadata_log",
}

// clickHouseSystemLogTTL is the TTL element for a system log: every one is
// partitioned by event_date, opentelemetry_span_log by finish_date.
func clickHouseSystemLogTTL(name string) string {
	column := "event_date"
	if name == "opentelemetry_span_log" {
		column = "finish_date"
	}
	return "<ttl>" + column + " + INTERVAL " + clickHouseUserSystemLogDays + " DAY DELETE</ttl>"
}

// clickHouseFragmentWithSystemLogTTL adds the TTL to every system log the
// fragment enables without its own <ttl> or <engine>; everything else stays
// byte for byte. A fragment that does not parse is returned unchanged (the
// validation refuses it before it is written).
func clickHouseFragmentWithSystemLogTTL(fragment string) string {
	logs := map[string]bool{}
	for _, name := range clickHouseRemovedSystemLogs {
		logs[name] = true
	}
	type edit struct {
		at, end int
		text    string
	}
	type open struct {
		name       string
		startEnd   int
		selfClosed bool
		hasOwn     bool
		skip       bool
	}
	raw := []byte(fragment)
	decoder := xml.NewDecoder(bytes.NewReader(raw))
	var edits []edit
	var current *open
	depth := 0
	for {
		before := int(decoder.InputOffset())
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fragment
		}
		switch t := token.(type) {
		case xml.StartElement:
			depth++
			switch {
			case depth == 2 && logs[t.Name.Local]:
				end := int(decoder.InputOffset())
				current = &open{name: t.Name.Local, startEnd: end, selfClosed: bytes.HasSuffix(raw[before:end], []byte("/>"))}
				for _, attr := range t.Attr {
					if attr.Name.Local == "remove" {
						current.skip = true
					}
				}
			case depth == 3 && current != nil && (t.Name.Local == "ttl" || t.Name.Local == "engine"):
				current.hasOwn = true
			}
		case xml.EndElement:
			if depth == 2 && current != nil {
				if !current.skip && !current.hasOwn {
					ttl := clickHouseSystemLogTTL(current.name)
					if current.selfClosed {
						edits = append(edits, edit{at: current.startEnd - 2, end: current.startEnd, text: ">" + ttl + "</" + current.name + ">"})
					} else {
						edits = append(edits, edit{at: before, end: before, text: ttl})
					}
				}
				current = nil
			}
			depth--
		}
	}
	if len(edits) == 0 {
		return fragment
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].at > edits[j].at })
	out := fragment
	for _, e := range edits {
		out = out[:e.at] + e.text + out[e.end:]
	}
	return out
}

// writeClickHouseManagedConfig writes the user's fragment as ClickHouse reads
// it (with the system log TTLs).
func writeClickHouseManagedConfig(path, fragment string) error {
	return writeClickHouseConfig(path, clickHouseFragmentWithSystemLogTTL(fragment))
}

// healClickHouseManagedConfig gives an existing managed XML file the
// system log TTLs (a daemon start, after the database's disk is mounted).
// ClickHouse applies them when it next creates the log table, at its next
// start. Nothing is written when the file is not there or needs nothing.
func healClickHouseManagedConfig(mountPath string) (bool, error) {
	if strings.TrimSpace(mountPath) == "" {
		return false, nil
	}
	path := filepath.Join(mountPath, legacycompat.ClickHouseManagedConfigFile)
	current, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	healed := clickHouseFragmentWithSystemLogTTL(string(current))
	if healed == string(current) {
		return false, nil
	}
	return true, writeClickHouseConfig(path, healed)
}
