package swha

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// containerConfigDir is where the member's staged configuration (security.toml
// with the filer signing key) is mounted in every member container.
const containerConfigDir = "/run/gateway-storage/config"

// shell runs a weed shell script in the master container against the local
// master and the member's own filer. weed shell reports a failed command on
// its output and still exits 0, so the output is checked too.
func (e *Engine) shell(ctx context.Context, script string) (string, error) {
	cfg, self := e.self()
	// -logtostderr: glog would otherwise write a log file into the
	// container's writable layer on every run.
	command := []string{"/usr/bin/weed", "-logtostderr=true", "-config_dir=" + containerConfigDir, "shell",
		"-master=127.0.0.1:" + strconv.Itoa(MasterHTTPPort), "-filer=" + FilerURL(cfg.MemberID, self.MemberIndex)}
	out, err := e.host.Exec(ctx, RoleMaster, command, script)
	text := string(out)
	if err != nil {
		return text, err
	}
	if line := shellError(text); line != "" {
		return text, errors.New(line)
	}
	return text, nil
}

// shellError is the first line of weed shell output that reports a failure.
func shellError(output string) string {
	for _, line := range strings.Split(output, "\n") {
		lower := strings.ToLower(strings.TrimSpace(line))
		if strings.HasPrefix(lower, "error") || strings.Contains(lower, ": error") || strings.HasPrefix(lower, "unknown command") {
			return strings.TrimSpace(line)
		}
	}
	return ""
}

func lockedScript(lines ...string) string {
	return "lock\n" + strings.Join(lines, "\n") + "\nunlock\n"
}

// singleCopyScript makes new bucket objects go to one copy (a lost volume
// server must not stop writes).
func singleCopyScript() string {
	return lockedScript("fs.configure -locationPrefix=/buckets/ -replication=000 -apply")
}

// repairScript gives every volume created with one copy its second copy back
// and new bucket objects their replication.
func repairScript(singleCopy []uint32) string {
	lines := make([]string, 0, len(singleCopy)+2)
	for _, id := range singleCopy {
		lines = append(lines, fmt.Sprintf("volume.configure.replication -volumeId=%d -replication=001", id))
	}
	lines = append(lines, "volume.fix.replication -apply", "fs.configure -locationPrefix=/buckets/ -delete -apply")
	return lockedScript(lines...)
}

// deleteVolumesScript removes the throw-away volumes of the volume-id gate.
func deleteVolumesScript(node string, ids []uint32) string {
	lines := make([]string, 0, len(ids))
	for _, id := range ids {
		lines = append(lines, fmt.Sprintf("volume.delete -node=%s -volumeId=%d", node, id))
	}
	return lockedScript(lines...)
}
