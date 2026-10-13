package builder

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/opfield/opfield/daemon-shared/hostrename"
)

// Files of runtimes before the current layout, removed when the configuration
// is installed (they live in the naming's configuration and library
// directories).
var legacyRuntimeFiles = []string{"cni.json", "runsc.toml"}

const legacyRunscWrapperName = "runsc-oci"

var bundledRuntimeBinaries = []string{
	"containerd",
	"ctr",
	"containerd-shim-runc-v2",
	"buildkitd",
	"buildctl",
	"runc",
	"syft",
	"grype",
}

func bundledRuntimeBinaryPath(binDir, name string) string {
	return filepath.Join(binDir, name)
}

func requireExecutableFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return fmt.Errorf("%s is not a regular executable", path)
	}
	return nil
}

// builderExecutableResolver finds builder tools: the bundled ones in the
// naming's bundle directory, the others on PATH.
func builderExecutableResolver(naming Naming) func(string) (string, error) {
	return func(name string) (string, error) { return resolveBuilderExecutable(naming.BinDir(), name) }
}

func resolveBuilderExecutable(binDir, name string) (string, error) {
	for _, bundled := range bundledRuntimeBinaries {
		if name == bundled {
			path := bundledRuntimeBinaryPath(binDir, name)
			if err := requireExecutableFile(path); err != nil {
				return "", err
			}
			return path, nil
		}
	}
	return exec.LookPath(name)
}

type RuntimeSupervisor struct {
	Config   RuntimeConfig
	lookPath func(string) (string, error)
	run      func(string, ...string) error
	// egressScriptPath is where ReapplyEgressPolicy writes the policy
	// (the naming's script when empty).
	egressScriptPath string
}

func NewRuntimeSupervisor(config RuntimeConfig) *RuntimeSupervisor {
	return &RuntimeSupervisor{
		Config:   config,
		lookPath: exec.LookPath,
		run: func(name string, args ...string) error {
			command := exec.Command(name, args...)
			output, err := command.CombinedOutput()
			if err != nil {
				return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
			}
			return nil
		},
	}
}

func (s *RuntimeSupervisor) InstallConfiguration() error {
	if os.Geteuid() != 0 {
		return errors.New("builder runtime configuration requires root")
	}
	if err := s.Config.Validate(); err != nil {
		return err
	}
	naming := s.Config.Naming
	for _, binary := range bundledRuntimeBinaries {
		path := bundledRuntimeBinaryPath(naming.BinDir(), binary)
		if err := requireExecutableFile(path); err != nil {
			return fmt.Errorf("required builder runtime binary %s is unavailable: %w", path, err)
		}
	}
	for _, binary := range []string{"git", "iptables", "getent"} {
		if _, err := s.lookPath(binary); err != nil {
			return fmt.Errorf("required builder runtime binary %s is unavailable", binary)
		}
	}
	if s.Config.EgressProfile == "internet" {
		for _, plugin := range []string{"bridge", "host-local", "firewall", "loopback"} {
			if info, err := os.Stat(filepath.Join(s.Config.CNIBinaryDir, plugin)); err != nil || info.Mode()&0o111 == 0 {
				return fmt.Errorf("required CNI plugin %s is unavailable in %s", plugin, s.Config.CNIBinaryDir)
			}
		}
	}
	containerdConfig, err := s.Config.RenderContainerdConfig()
	if err != nil {
		return err
	}
	buildkitConfig, err := s.Config.RenderBuildkitConfig()
	if err != nil {
		return err
	}
	files := map[string]struct {
		content string
		mode    os.FileMode
	}{
		naming.ContainerdConfigPath(): {content: containerdConfig, mode: 0o600},
		naming.BuildkitConfigPath():   {content: buildkitConfig, mode: 0o600},
		s.Config.CNIConfigPath:        {content: renderCNIConfig(s.Config), mode: 0o600},
		naming.GitAskpassPath():       {content: renderGitAskpass(), mode: 0o755},
		naming.EgressScriptPath():     {content: renderEgressScript(s.Config), mode: 0o700},
		naming.EgressUnitPath():       {content: renderEgressUnit(naming), mode: 0o644},
		naming.ContainerdUnitPath():   {content: renderContainerdUnit(s.Config), mode: 0o644},
		naming.BuildkitUnitPath():     {content: renderBuildkitUnit(s.Config), mode: 0o644},
	}
	for path, file := range files {
		if err := writeManagedFile(path, file.content, file.mode); err != nil {
			return err
		}
	}
	legacyPaths := []string{filepath.Join(naming.LibDir, legacyRunscWrapperName)}
	for _, name := range legacyRuntimeFiles {
		legacyPaths = append(legacyPaths, filepath.Join(naming.ConfigDir, name))
	}
	for _, legacyPath := range legacyPaths {
		if err := os.Remove(legacyPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove legacy builder runtime file %s: %w", legacyPath, err)
		}
	}
	return nil
}

func (s *RuntimeSupervisor) Start() error {
	if _, err := s.lookPath("systemctl"); err != nil {
		return errors.New("builder runtime requires systemd")
	}
	if err := s.run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	naming := s.Config.Naming
	if err := s.run("systemctl", "enable", "--now", naming.EgressService); err != nil {
		return err
	}
	if err := s.run("systemctl", "restart", naming.EgressService); err != nil {
		return err
	}
	if err := s.run("systemctl", "enable", naming.ContainerdService); err != nil {
		return err
	}
	if err := s.run("systemctl", "enable", naming.BuildkitService); err != nil {
		return err
	}
	if err := s.run("systemctl", "restart", naming.ContainerdService); err != nil {
		return err
	}
	if err := s.run("systemctl", "restart", naming.BuildkitService); err != nil {
		return err
	}
	return nil
}

// ReapplyEgressPolicy renders the egress policy of build steps for
// controlPlaneAddress and applies it again (the egress unit runs it), leaving
// containerd and BuildKit running: builds in progress continue. The daemon
// calls it after Opfield moved to another address, so build steps stay fenced
// off the control plane at its new address.
func (s *RuntimeSupervisor) ReapplyEgressPolicy(controlPlaneAddress string) error {
	config := s.Config
	config.ControlPlaneAddress = controlPlaneAddress
	path := s.egressScriptPath
	if path == "" {
		path = config.Naming.EgressScriptPath()
	}
	if err := writeManagedFile(path, renderEgressScript(config), 0o700); err != nil {
		return err
	}
	if err := s.run("systemctl", "restart", config.Naming.EgressService); err != nil {
		return err
	}
	s.Config = config
	return nil
}

func renderCNIConfig(config RuntimeConfig) string {
	if config.EgressProfile == "offline" {
		return RenderLoopbackOnlyCNIConfig(config.Naming)
	}
	return RenderInternetCNIConfig(config.Naming)
}

// renderEgressScript renders the idempotent policy for build steps. Forwarded
// traffic goes through the naming's egress chain (OPFIELD_BUILDER_EGRESS). Traffic to the worker host
// itself (any of its addresses, including the bridge gateway) goes through
// INPUT and is rejected in every egress profile: build steps resolve names
// through public resolvers and need no host service. The bridge carries no
// IPv6, so IPv6 from it is dropped too. Packets from the bridge with a source
// outside the build subnet are spoofed and dropped.
func renderEgressScript(config RuntimeConfig) string {
	host, port := splitControlPlaneAddress(config.ControlPlaneAddress)
	modeRule := "-A $CHAIN -s $SUBNET -j ACCEPT"
	if config.EgressProfile == "offline" {
		modeRule = "-A $CHAIN -s $SUBNET -j REJECT"
	}
	return fmt.Sprintf(`#!/bin/sh
set -eu
IPT="$(command -v iptables)"
CHAIN=%s
HOST_CHAIN=%s
BRIDGE=%s
SUBNET=%s
CONTROL_HOST=%s
CONTROL_PORT=%s
$IPT -N "$CHAIN" 2>/dev/null || true
$IPT -F "$CHAIN"
$IPT -A "$CHAIN" ! -s "$SUBNET" -j DROP
for CIDR in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  $IPT -A "$CHAIN" -s "$SUBNET" -d "$CIDR" -j REJECT
done
if [ -n "$CONTROL_HOST" ]; then
  getent ahostsv4 "$CONTROL_HOST" | awk '{print $1}' | sort -u | while read -r IP; do
    [ -n "$IP" ] && $IPT -A "$CHAIN" -s "$SUBNET" -d "$IP/32" -p tcp --dport "$CONTROL_PORT" -j REJECT
  done
fi
$IPT %s
$IPT -N "$HOST_CHAIN" 2>/dev/null || true
$IPT -F "$HOST_CHAIN"
$IPT -A "$HOST_CHAIN" -j REJECT
$IPT -N CNI-ADMIN 2>/dev/null || true
$IPT -C CNI-ADMIN -s "$SUBNET" -j "$CHAIN" 2>/dev/null || $IPT -I CNI-ADMIN 1 -s "$SUBNET" -j "$CHAIN"
$IPT -C FORWARD -s "$SUBNET" -j "$CHAIN" 2>/dev/null || $IPT -I FORWARD 1 -s "$SUBNET" -j "$CHAIN"
$IPT -C FORWARD -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || $IPT -I FORWARD 1 -i "$BRIDGE" -j "$CHAIN"
$IPT -C INPUT -s "$SUBNET" -j "$HOST_CHAIN" 2>/dev/null || $IPT -I INPUT 1 -s "$SUBNET" -j "$HOST_CHAIN"
$IPT -C INPUT -i "$BRIDGE" -j "$HOST_CHAIN" 2>/dev/null || $IPT -I INPUT 1 -i "$BRIDGE" -j "$HOST_CHAIN"
if [ -e /proc/net/if_inet6 ]; then
  IP6T="$(command -v ip6tables)" || { echo "ip6tables is required to isolate the build network on an IPv6 host" >&2; exit 1; }
  $IP6T -N "$HOST_CHAIN" 2>/dev/null || true
  $IP6T -F "$HOST_CHAIN"
  $IP6T -A "$HOST_CHAIN" -j DROP
  $IP6T -C INPUT -i "$BRIDGE" -j "$HOST_CHAIN" 2>/dev/null || $IP6T -I INPUT 1 -i "$BRIDGE" -j "$HOST_CHAIN"
  $IP6T -C FORWARD -i "$BRIDGE" -j "$HOST_CHAIN" 2>/dev/null || $IP6T -I FORWARD 1 -i "$BRIDGE" -j "$HOST_CHAIN"
fi
`, config.Naming.EgressChain, config.Naming.HostChain, config.Naming.Bridge, BuilderNetworkSubnet, strconv.Quote(host), strconv.Quote(port), modeRule)
}

func splitControlPlaneAddress(address string) (string, string) {
	host, port, err := net.SplitHostPort(address)
	if err == nil {
		return strings.Trim(host, "[]"), port
	}
	if strings.Count(address, ":") == 0 {
		return address, "9443"
	}
	return "", "9443"
}

func renderEgressUnit(naming Naming) string {
	return `[Unit]
Description=Opfield builder egress policy
After=network-online.target
Wants=network-online.target
Before=` + naming.ContainerdService + ` ` + naming.BuildkitService + `

[Service]
Type=oneshot
ExecStart=` + naming.EgressScriptPath() + `
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`
}

func writeManagedFile(path, content string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s directory: %w", path, err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".opfield-builder-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.WriteString(content); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

func renderGitAskpass() string {
	return "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$OPFIELD_GIT_USERNAME\" ;;\n  *Password*) printf '%s\\n' \"$OPFIELD_GIT_PASSWORD\" ;;\n  *) exit 1 ;;\nesac\n"
}

func renderContainerdUnit(config RuntimeConfig) string {
	cpuQuota := strconv.FormatFloat(float64(config.CPULimitMillis)/10, 'f', 2, 64) + "%"
	return fmt.Sprintf(`[Unit]
Description=Opfield isolated builder containerd
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
Environment="PATH=%[4]s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=%[4]s/containerd --config %[5]s
Restart=always
RestartSec=3
LimitNOFILE=1048576
CPUQuota=%[1]s
MemoryMax=%[2]d
TasksMax=%[3]d
OOMPolicy=kill
UMask=0077
NoNewPrivileges=true
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
`, cpuQuota, config.MemoryLimitBytes, config.TasksLimit, config.Naming.BinDir(), config.Naming.ContainerdConfigPath())
}

func renderBuildkitUnit(config RuntimeConfig) string {
	return fmt.Sprintf(`[Unit]
Description=Opfield isolated BuildKit builder
After=%[3]s
Requires=%[3]s

[Service]
Type=notify
Environment="PATH=%[4]s:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=%[4]s/buildkitd --config %[5]s
Restart=always
RestartSec=3
LimitNOFILE=1048576
CPUQuota=100%%
MemoryMax=%[1]d
TasksMax=%[2]d
OOMPolicy=kill
UMask=0077
NoNewPrivileges=true
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
`, int64(1024*1024*1024), config.TasksLimit, config.Naming.ContainerdService, config.Naming.BinDir(), config.Naming.BuildkitConfigPath())
}

// SwitchToOpfieldNaming moves a worker running the runtime under its
// pre-Opfield names to the Opfield ones: it stops and removes the old services,
// their netfilter chains and bridge, moves the runtime's directories (leaving
// links under the old names), then installs and starts the runtime under the
// new names. Call it only while no build runs (Manager.TryPause) and only on a
// confirmed start. Every step is idempotent: after a crash the next start
// finds no old units and installs the new ones (SelectNaming), and the
// cleanup of old chains, bridge and cgroup runs again there.
func (s *RuntimeSupervisor) SwitchToOpfieldNaming() error {
	if !s.Config.Naming.Legacy {
		return nil
	}
	legacy := LegacyNaming
	for _, service := range []string{legacy.BuildkitService, legacy.ContainerdService, legacy.EgressService} {
		if _, err := os.Lstat(legacy.unitPath(service)); err != nil {
			continue
		}
		if err := s.run("systemctl", "disable", "--now", service); err != nil {
			return err
		}
	}
	for _, path := range []string{legacy.BuildkitUnitPath(), legacy.ContainerdUnitPath(), legacy.EgressUnitPath()} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := s.run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err := s.RemoveLegacyLeftovers(); err != nil {
		return err
	}
	config := s.Config
	config.Naming = OpfieldNaming
	fresh := DefaultRuntimeConfigFor(OpfieldNaming, config.SocketGID)
	config.BuildkitSocket, config.ContainerdSocket, config.ContainerdStateDir = fresh.BuildkitSocket, fresh.ContainerdSocket, fresh.ContainerdStateDir
	config.CNIConfigPath, config.CNIBinaryDir, config.ContainerdNamespace = fresh.CNIConfigPath, fresh.CNIBinaryDir, fresh.ContainerdNamespace
	s.Config = config
	if err := s.InstallConfiguration(); err != nil {
		return err
	}
	return s.Start()
}

// RemoveLegacyLeftovers removes what the pre-Opfield runtime leaves on the host
// once its services are gone: the jumps to and the netfilter chains, the build
// bridge, the cgroup parent and the CNI address records, and moves the
// directories to their Opfield names. It does nothing while the old units are
// installed.
func (s *RuntimeSupervisor) RemoveLegacyLeftovers() error {
	if LegacyUnits() > 0 {
		return nil
	}
	legacy := LegacyNaming
	script := `for IPT in iptables ip6tables; do
  command -v "$IPT" >/dev/null 2>&1 || continue
  for CHAIN in ` + legacy.EgressChain + ` ` + legacy.HostChain + `; do
    for PARENT in INPUT FORWARD CNI-ADMIN; do
      "$IPT" -S "$PARENT" 2>/dev/null | grep -- "-j $CHAIN\$" | sed 's/^-A /-D /' | while read -r RULE; do
        # shellcheck disable=SC2086
        "$IPT" $RULE || true
      done
    done
    "$IPT" -F "$CHAIN" 2>/dev/null || true
    "$IPT" -X "$CHAIN" 2>/dev/null || true
  done
done
if command -v ip >/dev/null 2>&1 && ip link show ` + legacy.Bridge + ` >/dev/null 2>&1; then
  ip link delete ` + legacy.Bridge + `
fi
`
	if err := s.run("sh", "-c", script); err != nil {
		return fmt.Errorf("remove the pre-Opfield builder network: %w", err)
	}
	_ = os.Remove(filepath.Join("/sys/fs/cgroup", legacy.CgroupParent))
	if err := os.RemoveAll(filepath.Join(DefaultCNIStateDir, legacy.OpenNetwork)); err != nil {
		return err
	}
	for _, pair := range builderDirPairs() {
		if _, err := hostrename.Move(pair); err != nil && !errors.Is(err, hostrename.ErrConflict) {
			return fmt.Errorf("move %s: %w", pair.Old, err)
		}
	}
	return nil
}
