package pgha

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

func TestLSN(t *testing.T) {
	lsn, err := ParseLSN("16/B374D848")
	if err != nil || lsn != LSN(0x16B374D848) || lsn.String() != "16/B374D848" {
		t.Fatalf("parse = %v %v %s", lsn, err, lsn)
	}
	if zero, err := ParseLSN(""); err != nil || zero != 0 {
		t.Fatalf("empty = %v %v", zero, err)
	}
	for _, bad := range []string{"16", "x/1", "1/zz"} {
		if _, err := ParseLSN(bad); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
	if name := WALSegmentName(3, MustLSN("1/2A000028")); name != "00000003000000010000002A" {
		t.Fatalf("segment = %s", name)
	}
	tl, start, ok := ParseWALSegmentName("00000003000000010000002A")
	if !ok || tl != 3 || start != MustLSN("1/2A000000") {
		t.Fatalf("parse segment = %d %s %v", tl, start, ok)
	}
}

func TestValueEncoding(t *testing.T) {
	value := Value{Timeline: 3, ParentTimeline: 2, SwitchLSN: MustLSN("0/4000000"), Durability: DurabilitySynchronous,
		SyncSet: []string{memberC, memberB, memberB}, EligibilityFloor: 5}
	data, err := value.Encode()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeValue(data)
	if err != nil || strings.Join(decoded.SyncSet, ",") != memberB+","+memberC || decoded.Version != ValueVersion {
		t.Fatalf("decoded %+v %v", decoded, err)
	}
	if !decoded.Equal(value) {
		t.Fatalf("encoding not canonical")
	}
	// Five UUID members, a final and a forced record fit the 1 KiB limit.
	big := Value{Timeline: 99, Durability: DurabilitySynchronous,
		SyncSet: []string{"0b7f7f3e-0000-4000-8000-000000000001", "0b7f7f3e-0000-4000-8000-000000000002", "0b7f7f3e-0000-4000-8000-000000000003", "0b7f7f3e-0000-4000-8000-000000000004", "0b7f7f3e-0000-4000-8000-000000000005"},
		Final:   &Final{Successor: "0b7f7f3e-0000-4000-8000-000000000001", LSN: 1 << 40, Operation: "0b7f7f3e-0000-4000-8000-00000000000a"},
		Forced:  &Forced{Operation: "0b7f7f3e-0000-4000-8000-00000000000b", Timeline: 98, ForkLSN: 1 << 39, AtUnixMs: 1790000000000, Promoted: true}}
	if data, err := big.Encode(); err != nil || len(data) > 720 {
		t.Fatalf("large value = %d bytes %v", len(data), err)
	}
	for _, bad := range [][]byte{nil, []byte("{}"), []byte(`{"v":1,"d":"eventual"}`)} {
		if _, err := DecodeValue(bad); err == nil {
			t.Fatalf("%q decoded", bad)
		}
	}
}

func TestSyncNamesRendering(t *testing.T) {
	if syncNames(nil) != "" {
		t.Fatal("empty set must clear the names")
	}
	if got := syncNames([]string{memberC, memberB}); got != `FIRST 2 ("`+memberB+`", "`+memberC+`")` {
		t.Fatalf("names = %s", got)
	}
}

func TestConfigValidation(t *testing.T) {
	if _, err := ParseConfig(testConfig(testEngineConfig())); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*memberha.Config, *EngineConfig){
		"shared replication role (M6)": func(_ *memberha.Config, e *EngineConfig) { e.ReplicationRoles[memberB] = roleA },
		"rewind role shared":           func(_ *memberha.Config, e *EngineConfig) { e.RewindRole = roleA },
		"missing replication role":     func(_ *memberha.Config, e *EngineConfig) { delete(e.ReplicationRoles, memberC) },
		"unknown durability":           func(c *memberha.Config, _ *EngineConfig) { c.Durability = "eventual" },
		"bad role name":                func(_ *memberha.Config, e *EngineConfig) { e.ReplicationRoles[memberB] = "Robert'); DROP" },
		"degrade bound too short":      func(c *memberha.Config, _ *EngineConfig) { c.SyncDegradeAfterSeconds = 1 },
		"no database":                  func(c *memberha.Config, _ *EngineConfig) { c.OwnerID = "" },
		"bad identity role": func(_ *memberha.Config, e *EngineConfig) {
			e.Identities = &Identities{Replication: map[string]string{"X;": "p"}}
		},
	}
	for name, mutate := range cases {
		engine := testEngineConfig()
		roles := map[string]string{}
		for k, v := range engine.ReplicationRoles {
			roles[k] = v
		}
		engine.ReplicationRoles = roles
		config := testConfig(engine)
		mutate(&config, &engine)
		config.EngineConfig, _ = json.Marshal(engine)
		if _, err := ParseConfig(config); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	empty := testConfig(testEngineConfig())
	empty.EngineConfig = nil
	if _, err := ParseConfig(empty); err == nil {
		t.Error("a member without its engine configuration was accepted")
	}
}

func TestSyncCandidateOrderFollowsPriority(t *testing.T) {
	config := pgTestConfig()
	others := config.Others()
	if others[0].MemberID != memberB || others[1].MemberID != memberC {
		t.Fatalf("order = %+v", others)
	}
	if SlotName("0B7F7F3E-0000-4000-8000-000000000001") != "gw_ha_0b7f7f3e000040008000000000000001" {
		t.Fatalf("slot name = %s", SlotName("0B7F7F3E-0000-4000-8000-000000000001"))
	}
}

func TestStorePersistsAndRejectsCorruptFiles(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(setID, State{DataEpoch: 3, HeldDataEpoch: 2}); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load(setID)
	if err != nil || loaded.DataEpoch != 3 || loaded.HeldDataEpoch != 2 {
		t.Fatalf("loaded %+v %v", loaded, err)
	}
	if err := os.WriteFile(filepath.Join(dir, setID+".json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(setID); err == nil {
		t.Fatalf("a corrupt state file was read as absent")
	}
	if _, err := New(testConfig(testEngineConfig()), newFakePG(&harness{}), store, &fakeClock{}, nil); err == nil {
		t.Fatal("an engine with a corrupt state file must not open (it would forget a rewind mark)")
	}
}
