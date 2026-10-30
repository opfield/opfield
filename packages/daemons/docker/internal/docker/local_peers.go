package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/loopbackpeer"
)

// The local users the daemon's loopback listeners (the registry proxy on 127.0.0.1:5443, a backup run's relay route)
// serve: root, the daemon's own user and the users of the containers it starts. A Docker Engine with user namespaces
// (userns-remap, rootless Docker and the BuildKit it runs) connects as other host uids: those that container root,
// the daemon's user and the backup runner map to are served too.

// localPeerRemapRefresh is how long the remapped uids stand before the engine is asked again (a dockerd restarted
// with another userns-remap setting).
const localPeerRemapRefresh = time.Minute

// The host files the remapped uids come from (replaced in tests).
var (
	localPeerSubUIDFile     = "/etc/subuid"
	localPeerDaemonJSONFile = "/etc/docker/daemon.json"
	localPeerDockerPIDFile  = "/var/run/docker.pid"
	localPeerProcRoot       = "/proc"
)

type localPeerState struct {
	mu        sync.Mutex
	remapped  map[int]bool
	checkedAt time.Time
	// uncheckedLogged: the node's lookup failure is logged once per process.
	uncheckedLogged sync.Once
}

// localPeerUsers allows root, uids and their remapped host uids (localPeerRemappedUIDs).
func (p *DockerPlugin) localPeerUsers(uids ...int) func(uid int) bool {
	direct := loopbackpeer.Users(uids...)
	if p == nil {
		return direct
	}
	return func(uid int) bool {
		return direct(uid) || p.localPeerRemapped()[uid]
	}
}

// localPeerUnchecked hears that the node cannot look up loopback peers: logged once, and the node's health report
// carries the warning (CollectHealth).
func (p *DockerPlugin) localPeerUnchecked(err error) {
	if p == nil {
		return
	}
	p.localPeers.uncheckedLogged.Do(func() {
		if p.logger != nil {
			p.logger.Warn("this node cannot tell which local user opens a loopback connection; the registry proxy and backup relay routes serve every local user",
				"error", err.Error())
		}
		p.requestHealthRefresh()
	})
}

// loopbackPeerProblem is the node warning for a failed lookup self-test (HealthReport.loopback_peer_problem).
func loopbackPeerProblem(err error) string {
	return fmt.Sprintf("The Docker daemon cannot tell which local user opens a connection to its registry proxy (127.0.0.1:5443) or a backup run's relay port (%s), so both serve every local user of the host. Load the tcp_diag and inet_diag kernel modules on the host (modprobe tcp_diag), or on a container host allow the sock_diag lookup, to limit them to Docker and the daemon again.", err)
}

func (p *DockerPlugin) localPeerRemapped() map[int]bool {
	p.localPeers.mu.Lock()
	defer p.localPeers.mu.Unlock()
	if p.localPeers.remapped != nil && time.Since(p.localPeers.checkedAt) < localPeerRemapRefresh {
		return p.localPeers.remapped
	}
	securityOptions, ok := p.engineSecurityOptions()
	if !ok && p.localPeers.remapped != nil {
		// The engine does not answer: keep what it said last.
		return p.localPeers.remapped
	}
	socket := ""
	if p.cfg != nil {
		socket = p.cfg.Docker.Socket
	}
	remapped := map[int]bool{}
	for _, uid := range localPeerRemappedUIDs(securityOptions, socket, []int{0, os.Getuid(), backupRunnerUID}) {
		remapped[uid] = true
	}
	p.localPeers.remapped, p.localPeers.checkedAt = remapped, time.Now()
	return remapped
}

func (p *DockerPlugin) engineSecurityOptions() ([]string, bool) {
	if p.client == nil || p.client.cli == nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	info, err := p.client.cli.Info(ctx, mobyclient.InfoOptions{})
	if err != nil {
		return nil, false
	}
	return info.Info.SecurityOptions, true
}

// localPeerRemappedUIDs returns the host uids the container uids ids map to under the engine's user namespace:
// userns-remap maps container uid n to the n-th uid of the remap user's /etc/subuid ranges; rootless Docker maps
// container root to the user running the engine (the owner of its socket) and uid n to the (n-1)-th uid of that
// user's ranges. None without user namespaces.
func localPeerRemappedUIDs(securityOptions []string, socket string, ids []int) []int {
	var uids []int
	if hasSecurityOption(securityOptions, "userns") {
		if name := usernsRemapUser(); name != "" {
			ranges := subordinateUIDs(name)
			for _, id := range ids {
				if host, ok := mapThroughRanges(ranges, id); ok {
					uids = append(uids, host)
				}
			}
		}
	}
	if hasSecurityOption(securityOptions, "rootless") {
		if owner, ok := unixSocketOwner(socket); ok && owner != 0 {
			uids = append(uids, owner)
			ranges := subordinateUIDs(strconv.Itoa(owner))
			for _, id := range ids {
				if id == 0 {
					continue
				}
				if host, ok := mapThroughRanges(ranges, id-1); ok {
					uids = append(uids, host)
				}
			}
		}
	}
	return uids
}

// hasSecurityOption: docker info lists security options as "name=userns", "name=rootless,..." (or the bare name).
func hasSecurityOption(options []string, name string) bool {
	for _, option := range options {
		for _, field := range strings.Split(option, ",") {
			if field == "name="+name || field == name {
				return true
			}
		}
	}
	return false
}

// usernsRemapUser is the user of dockerd's userns-remap setting: daemon.json "userns-remap", else the
// --userns-remap flag of the running dockerd. "default" is the dockremap user dockerd creates; "user:group" names
// the user first.
func usernsRemapUser() string {
	value := ""
	if data, err := os.ReadFile(localPeerDaemonJSONFile); err == nil {
		var settings struct {
			UsernsRemap string `json:"userns-remap"`
		}
		if json.Unmarshal(data, &settings) == nil {
			value = settings.UsernsRemap
		}
	}
	if value == "" {
		value = dockerdUsernsRemapFlag()
	}
	if value == "" {
		// The engine runs with user namespaces but neither names the user: dockerd's own default.
		value = "default"
	}
	value, _, _ = strings.Cut(value, ":")
	if value == "default" {
		return "dockremap"
	}
	return value
}

func dockerdUsernsRemapFlag() string {
	pid, err := os.ReadFile(localPeerDockerPIDFile)
	if err != nil {
		return ""
	}
	cmdline, err := os.ReadFile(localPeerProcRoot + "/" + strings.TrimSpace(string(pid)) + "/cmdline")
	if err != nil {
		return ""
	}
	args := strings.Split(string(cmdline), "\x00")
	for index, arg := range args {
		if value, ok := strings.CutPrefix(arg, "--userns-remap="); ok {
			return value
		}
		if arg == "--userns-remap" && index+1 < len(args) {
			return args[index+1]
		}
	}
	return ""
}

type subordinateRange struct{ start, length int }

// subordinateUIDs reads the /etc/subuid ranges of a user, matched by name and by uid as dockerd and newuidmap do,
// ordered by start like dockerd's id maps.
func subordinateUIDs(nameOrUID string) []subordinateRange {
	keys := map[string]bool{nameOrUID: true}
	if _, err := strconv.Atoi(nameOrUID); err == nil {
		if account, err := user.LookupId(nameOrUID); err == nil {
			keys[account.Username] = true
		}
	} else if account, err := user.Lookup(nameOrUID); err == nil {
		keys[account.Uid] = true
	}
	file, err := os.Open(localPeerSubUIDFile)
	if err != nil {
		return nil
	}
	defer file.Close()
	var ranges []subordinateRange
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Split(line, ":")
		if len(fields) != 3 || !keys[fields[0]] {
			continue
		}
		start, startErr := strconv.Atoi(fields[1])
		length, lengthErr := strconv.Atoi(fields[2])
		if startErr != nil || lengthErr != nil || start < 0 || length <= 0 {
			continue
		}
		ranges = append(ranges, subordinateRange{start: start, length: length})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	return ranges
}

// mapThroughRanges is the host uid of the id-th uid of ranges laid end to end.
func mapThroughRanges(ranges []subordinateRange, id int) (int, bool) {
	offset := 0
	for _, r := range ranges {
		if id < offset+r.length {
			return r.start + id - offset, true
		}
		offset += r.length
	}
	return 0, false
}

func unixSocketOwner(socket string) (int, bool) {
	path, ok := strings.CutPrefix(socket, "unix://")
	if !ok || path == "" {
		return 0, false
	}
	return fileOwner(path)
}

func fileOwner(path string) (int, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(stat.Uid), true
}
