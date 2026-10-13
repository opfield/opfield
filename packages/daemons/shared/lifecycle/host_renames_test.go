package lifecycle

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/hostrename"
)

func TestMigrateControlConfigKeyRenamesTheSectionOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	original := "# operator note\ngateway:\n  address: \"gw.example:9443\" # primary\n  cert_sha256: \"sha256:aa\"\ntls:\n  ca_cert: /etc/x/ca.pem\nstate_dir: /var/lib/docker-daemon\n"
	if err := os.WriteFile(path, []byte(original), 0o640); err != nil {
		t.Fatal(err)
	}
	changed, err := MigrateControlConfigKey(path)
	if err != nil || !changed {
		t.Fatalf("MigrateControlConfigKey = %v, %v", changed, err)
	}
	data, _ := os.ReadFile(path)
	text := string(data)
	for _, want := range []string{"# operator note", "opfield:", `address: "gw.example:9443" # primary`, "ca_cert: /etc/x/ca.pem", "state_dir: /var/lib/docker-daemon"} {
		if !strings.Contains(text, want) {
			t.Fatalf("migrated config lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "gateway:") {
		t.Fatalf("gateway: section left:\n%s", text)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}
	if changed, err := MigrateControlConfigKey(path); err != nil || changed {
		t.Fatalf("second run = %v, %v; want no change", changed, err)
	}
	cfg, err := LoadBaseConfig(path)
	if err != nil || cfg.Control.Address != "gw.example:9443" || cfg.UsesLegacyControlSection() {
		t.Fatalf("migrated config loads %+v, %v", cfg, err)
	}
}

func TestControlSectionPrefersOpfield(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("gateway:\n  address: old:9443\nopfield:\n  address: new:9443\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadBaseConfig(path)
	if err != nil || cfg.Control.Address != "new:9443" {
		t.Fatalf("loaded %+v, %v", cfg, err)
	}
	if changed, err := MigrateControlConfigKey(path); err != nil || !changed {
		t.Fatalf("leftover gateway: section not dropped: %v %v", changed, err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "gateway:") || !strings.Contains(string(data), "new:9443") {
		t.Fatalf("config:\n%s", data)
	}
	// The daemon's own edits go to the section in effect.
	if err := editControlConfigFile(path, map[string]string{"next_address": "next:9443"}); err != nil {
		t.Fatal(err)
	}
	if section := readYAMLMap(t, path)["opfield"].(map[string]any); section["next_address"] != "next:9443" {
		t.Fatalf("opfield section = %v", section)
	}
	legacyOnly := filepath.Join(t.TempDir(), "legacy.yaml")
	if err := os.WriteFile(legacyOnly, []byte("gateway:\n  address: old:9443\n  token: t\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err = LoadBaseConfig(legacyOnly)
	if err != nil || cfg.Control.Address != "old:9443" || !cfg.UsesLegacyControlSection() {
		t.Fatalf("legacy config loads %+v, %v", cfg, err)
	}
	if err := ClearTokenFromFile(legacyOnly); err != nil {
		t.Fatal(err)
	}
	if section := readYAMLMap(t, legacyOnly)["gateway"].(map[string]any); section["token"] != nil {
		t.Fatalf("token kept: %v", section)
	}
}

func TestLauncherEnvironmentUnderBothNames(t *testing.T) {
	t.Setenv(LauncherReadyFDEnv, "")
	os.Unsetenv(LauncherReadyFDEnv)
	t.Setenv(legacyLauncherReadyFDEnv, "7")
	if got := launcherEnv(LauncherReadyFDEnv, legacyLauncherReadyFDEnv); got != "7" {
		t.Fatalf("a pre-Opfield launcher's variable is read: %q", got)
	}
	t.Setenv(LauncherReadyFDEnv, "9")
	if got := launcherEnv(LauncherReadyFDEnv, legacyLauncherReadyFDEnv); got != "9" {
		t.Fatalf("the Opfield variable wins: %q", got)
	}
	pairs := launcherEnvPairs(LauncherManagedEnv, legacyLauncherManagedEnv, "1")
	if len(pairs) != 2 || pairs[0] != "OPFIELD_DAEMON_LAUNCHER_MANAGED=1" || pairs[1] != "GATEWAY_DAEMON_LAUNCHER_MANAGED=1" {
		t.Fatalf("a launcher sets both names for a daemon of either release: %v", pairs)
	}
}

func TestLauncherFallbackDirectoryKeepsAnExistingLegacyOne(t *testing.T) {
	root := t.TempDir()
	dir, legacy := filepath.Join(root, "opfield-daemon"), filepath.Join(root, "gateway-daemon")
	if got := fallbackLauncherDir(dir, legacy); got != dir {
		t.Fatalf("new installs use %s, got %s", dir, got)
	}
	if err := os.Mkdir(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := fallbackLauncherDir(dir, legacy); got != legacy {
		t.Fatalf("the running launcher's directory must stay in use, got %s", got)
	}
}

// The renames wait for the launcher to commit the update: while it can still
// roll back to the previous daemon nothing is renamed.
func TestStartConfirmedWaitsForTheLauncherCommit(t *testing.T) {
	ResetStartConfirmedForTest(false)
	t.Cleanup(func() { ResetStartConfirmedForTest(false) })
	saved := startConfirmedPoll
	startConfirmedPoll = 10 * time.Millisecond
	t.Cleanup(func() { startConfirmedPoll = saved })
	stateDir := t.TempDir()
	if err := writeLauncherUpdateState(stateDir, &launcherUpdateState{SchemaVersion: launcherStateSchemaVersion, TargetVersion: "v2.12.1", Phase: "local_ready"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv(LauncherManagedEnv, "1")
	t.Setenv(LauncherStateDirEnv, stateDir)
	var ran atomic.Int32
	OnStartConfirmed(func() { ran.Add(1) })
	scheduleStartConfirmed("v2.12.1", nil)
	time.Sleep(100 * time.Millisecond)
	if ran.Load() != 0 || StartConfirmed() {
		t.Fatal("renamed while the launcher could still roll back")
	}
	if err := removeLauncherUpdateState(stateDir); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for ran.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if ran.Load() != 1 || !StartConfirmed() {
		t.Fatalf("hook ran %d times after the commit", ran.Load())
	}
	// Registered later: runs at once.
	done := make(chan struct{})
	OnStartConfirmed(func() { close(done) })
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a hook registered after the confirmation did not run")
	}
}

func TestStartConfirmedWithoutLauncher(t *testing.T) {
	ResetStartConfirmedForTest(false)
	t.Cleanup(func() { ResetStartConfirmedForTest(false) })
	os.Unsetenv(LauncherManagedEnv)
	os.Unsetenv(legacyLauncherManagedEnv)
	done := make(chan struct{})
	OnStartConfirmed(func() { close(done) })
	scheduleStartConfirmed("v2.12.1", nil)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a daemon no launcher manages is confirmed at once")
	}
}

func TestHostIdentityPathResolution(t *testing.T) {
	for _, path := range []string{"", "/var/lib/gateway/host-identity", "/var/lib/opfield/host-identity"} {
		if !isDefaultHostIdentityPath(path) {
			t.Fatalf("%q is the shared default", path)
		}
	}
	if HostIdentityPathFor("/var/lib/nginx-daemon/host-identity") != "/var/lib/nginx-daemon/host-identity" {
		t.Fatal("an own identity path is kept")
	}
	if got := HostIdentityPathFor(""); got != hostrename.StateRoot.Join(hostrename.HostIdentityName) {
		t.Fatalf("default resolves to %s", got)
	}
}

// The identity survives the move of its directory: read before and after,
// it is the same, and nothing creates a second one.
func TestHostIdentitySurvivesTheMove(t *testing.T) {
	root := t.TempDir()
	pair := hostrename.Pair{Old: filepath.Join(root, "gateway"), New: filepath.Join(root, "opfield")}
	before, err := loadOrCreateHostIdentity(filepath.Join(pair.Old, hostrename.HostIdentityName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hostrename.Move(pair); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(pair.Old, hostrename.HostIdentityName), filepath.Join(pair.New, hostrename.HostIdentityName)} {
		after, err := loadOrCreateHostIdentity(path)
		if err != nil || after != before {
			t.Fatalf("identity at %s = %q, %v; want %q", path, after, err, before)
		}
	}
}
