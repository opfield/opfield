package docker

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"
)

func useLocalPeerFiles(t *testing.T, subuid, daemonJSON string) {
	t.Helper()
	dir := t.TempDir()
	previous := []string{localPeerSubUIDFile, localPeerDaemonJSONFile, localPeerDockerPIDFile, localPeerProcRoot}
	t.Cleanup(func() {
		localPeerSubUIDFile, localPeerDaemonJSONFile, localPeerDockerPIDFile, localPeerProcRoot =
			previous[0], previous[1], previous[2], previous[3]
	})
	localPeerSubUIDFile = filepath.Join(dir, "subuid")
	localPeerDaemonJSONFile = filepath.Join(dir, "daemon.json")
	localPeerDockerPIDFile = filepath.Join(dir, "docker.pid")
	localPeerProcRoot = filepath.Join(dir, "proc")
	if err := os.WriteFile(localPeerSubUIDFile, []byte(subuid), 0o644); err != nil {
		t.Fatal(err)
	}
	if daemonJSON != "" {
		if err := os.WriteFile(localPeerDaemonJSONFile, []byte(daemonJSON), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// Under userns-remap the backup runner (65532 in its container) connects as the remap user's 65532nd subordinate
// uid, and container root as the first: both are served, an unrelated uid is not.
func TestLocalPeersAllowTheUsernsRemappedUsers(t *testing.T) {
	useLocalPeerFiles(t, "# comment\nother:100000:65536\ndockremap:165536:65536\n", `{"userns-remap": "default"}`)
	got := localPeerRemappedUIDs([]string{"name=seccomp,profile=builtin", "name=userns"}, "unix:///var/run/docker.sock",
		[]int{0, 1000, backupRunnerUID})
	want := []int{165536, 166536, 165536 + backupRunnerUID}
	if !slices.Equal(got, want) {
		t.Fatalf("remapped uids = %v, want %v", got, want)
	}
	if uids := localPeerRemappedUIDs([]string{"name=seccomp,profile=builtin"}, "", []int{0, backupRunnerUID}); len(uids) != 0 {
		t.Fatalf("an engine without user namespaces remaps %v", uids)
	}
}

// Ranges are laid end to end in start order, as dockerd builds its id map; a user named as "user:group" or by the
// dockerd flag is found too.
func TestLocalPeersReadSplitRangesAndTheDockerdFlag(t *testing.T) {
	useLocalPeerFiles(t, "remapper:300000:10\nremapper:200000:65530\n", "")
	if err := os.MkdirAll(filepath.Join(localPeerProcRoot, "4242"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localPeerDockerPIDFile, []byte("4242\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmdline := "/usr/bin/dockerd\x00-H\x00fd://\x00--userns-remap\x00remapper:remapper\x00"
	if err := os.WriteFile(filepath.Join(localPeerProcRoot, "4242", "cmdline"), []byte(cmdline), 0o644); err != nil {
		t.Fatal(err)
	}
	got := localPeerRemappedUIDs([]string{"name=userns"}, "", []int{0, backupRunnerUID})
	want := []int{200000, 300000 + backupRunnerUID - 65530}
	if !slices.Equal(got, want) {
		t.Fatalf("remapped uids = %v, want %v", got, want)
	}
}

// Rootless Docker runs as the owner of its socket: container root is that user, uid n its (n-1)-th subordinate uid.
func TestLocalPeersAllowTheRootlessEngineUser(t *testing.T) {
	owner := os.Getuid()
	if owner == 0 {
		t.Skip("the socket owner of a rootless engine is not root")
	}
	useLocalPeerFiles(t, strconv.Itoa(owner)+":500000:65536\n", "")
	socket := filepath.Join(t.TempDir(), "docker.sock")
	if err := os.WriteFile(socket, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	got := localPeerRemappedUIDs([]string{"name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"},
		"unix://"+socket, []int{0, backupRunnerUID})
	want := []int{owner, 500000 + backupRunnerUID - 1}
	if !slices.Equal(got, want) {
		t.Fatalf("remapped uids = %v, want %v", got, want)
	}
}

func TestLocalPeerUsersServeRootTheNamedUsersAndTheRemappedOnes(t *testing.T) {
	plugin := &DockerPlugin{}
	plugin.localPeers.remapped = map[int]bool{165536: true}
	plugin.localPeers.checkedAt = time.Now()
	allowed := plugin.localPeerUsers(1000, backupRunnerUID)
	for uid, want := range map[int]bool{0: true, 1000: true, backupRunnerUID: true, 165536: true, 1001: false, 165537: false} {
		if allowed(uid) != want {
			t.Fatalf("allowed(%d) = %v, want %v", uid, !want, want)
		}
	}
	var none *DockerPlugin
	if !none.localPeerUsers(1000)(1000) || none.localPeerUsers(1000)(1001) {
		t.Fatal("a manager without a plugin must still serve exactly root and the named users")
	}
}
