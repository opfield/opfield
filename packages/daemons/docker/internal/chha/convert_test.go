package chha

import "testing"

func TestMovableCreate(t *testing.T) {
	cases := []struct {
		name, query, engine, want string
		ok                        bool
	}{
		{"converted MergeTree",
			"CREATE TABLE app.events (`id` UInt64, `v` String) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') ORDER BY id SETTINGS index_granularity = 8192",
			"ReplicatedMergeTree",
			"CREATE TABLE IF NOT EXISTS `app_gwnew`.events (`id` UInt64, `v` String) ENGINE = ReplicatedMergeTree ORDER BY id SETTINGS index_granularity = 8192", true},
		{"replacing with version",
			"CREATE TABLE app.t2 UUID '0b1a3c55-1d2e-4f00-9a00-000000000001' (`id` UInt64, `ver` UInt32) ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', ver) ORDER BY id",
			"ReplicatedReplacingMergeTree",
			"CREATE TABLE IF NOT EXISTS `app_gwnew`.t2 (`id` UInt64, `ver` UInt32) ENGINE = ReplicatedReplacingMergeTree(ver) ORDER BY id", true},
		{"view", "CREATE VIEW app.v1 (`c` UInt64) AS SELECT count() AS c FROM app.events", "View",
			"CREATE VIEW IF NOT EXISTS `app_gwnew`.v1 (`c` UInt64) AS SELECT count() AS c FROM app.events", true},
		{"tiny log stays", "CREATE TABLE app.t3 (`id` UInt64) ENGINE = TinyLog", "TinyLog", "", false},
		{"unconverted MergeTree stays", "CREATE TABLE app.t4 (`id` UInt64) ENGINE = MergeTree ORDER BY id", "MergeTree", "", false},
		{"materialized view stays", "CREATE MATERIALIZED VIEW app.mv TO app.events AS SELECT 1 AS id, 'x' AS v", "MaterializedView", "", false},
	}
	for _, c := range cases {
		got, ok := movableCreate(c.query, c.engine, "app_gwnew")
		if ok != c.ok || got != c.want {
			t.Errorf("%s:\n got %v %q\nwant %v %q", c.name, ok, got, c.ok, c.want)
		}
	}
	if attachAllSupported("24.8.14.39") || !attachAllSupported("25.3.8.23") || !attachAllSupported("26.7.1.1315") || attachAllSupported("x") {
		t.Fatal("ATTACH PARTITION ALL is 25.3+")
	}
	if got := createDatabaseSQL("app_gwnew", "app"); got != "CREATE DATABASE IF NOT EXISTS `app_gwnew` ENGINE = Replicated('/gw/db/app', 's1', '{replica}')" {
		t.Fatalf("create database %q", got)
	}
}
