package exec

import (
	"context"
	"errors"
	"os"
	osexec "os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func withProcessIdentity(t *testing.T, euid int, canSetUser bool) {
	t.Helper()
	previousEUID, previousCanSetUser := processEUID, processCanSetUser
	processEUID = func() int { return euid }
	processCanSetUser = func() bool { return canSetUser }
	t.Cleanup(func() { processEUID, processCanSetUser = previousEUID, previousCanSetUser })
}

func currentUserName(t *testing.T) string {
	t.Helper()
	account, err := user.Current()
	if err != nil {
		t.Skipf("current user is not resolvable: %v", err)
	}
	return account.Username
}

func TestWorkingDirectoryFallsBackToRootWithoutAHome(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for input, want := range map[string]string{
		home:                          home,
		filepath.Join(home, "absent"): "/",
		file:                          "/",
		"":                            "/",
	} {
		if got := workingDirectory(input); got != want {
			t.Fatalf("workingDirectory(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestCheckRunAsUserRefusesAnotherUserWithoutRootOrCapabilities(t *testing.T) {
	withProcessIdentity(t, 54321, false)
	for _, username := range []string{"root", "opfield-test-no-such-user"} {
		err := CheckRunAsUser(username)
		if !errors.Is(err, ErrCannotSwitchUser) {
			t.Fatalf("CheckRunAsUser(%q) = %v, want ErrCannotSwitchUser", username, err)
		}
		if !strings.Contains(err.Error(), "the daemon runs as uid 54321 without root") {
			t.Fatalf("CheckRunAsUser(%q) does not name the daemon user: %v", username, err)
		}
	}
	if err := CheckRunAsUser(""); err != nil {
		t.Fatalf("an empty console user must run as the daemon: %v", err)
	}
}

func TestCheckRunAsUserAcceptsAnotherUserWithRootOrCapabilities(t *testing.T) {
	withProcessIdentity(t, 54321, true)
	if err := CheckRunAsUser("root"); err != nil {
		t.Fatalf("CAP_SETUID and CAP_SETGID must allow another user: %v", err)
	}
	withProcessIdentity(t, 0, false)
	if err := CheckRunAsUser("root"); err != nil {
		t.Fatalf("root must allow another user: %v", err)
	}
	if err := CheckRunAsUser("opfield-test-no-such-user"); err == nil || errors.Is(err, ErrCannotSwitchUser) {
		t.Fatalf("an unknown user on a root daemon must fail the lookup, got %v", err)
	}
}

func TestApplyRunAsUserForTheDaemonUserSwitchesNothing(t *testing.T) {
	username := currentUserName(t)
	withProcessIdentity(t, os.Geteuid(), false)
	cmd := osexec.Command("true")
	if err := applyRunAsUser(cmd, username); err != nil {
		t.Fatal(err)
	}
	if cmd.SysProcAttr != nil {
		t.Fatalf("running as the daemon's own user must not set credentials: %+v", cmd.SysProcAttr)
	}
	if cmd.Dir == "" {
		t.Fatal("the command must start in the user's home or /")
	}
}

// The daemon's own user as console.user works without root: no setgroups.
func TestRunCommandAsTheDaemonUser(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux only")
	}
	result, err := RunCommand(context.Background(), []string{"id", "-u"}, currentUserName(t), 4096)
	if err != nil {
		t.Fatalf("run as the daemon's own user: %v (%+v)", err, result)
	}
	if got := strings.TrimSpace(result.Stdout); got != strconv.Itoa(os.Geteuid()) {
		t.Fatalf("id -u = %q, want %d", got, os.Geteuid())
	}
}

// Without root, another console user is refused with the reason instead of an
// exec error; with root, a user whose home does not exist starts in /.
func TestRunCommandAsAnotherUser(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux only")
	}
	if os.Geteuid() != 0 {
		_, err := RunCommand(context.Background(), []string{"id", "-u"}, "root", 4096)
		if !errors.Is(err, ErrCannotSwitchUser) {
			t.Fatalf("non-root run as root = %v, want ErrCannotSwitchUser", err)
		}
		return
	}
	account, err := user.Lookup("nobody")
	if err != nil {
		t.Skip("no nobody user")
	}
	if info, statErr := os.Stat(account.HomeDir); statErr == nil && info.IsDir() {
		t.Skipf("nobody has a home directory %s", account.HomeDir)
	}
	result, err := RunCommand(context.Background(), []string{"sh", "-c", "id -u; pwd"}, "nobody", 4096)
	if err != nil {
		t.Fatalf("run as nobody: %v (%+v)", err, result)
	}
	if got := strings.Fields(result.Stdout); len(got) != 2 || got[0] != account.Uid || got[1] != "/" {
		t.Fatalf("id -u; pwd as nobody = %q, want %s and /", result.Stdout, account.Uid)
	}
}
