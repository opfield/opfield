package docker

import (
	"encoding/json"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/chha"
	"github.com/opfield/opfield/docker-daemon/internal/config"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Every engine opens through the member runtime without deadlocking: engine
// constructors call back into the runtime (a Valkey host reads its
// configuration while the member is being added, which once hung the daemon),
// and the runtime's readers (Config, Owns, Reports) never wait for a member
// being added. Run with -race in the daemon suite.
func TestEveryMemberEngineOpensThroughTheRuntimeWithoutDeadlock(t *testing.T) {
	stateDir := t.TempDir()
	cfg := &config.Config{}
	cfg.StateDir = stateDir
	plugin := &DockerPlugin{cfg: cfg, logger: slog.New(slog.DiscardHandler)}
	plugin.databaseManager = newTestDatabaseManager(t, nil)
	plugin.storageManager = &managedStorageManager{root: t.TempDir(), logger: slog.New(slog.DiscardHandler)}
	plugin.wirePGSetHooks()
	t.Cleanup(func() { setMeshes.Delete(plugin) })
	store, err := memberha.NewStore(filepath.Join(stateDir, "availability-members"))
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan string, 8)
	members, err := memberha.NewManager(memberha.Deps{
		Lease: pgNoLease{}, Watchdog: pgNoWatchdog{}, Endpoints: pgNoEndpoints{}, Clock: bootWallClock{},
		Logger: slog.New(slog.DiscardHandler),
		Engine: func(config memberha.Config) (memberha.Engine, error) {
			factory, ok := setMemberEngine(config.Engine)
			if !ok {
				t.Errorf("no engine %s", config.Engine)
			}
			// What a constructor's host may do while the member is added.
			plugin.setMembers.Config(config.SetID)
			plugin.setMembers.Owns(config.LeasePolicyID)
			engine, err := factory(plugin, config)
			opened <- config.Engine
			return engine, err
		},
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	plugin.setMembers = members

	kvConfig, _ := json.Marshal(map[string]any{"replicationPassword": "replication-password-0123456789"})
	engines := []struct {
		engine, set, owner string
		engineConfig       []byte
	}{
		{"postgres", "a1111111-1111-4111-8111-111111111111", "d1111111-1111-4111-8111-111111111111", nil},
		{kvSetEngine, "a2222222-2222-4222-8222-222222222222", "d2222222-2222-4222-8222-222222222222", kvConfig},
		{chha.Engine, "a3333333-3333-4333-8333-333333333333", "d3333333-3333-4333-8333-333333333333", nil},
		{managedStorageEngineSeaweedFS, "a4444444-4444-4444-8444-444444444444", "e4444444-4444-4444-8444-444444444444", nil},
	}
	for _, entry := range engines {
		memberID := "b" + entry.set[1:]
		config := memberha.Config{SetID: entry.set, MemberID: memberID, NodeID: "node-a", Engine: entry.engine,
			OwnerKind: "managed_database", OwnerID: entry.owner, Mode: memberha.ModeAutomatic,
			LeasePolicyID: "c" + entry.set[1:], ConfigRevision: 1, EngineConfig: entry.engineConfig,
			Members: []memberha.Peer{{MemberID: memberID, NodeID: "node-a"}}}
		if entry.engine == managedStorageEngineSeaweedFS {
			config.OwnerKind = "managed_storage"
		}
		done := make(chan error, 1)
		go func() { done <- members.Configure(config) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("adding a %s member deadlocked", entry.engine)
		}
		select {
		case <-opened:
		default:
			t.Fatalf("the %s engine factory did not run", entry.engine)
		}
		// The runtime's readers stay responsive.
		reports := make(chan []memberha.Report, 1)
		go func() {
			members.Owns(config.LeasePolicyID)
			members.Config(config.SetID)
			reports <- members.Reports()
		}()
		select {
		case <-reports:
		case <-time.After(10 * time.Second):
			t.Fatalf("the runtime blocked after adding a %s member", entry.engine)
		}
	}
}
