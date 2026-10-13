package builder

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	DefaultBuildkitStateDir  = "/var/lib/docker-daemon/builder/buildkit"
	DefaultContainerdRootDir = "/var/lib/docker-daemon/builder/containerd"
	DefaultCNIStateDir       = "/var/lib/docker-daemon/builder/cni"
	DefaultRegistryCAPath    = "/var/lib/docker-daemon/registry-proxy/ca.pem"
	DefaultBuildParallelism  = 16
	DefaultCPULimitMillis    = int64(2000)
	DefaultMemoryLimitBytes  = int64(4 * 1024 * 1024 * 1024)
	DefaultDiskLimitBytes    = int64(20 * 1024 * 1024 * 1024)
	DefaultTasksLimit        = int64(2048)
	DefaultEgressProfile     = "internet"
	BuilderNetworkSubnet     = "10.203.0.0/24"
)

type RuntimeConfig struct {
	// Naming is the set of host names the runtime uses (naming.go).
	Naming              Naming
	BuildkitSocket      string
	BuildkitStateDir    string
	ContainerdSocket    string
	ContainerdStateDir  string
	ContainerdRootDir   string
	CNIConfigPath       string
	CNIBinaryDir        string
	RegistryCAPath      string
	ContainerdNamespace string
	SocketGID           int
	MaxParallelism      int
	CPULimitMillis      int64
	MemoryLimitBytes    int64
	DiskLimitBytes      int64
	TasksLimit          int64
	EgressProfile       string
	ControlPlaneAddress string
}

// DefaultRuntimeConfig is the runtime of a worker under the Opfield names.
func DefaultRuntimeConfig(socketGID int) RuntimeConfig {
	return DefaultRuntimeConfigFor(OpfieldNaming, socketGID)
}

// DefaultRuntimeConfigFor is the runtime under naming.
func DefaultRuntimeConfigFor(naming Naming, socketGID int) RuntimeConfig {
	return RuntimeConfig{
		Naming:              naming,
		BuildkitSocket:      filepath.Join(naming.BuildkitSocketDir(), "buildkitd.sock"),
		BuildkitStateDir:    DefaultBuildkitStateDir,
		ContainerdSocket:    filepath.Join(naming.ContainerdSocketDir(), "containerd.sock"),
		ContainerdStateDir:  filepath.Join(naming.ContainerdSocketDir(), "state"),
		ContainerdRootDir:   DefaultContainerdRootDir,
		CNIConfigPath:       naming.CNIConfigPath(),
		CNIBinaryDir:        naming.CNIBinDir(),
		RegistryCAPath:      DefaultRegistryCAPath,
		ContainerdNamespace: naming.Namespace,
		SocketGID:           socketGID,
		MaxParallelism:      DefaultBuildParallelism,
		CPULimitMillis:      DefaultCPULimitMillis,
		MemoryLimitBytes:    DefaultMemoryLimitBytes,
		DiskLimitBytes:      DefaultDiskLimitBytes,
		TasksLimit:          DefaultTasksLimit,
		EgressProfile:       DefaultEgressProfile,
	}
}

func (c RuntimeConfig) Validate() error {
	if c.Naming.RunDir == "" {
		return errors.New("builder runtime naming is required")
	}
	if !filepath.IsAbs(c.BuildkitSocket) || filepath.Clean(filepath.Dir(c.BuildkitSocket)) != c.Naming.BuildkitSocketDir() {
		return fmt.Errorf("BuildKit socket must be directly under %s", c.Naming.BuildkitSocketDir())
	}
	if !filepath.IsAbs(c.ContainerdSocket) || filepath.Clean(filepath.Dir(c.ContainerdSocket)) != c.Naming.ContainerdSocketDir() {
		return fmt.Errorf("containerd socket must be directly under %s", c.Naming.ContainerdSocketDir())
	}
	for name, value := range map[string]string{
		"BuildKit state directory":   c.BuildkitStateDir,
		"containerd state directory": c.ContainerdStateDir,
		"containerd root directory":  c.ContainerdRootDir,
		"CNI config path":            c.CNIConfigPath,
		"CNI binary directory":       c.CNIBinaryDir,
		"registry CA path":           c.RegistryCAPath,
	} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return fmt.Errorf("%s must be a clean absolute path", name)
		}
	}
	if c.ContainerdNamespace != c.Naming.Namespace {
		return fmt.Errorf("containerd namespace must remain %s", c.Naming.Namespace)
	}
	if c.SocketGID < 0 {
		return errors.New("socket GID cannot be negative")
	}
	if c.MaxParallelism < 1 || c.MaxParallelism > 16 {
		return errors.New("isolated builder runtime parallelism must be between 1 and 16")
	}
	if c.CPULimitMillis < 100 || c.CPULimitMillis > 64_000 {
		return errors.New("builder CPU limit must be between 100 and 64000 millicores")
	}
	if c.MemoryLimitBytes < 512*1024*1024 {
		return errors.New("builder memory limit must be at least 512 MiB")
	}
	if c.DiskLimitBytes < 1024*1024*1024 {
		return errors.New("builder disk limit must be at least 1 GiB")
	}
	if c.TasksLimit < 64 {
		return errors.New("builder task limit must be at least 64")
	}
	if c.EgressProfile != "internet" && c.EgressProfile != "offline" {
		return errors.New("builder egress profile must be internet or offline")
	}
	return nil
}

func (c RuntimeConfig) RenderContainerdConfig() (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	quote := strconv.Quote
	return strings.Join([]string{
		"version = 3",
		"root = " + quote(c.ContainerdRootDir),
		"state = " + quote(c.ContainerdStateDir),
		"disabled_plugins = [\"io.containerd.cri.v1.runtime\", \"io.containerd.grpc.v1.cri\"]",
		"",
		"[grpc]",
		"  address = " + quote(c.ContainerdSocket),
		"  gid = " + strconv.Itoa(c.SocketGID),
		"",
		"[plugins.\"io.containerd.nri.v1.nri\"]",
		"  disable = true",
		"  disable_connections = true",
		"",
	}, "\n"), nil
}

func (c RuntimeConfig) RenderBuildkitConfig() (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	quote := strconv.Quote
	return strings.Join([]string{
		"root = " + quote(c.BuildkitStateDir),
		"insecure-entitlements = []",
		"",
		"[log]",
		"  format = \"json\"",
		"  level = \"info\"",
		"",
		"[dns]",
		"  nameservers = [\"1.1.1.1\", \"8.8.8.8\"]",
		"",
		"[grpc]",
		"  address = [" + quote("unix://"+c.BuildkitSocket) + "]",
		"  gid = " + strconv.Itoa(c.SocketGID),
		"",
		"[cdi]",
		"  disabled = true",
		"",
		"[worker.oci]",
		"  enabled = false",
		"",
		"[worker.containerd]",
		"  enabled = true",
		"  address = " + quote(c.ContainerdSocket),
		"  namespace = " + quote(c.ContainerdNamespace),
		"  snapshotter = \"overlayfs\"",
		"  networkMode = \"cni\"",
		"  cniConfigPath = " + quote(c.CNIConfigPath),
		"  cniBinaryPath = " + quote(c.CNIBinaryDir),
		"  max-parallelism = " + strconv.Itoa(c.MaxParallelism),
		"  gc = true",
		"  reservedSpace = \"1GB\"",
		"  maxUsedSpace = " + quote(strconv.FormatInt(c.DiskLimitBytes, 10)+"B"),
		"  minFreeSpace = \"10GB\"",
		"  defaultCgroupParent = " + quote(c.Naming.CgroupParent),
		"",
		"[registry.\"127.0.0.1:5443\"]",
		"  http = false",
		"  ca = [" + quote(c.RegistryCAPath) + "]",
		"",
		// BuildKit's own built-in "gateway" frontend, not a product name.
		"[frontend.\"gateway.v0\"]",
		"  enabled = false",
		"",
	}, "\n"), nil
}

func RenderLoopbackOnlyCNIConfig(naming Naming) string {
	return `{
  "cniVersion": "1.0.0",
  "name": "` + naming.DenyNetwork + `",
  "plugins": [
    {"type": "loopback"}
  ]
}
`
}

func RenderInternetCNIConfig(naming Naming) string {
	return `{
  "cniVersion": "1.0.0",
  "name": "` + naming.OpenNetwork + `",
  "plugins": [
    {
      "type": "bridge",
      "bridge": "` + naming.Bridge + `",
      "isGateway": true,
      "ipMasq": true,
      "hairpinMode": false,
      "ipam": {
        "type": "host-local",
        "dataDir": "` + DefaultCNIStateDir + `",
        "ranges": [[{"subnet": "10.203.0.0/24", "gateway": "10.203.0.1"}]],
        "routes": [{"dst": "0.0.0.0/0"}]
      },
      "dns": {"nameservers": ["1.1.1.1", "8.8.8.8"]}
    },
    {"type": "firewall", "backend": "iptables"}
  ]
}
`
}
