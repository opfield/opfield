package builder

import (
	"os"
	"path/filepath"

	"github.com/opfield/opfield/daemon-shared/hostrename"
)

// Naming is every host name the isolated builder runtime uses: its
// directories, systemd units, netfilter chains, bridge, containerd namespace
// and CNI networks. Before Opfield they were gateway-builder*; a worker
// installed then keeps those names until its daemon's start is confirmed
// (the launcher may still roll back to a daemon that knows only them, and two
// runtimes on one containerd root must never run), and moves to the Opfield
// names between two builds (SwitchToOpfieldNaming).
type Naming struct {
	ConfigDir string
	OptDir    string
	LibDir    string
	RunDir    string

	ContainerdService string
	BuildkitService   string
	EgressService     string

	EgressChain  string
	HostChain    string
	Bridge       string
	Namespace    string
	CgroupParent string
	DenyNetwork  string
	OpenNetwork  string

	// Legacy marks the pre-Opfield names.
	Legacy bool
}

var (
	// OpfieldNaming is what new workers use.
	OpfieldNaming = Naming{
		ConfigDir: "/etc/opfield-builder", OptDir: "/opt/opfield-builder", LibDir: "/usr/local/lib/opfield-builder", RunDir: "/run/opfield-builder",
		ContainerdService: "opfield-builder-containerd.service", BuildkitService: "opfield-builder-buildkit.service", EgressService: "opfield-builder-egress.service",
		EgressChain: "OPFIELD_BUILDER_EGRESS", HostChain: "OPFIELD_BUILDER_HOST", Bridge: "opfield-builds0",
		// The namespace inside the builder's own containerd keeps its name: the
		// build cache in the containerd root is filed under it (a new name would
		// orphan the cache), and nothing outside that containerd shows it.
		Namespace: builderContainerdNamespace, CgroupParent: "opfield-builds", DenyNetwork: "opfield-builder-deny-egress", OpenNetwork: "opfield-builder-internet",
	}
	// LegacyNaming is the pre-Opfield runtime.
	// legacy-name: gateway-builder* runtime names of pre-Opfield builder workers — remove once every node reports none
	LegacyNaming = Naming{
		ConfigDir: "/etc/gateway-builder", OptDir: "/opt/gateway-builder", LibDir: "/usr/local/lib/gateway-builder", RunDir: "/run/gateway-builder",
		ContainerdService: "gateway-builder-containerd.service", BuildkitService: "gateway-builder-buildkit.service", EgressService: "gateway-builder-egress.service",
		EgressChain: "GATEWAY_BUILDER_EGRESS", HostChain: "GATEWAY_BUILDER_HOST", Bridge: "gateway-builds0",
		Namespace: builderContainerdNamespace, CgroupParent: "gateway-builds", DenyNetwork: "gateway-builder-deny-egress", OpenNetwork: "gateway-builder-internet",
		Legacy: true,
	}
)

// builderContainerdNamespace is internal to the builder's private containerd
// (kept on purpose, see OpfieldNaming).
const builderContainerdNamespace = "gateway-builds"

// builderDirPairs are the builder's host directories under both names.
func builderDirPairs() []hostrename.Pair {
	return []hostrename.Pair{
		{Old: LegacyNaming.ConfigDir, New: OpfieldNaming.ConfigDir},
		{Old: LegacyNaming.OptDir, New: OpfieldNaming.OptDir},
		{Old: LegacyNaming.LibDir, New: OpfieldNaming.LibDir},
		{Old: LegacyNaming.RunDir, New: OpfieldNaming.RunDir},
	}
}

// systemdDir is where the builder's units live; tests point it elsewhere.
var systemdDir = "/etc/systemd/system"

func (n Naming) unitPath(service string) string { return filepath.Join(systemdDir, service) }

// ContainerdUnitPath, BuildkitUnitPath and EgressUnitPath are the unit files.
func (n Naming) ContainerdUnitPath() string { return n.unitPath(n.ContainerdService) }
func (n Naming) BuildkitUnitPath() string   { return n.unitPath(n.BuildkitService) }
func (n Naming) EgressUnitPath() string     { return n.unitPath(n.EgressService) }

// BinDir holds the bundled runtime binaries the node installer provides. Under
// the Opfield names it is wherever the bundle is now: an installer may still
// have unpacked it under the pre-Opfield directory, which a confirmed start
// moves.
func (n Naming) BinDir() string {
	if n.Legacy {
		return filepath.Join(n.OptDir, "bin")
	}
	return filepath.Join(hostrename.Resolve(hostrename.Pair{Old: LegacyNaming.OptDir, New: n.OptDir}), "bin")
}

// CNIBinDir holds the CNI plugins of the bundle.
func (n Naming) CNIBinDir() string { return filepath.Join(filepath.Dir(n.BinDir()), "cni", "bin") }

func (n Naming) ContainerdConfigPath() string { return filepath.Join(n.ConfigDir, "containerd.toml") }
func (n Naming) BuildkitConfigPath() string   { return filepath.Join(n.ConfigDir, "buildkitd.toml") }
func (n Naming) CNIConfigPath() string        { return filepath.Join(n.ConfigDir, "cni.conflist") }
func (n Naming) GitAskpassPath() string       { return filepath.Join(n.LibDir, "git-askpass") }
func (n Naming) EgressScriptPath() string     { return filepath.Join(n.LibDir, "apply-egress-policy") }
func (n Naming) BuildkitSocketDir() string    { return filepath.Join(n.RunDir, "buildkit") }
func (n Naming) ContainerdSocketDir() string  { return filepath.Join(n.RunDir, "containerd") }

// SelectNaming is the naming a starting daemon runs the builder under: the
// pre-Opfield one while its units are installed, else the Opfield one.
func SelectNaming() Naming {
	if _, err := os.Lstat(LegacyNaming.ContainerdUnitPath()); err == nil {
		return LegacyNaming
	}
	if _, err := os.Lstat(LegacyNaming.BuildkitUnitPath()); err == nil {
		return LegacyNaming
	}
	return OpfieldNaming
}

// LegacyUnits counts the pre-Opfield builder units still installed.
func LegacyUnits() uint32 {
	var count uint32
	for _, path := range []string{LegacyNaming.ContainerdUnitPath(), LegacyNaming.BuildkitUnitPath(), LegacyNaming.EgressUnitPath()} {
		if _, err := os.Lstat(path); err == nil {
			count++
		}
	}
	return count
}

// LegacyPaths counts the builder directories still under pre-Opfield names.
func LegacyPaths() uint32 {
	var count uint32
	for _, pair := range builderDirPairs() {
		if hostrename.Legacy(pair) {
			count++
		}
	}
	return count
}
