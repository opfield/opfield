package lifecycle

import (
	"log/slog"
	"os"
	"os/user"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func loadHostAccessTestConfig(t *testing.T, extra string) *BaseConfig {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := "gateway:\n  address: \"gateway.example.com:9443\"\n" + extra
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadBaseConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func nodeExecCommand(action string) *pb.OpfieldCommand {
	return &pb.OpfieldCommand{
		CommandId: "cmd-1",
		Payload:   &pb.OpfieldCommand_NodeExec{NodeExec: &pb.NodeExecCommand{Action: action}},
	}
}

func nodeFileCommand(action string) *pb.OpfieldCommand {
	return &pb.OpfieldCommand{
		CommandId: "cmd-2",
		Payload:   &pb.OpfieldCommand_NodeFile{NodeFile: &pb.NodeFileCommand{Action: action, Path: "/etc"}},
	}
}

func TestHostAccessDefaultsToEnabled(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "console:\n  user: \"ops\"\n")
	if !cfg.Console.IsEnabled() || !cfg.Files.IsEnabled() {
		t.Fatalf("console and files must default to enabled, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
	if caps := cfg.hostAccessCapabilities(); len(caps) != 0 {
		t.Fatalf("an enabled node must not advertise disabled features, got %v", caps)
	}
	for _, action := range []string{"create", "resize", "run"} {
		if refused := refuseDisabledNodeExec(cfg, nodeExecCommand(action)); refused != nil {
			t.Fatalf("enabled console refused %s: %v", action, refused.Error)
		}
	}
	if refused := refuseDisabledNodeFile(cfg, nodeFileCommand("list")); refused != nil {
		t.Fatalf("enabled files refused list: %v", refused.Error)
	}
}

func TestDisabledConsoleRefusesEveryNodeExecAction(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "console:\n  enabled: false\n")
	if cfg.Console.IsEnabled() {
		t.Fatal("console.enabled: false must disable the console")
	}
	if !cfg.Files.IsEnabled() {
		t.Fatal("disabling the console must leave file access enabled")
	}
	for _, action := range []string{"create", "resize", "run"} {
		refused := refuseDisabledNodeExec(cfg, nodeExecCommand(action))
		if refused == nil {
			t.Fatalf("disabled console accepted %s", action)
		}
		if refused.Success || refused.CommandId != "cmd-1" || !strings.Contains(refused.Error, "console is disabled in this node's daemon configuration") {
			t.Fatalf("unexpected refusal for %s: %+v", action, refused)
		}
	}
	if got := cfg.hostAccessCapabilities(); !reflect.DeepEqual(got, []string{NodeConsoleDisabledCapability}) {
		t.Fatalf("capabilities = %v", got)
	}
}

func TestDisabledFilesRefusesHostFileAccessButKeepsHostIdentity(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "files:\n  enabled: false\n")
	if cfg.Files.IsEnabled() || !cfg.Console.IsEnabled() {
		t.Fatalf("files.enabled: false must disable only files, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
	for _, action := range []string{"list", "read", "write", "create-file", "create-dir", "delete", "move", "upload-init", "upload-chunk", "upload-complete", "upload-abort"} {
		refused := refuseDisabledNodeFile(cfg, nodeFileCommand(action))
		if refused == nil {
			t.Fatalf("disabled files accepted %s", action)
		}
		if refused.Success || refused.CommandId != "cmd-2" || !strings.Contains(refused.Error, "file access is disabled in this node's daemon configuration") {
			t.Fatalf("unexpected refusal for %s: %+v", action, refused)
		}
	}
	if refused := refuseDisabledNodeFile(cfg, nodeFileCommand("ensure-host-identity")); refused != nil {
		t.Fatalf("ensure-host-identity must stay available: %v", refused.Error)
	}
	if got := cfg.hostAccessCapabilities(); !reflect.DeepEqual(got, []string{NodeFilesDisabledCapability}) {
		t.Fatalf("capabilities = %v", got)
	}
}

func TestBothHostAccessFeaturesDisabledAdvertiseBothMarkers(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "console:\n  enabled: false\nfiles:\n  enabled: false\n")
	want := []string{NodeConsoleDisabledCapability, NodeFilesDisabledCapability}
	if got := cfg.hostAccessCapabilities(); !reflect.DeepEqual(got, want) {
		t.Fatalf("capabilities = %v, want %v", got, want)
	}
}

func TestConsoleUserOfAnotherUserNeedsARootDaemon(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "console:\n  user: \"root\"\n")
	var logs strings.Builder
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	refusal := checkConsoleUser(cfg, logger)
	if os.Geteuid() == 0 {
		if refusal != "" || refuseUnavailableConsoleUser(refusal, nodeExecCommand("create")) != nil {
			t.Fatalf("a root daemon must run console sessions as another user, got %q", refusal)
		}
		return
	}
	if !strings.Contains(refusal, `console.user "root" needs a root daemon`) || !strings.Contains(refusal, "Remove console.user") {
		t.Fatalf("refusal = %q", refusal)
	}
	if !strings.Contains(logs.String(), "level=ERROR") || !strings.Contains(logs.String(), "console sessions are refused") {
		t.Fatalf("startup log = %q, want one error naming the refusal", logs.String())
	}
	for _, action := range []string{"create", "resize", "run"} {
		refused := refuseUnavailableConsoleUser(refusal, nodeExecCommand(action))
		if refused == nil || refused.Success || refused.CommandId != "cmd-1" || refused.Error != refusal {
			t.Fatalf("console user refusal for %s = %+v", action, refused)
		}
	}
}

func TestConsoleUserOfTheDaemonUserOrDisabledConsoleIsNotRefused(t *testing.T) {
	account, err := user.Current()
	if err != nil {
		t.Skip("current user is not resolvable")
	}
	for _, extra := range []string{
		"console:\n  user: \"" + account.Username + "\"\n",
		"console:\n  enabled: false\n  user: \"root\"\n",
		"",
	} {
		cfg := loadHostAccessTestConfig(t, extra)
		if refusal := consoleUserRefusal(cfg); refusal != "" {
			t.Fatalf("config %q refused: %q", extra, refusal)
		}
	}
}
