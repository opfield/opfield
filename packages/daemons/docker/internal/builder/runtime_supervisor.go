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
)

const (
	DefaultRuntimeConfigDir     = "/etc/gateway-builder"
	DefaultRuntimeBinDir        = "/opt/gateway-builder/bin"
	DefaultContainerdConfigPath = "/etc/gateway-builder/containerd.toml"
	DefaultBuildkitConfigPath   = "/etc/gateway-builder/buildkitd.toml"
	DefaultContainerdUnitPath   = "/etc/systemd/system/gateway-builder-containerd.service"
	DefaultBuildkitUnitPath     = "/etc/systemd/system/gateway-builder-buildkit.service"
	legacyCNIConfigPath         = "/etc/gateway-builder/cni.json"
	legacyRunscConfigPath       = "/etc/gateway-builder/runsc.toml"
	legacyRunscWrapperPath      = "/usr/local/lib/gateway-builder/runsc-oci"
	DefaultGitAskpassDirectory  = "/usr/local/lib/gateway-builder"
	DefaultEgressScriptPath     = "/usr/local/lib/gateway-builder/apply-egress-policy"
	DefaultEgressUnitPath       = "/etc/systemd/system/gateway-builder-egress.service"
	containerdServiceName       = "gateway-builder-containerd.service"
	buildkitServiceName         = "gateway-builder-buildkit.service"
	egressServiceName           = "gateway-builder-egress.service"
)

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

func bundledRuntimeBinaryPath(name string) string {
	return filepath.Join(DefaultRuntimeBinDir, name)
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

func resolveBuilderExecutable(name string) (string, error) {
	for _, bundled := range bundledRuntimeBinaries {
		if name == bundled {
			path := bundledRuntimeBinaryPath(name)
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
	for _, binary := range bundledRuntimeBinaries {
		path := bundledRuntimeBinaryPath(binary)
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
		DefaultContainerdConfigPath: {content: containerdConfig, mode: 0o600},
		DefaultBuildkitConfigPath:   {content: buildkitConfig, mode: 0o600},
		s.Config.CNIConfigPath:      {content: renderCNIConfig(s.Config), mode: 0o600},
		DefaultGitAskpassPath:       {content: renderGitAskpass(), mode: 0o755},
		DefaultEgressScriptPath:     {content: renderEgressScript(s.Config), mode: 0o700},
		DefaultEgressUnitPath:       {content: renderEgressUnit(), mode: 0o644},
		DefaultContainerdUnitPath:   {content: renderContainerdUnit(s.Config), mode: 0o644},
		DefaultBuildkitUnitPath:     {content: renderBuildkitUnit(s.Config), mode: 0o644},
	}
	for path, file := range files {
		if err := writeManagedFile(path, file.content, file.mode); err != nil {
			return err
		}
	}
	for _, legacyPath := range []string{legacyCNIConfigPath, legacyRunscConfigPath, legacyRunscWrapperPath} {
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
	if err := s.run("systemctl", "enable", "--now", egressServiceName); err != nil {
		return err
	}
	if err := s.run("systemctl", "restart", egressServiceName); err != nil {
		return err
	}
	if err := s.run("systemctl", "enable", containerdServiceName); err != nil {
		return err
	}
	if err := s.run("systemctl", "enable", buildkitServiceName); err != nil {
		return err
	}
	if err := s.run("systemctl", "restart", containerdServiceName); err != nil {
		return err
	}
	if err := s.run("systemctl", "restart", buildkitServiceName); err != nil {
		return err
	}
	return nil
}

func renderCNIConfig(config RuntimeConfig) string {
	if config.EgressProfile == "offline" {
		return RenderLoopbackOnlyCNIConfig()
	}
	return RenderInternetCNIConfig()
}

// renderEgressScript renders the idempotent policy for build steps. Forwarded
// traffic goes through GATEWAY_BUILDER_EGRESS. Traffic to the worker host
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
CHAIN=GATEWAY_BUILDER_EGRESS
HOST_CHAIN=GATEWAY_BUILDER_HOST
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
`, BuilderBridgeName, BuilderNetworkSubnet, strconv.Quote(host), strconv.Quote(port), modeRule)
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

func renderEgressUnit() string {
	return `[Unit]
Description=Opfield builder egress policy
After=network-online.target
Wants=network-online.target
Before=gateway-builder-containerd.service gateway-builder-buildkit.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/gateway-builder/apply-egress-policy
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`
}

func writeManagedFile(path, content string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create %s directory: %w", path, err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".gateway-builder-*")
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
	return "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$GATEWAY_GIT_USERNAME\" ;;\n  *Password*) printf '%s\\n' \"$GATEWAY_GIT_PASSWORD\" ;;\n  *) exit 1 ;;\nesac\n"
}

func renderContainerdUnit(config RuntimeConfig) string {
	cpuQuota := strconv.FormatFloat(float64(config.CPULimitMillis)/10, 'f', 2, 64) + "%"
	return fmt.Sprintf(`[Unit]
Description=Opfield isolated builder containerd
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
Environment="PATH=/opt/gateway-builder/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=/opt/gateway-builder/bin/containerd --config /etc/gateway-builder/containerd.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576
CPUQuota=%s
MemoryMax=%d
TasksMax=%d
OOMPolicy=kill
UMask=0077
NoNewPrivileges=true
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
`, cpuQuota, config.MemoryLimitBytes, config.TasksLimit)
}

func renderBuildkitUnit(config RuntimeConfig) string {
	return fmt.Sprintf(`[Unit]
Description=Opfield isolated BuildKit builder
After=gateway-builder-containerd.service
Requires=gateway-builder-containerd.service

[Service]
Type=notify
Environment="PATH=/opt/gateway-builder/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=/opt/gateway-builder/bin/buildkitd --config /etc/gateway-builder/buildkitd.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576
CPUQuota=100%%
MemoryMax=%d
TasksMax=%d
OOMPolicy=kill
UMask=0077
NoNewPrivileges=true
TimeoutStopSec=15s

[Install]
WantedBy=multi-user.target
`, int64(1024*1024*1024), config.TasksLimit)
}
