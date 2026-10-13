package config

import "testing"

func TestBuiltinLocalServiceTargetServesTheRegistryUnderBothIDs(t *testing.T) {
	for _, id := range []string{RegistryServiceID, LegacyRegistryServiceID} {
		target, err := BuiltinLocalServiceTarget(id)
		if err != nil || target.ID != id || target.Target != RegistryServiceTarget {
			t.Fatalf("%s: target=%#v err=%v", id, target, err)
		}
	}
	if _, err := BuiltinLocalServiceTarget("registry"); err == nil {
		t.Fatal("unknown local service accepted")
	}
}

func TestLoadDefaultsToOpfieldDirectories(t *testing.T) {
	t.Setenv("RELAY_IDENTITY_DIR", "")
	t.Setenv("RELAY_STATE_DIR", "")
	t.Setenv("RELAY_MODE", "")
	t.Setenv("RELAY_POOL_ID", "")
	t.Setenv("RELAY_INSTANCE_ID", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.IdentityDir != "/var/lib/opfield-relay/identity" || cfg.StateDir != "/var/lib/opfield-relay/state" {
		t.Fatalf("defaults = %s, %s", cfg.IdentityDir, cfg.StateDir)
	}
}
