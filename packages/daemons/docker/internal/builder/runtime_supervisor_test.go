package builder

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fakeIptables keeps each chain as a file of rule lines, one directory per
// binary, and implements the -N, -F, -A, -I and -C operations the egress
// script uses with the exit codes of iptables.
const fakeIptables = `#!/bin/sh
dir="$FAKE_NETFILTER/$(basename "$0")"
op="$1"; chain="$2"; shift 2
file="$dir/$chain"
case "$op" in
  -N) [ -e "$file" ] && exit 1; : > "$file" ;;
  -F) [ -e "$file" ] || exit 1; : > "$file" ;;
  -A) [ -e "$file" ] || exit 1; echo "$*" >> "$file" ;;
  -I) [ -e "$file" ] || exit 1; position="$1"; shift
      awk -v p="$position" -v r="$*" 'NR == p { print r } { print } END { if (NR < p) print r }' "$file" > "$file.new" && mv "$file.new" "$file" ;;
  -C) [ -e "$file" ] || exit 1; grep -qxF -- "$*" "$file" ;;
  *) exit 2 ;;
esac
`

type fakeNetfilter struct {
	t    *testing.T
	root string
	path string
}

func newFakeNetfilter(t *testing.T, binaries ...string) *fakeNetfilter {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh is unavailable")
	}
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, binary := range binaries {
		if err := os.WriteFile(filepath.Join(bin, binary), []byte(fakeIptables), 0o755); err != nil {
			t.Fatal(err)
		}
		for _, chain := range []string{"INPUT", "FORWARD", "OUTPUT"} {
			if err := os.MkdirAll(filepath.Join(root, binary), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, binary, chain), nil, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return &fakeNetfilter{t: t, root: root, path: bin + string(os.PathListSeparator) + "/usr/bin:/bin"}
}

func (f *fakeNetfilter) apply(config RuntimeConfig) error {
	f.t.Helper()
	script := filepath.Join(f.root, "apply-egress-policy")
	if err := os.WriteFile(script, []byte(renderEgressScript(config)), 0o700); err != nil {
		f.t.Fatal(err)
	}
	command := exec.Command("sh", script)
	command.Env = []string{"PATH=" + f.path, "FAKE_NETFILTER=" + f.root}
	output, err := command.CombinedOutput()
	if err != nil {
		f.t.Logf("apply-egress-policy: %s", output)
	}
	return err
}

func (f *fakeNetfilter) chain(binary, name string) []string {
	f.t.Helper()
	content, err := os.ReadFile(filepath.Join(f.root, binary, name))
	if err != nil {
		f.t.Fatalf("read %s %s: %v", binary, name, err)
	}
	return strings.Split(strings.TrimSuffix(string(content), "\n"), "\n")
}

func ipv6Enabled() bool {
	_, err := os.Stat("/proc/net/if_inet6")
	return err == nil
}

func egressConfig(profile string) RuntimeConfig {
	config := DefaultRuntimeConfig(0)
	config.EgressProfile = profile
	return config
}

func TestEgressPolicyRejectsBuildTrafficToTheWorkerHostInEveryProfile(t *testing.T) {
	for _, profile := range []string{"internet", "offline"} {
		t.Run(profile, func(t *testing.T) {
			netfilter := newFakeNetfilter(t, "iptables", "ip6tables")
			if err := netfilter.apply(egressConfig(profile)); err != nil {
				t.Fatal(err)
			}
			wantInput := []string{
				"-i opfield-builds0 -j OPFIELD_BUILDER_HOST",
				"-s 10.203.0.0/24 -j OPFIELD_BUILDER_HOST",
			}
			if got := netfilter.chain("iptables", "INPUT"); !reflect.DeepEqual(got, wantInput) {
				t.Fatalf("INPUT = %q, want %q", got, wantInput)
			}
			if got := netfilter.chain("iptables", "OPFIELD_BUILDER_HOST"); !reflect.DeepEqual(got, []string{"-j REJECT"}) {
				t.Fatalf("OPFIELD_BUILDER_HOST = %q, want only a reject", got)
			}
			if !ipv6Enabled() {
				return
			}
			wantIPv6 := []string{"-i opfield-builds0 -j OPFIELD_BUILDER_HOST"}
			for _, chain := range []string{"INPUT", "FORWARD"} {
				if got := netfilter.chain("ip6tables", chain); !reflect.DeepEqual(got, wantIPv6) {
					t.Fatalf("ip6tables %s = %q, want %q", chain, got, wantIPv6)
				}
			}
			if got := netfilter.chain("ip6tables", "OPFIELD_BUILDER_HOST"); !reflect.DeepEqual(got, []string{"-j DROP"}) {
				t.Fatalf("ip6tables OPFIELD_BUILDER_HOST = %q, want only a drop", got)
			}
		})
	}
}

func TestEgressPolicyKeepsForwardedBuildTrafficInTheEgressChain(t *testing.T) {
	netfilter := newFakeNetfilter(t, "iptables", "ip6tables")
	if err := netfilter.apply(egressConfig("internet")); err != nil {
		t.Fatal(err)
	}
	wantForward := []string{
		"-i opfield-builds0 -j OPFIELD_BUILDER_EGRESS",
		"-s 10.203.0.0/24 -j OPFIELD_BUILDER_EGRESS",
	}
	if got := netfilter.chain("iptables", "FORWARD"); !reflect.DeepEqual(got, wantForward) {
		t.Fatalf("FORWARD = %q, want %q", got, wantForward)
	}
	if got := netfilter.chain("iptables", "CNI-ADMIN"); !reflect.DeepEqual(got, []string{"-s 10.203.0.0/24 -j OPFIELD_BUILDER_EGRESS"}) {
		t.Fatalf("CNI-ADMIN = %q", got)
	}
	egress := netfilter.chain("iptables", "OPFIELD_BUILDER_EGRESS")
	if egress[0] != "! -s 10.203.0.0/24 -j DROP" {
		t.Fatalf("first egress rule = %q, want the drop of spoofed sources", egress[0])
	}
	for _, blocked := range []string{"10.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"} {
		rule := "-s 10.203.0.0/24 -d " + blocked + " -j REJECT"
		if !containsLine(egress, rule) {
			t.Fatalf("egress chain misses %q: %q", rule, egress)
		}
	}
	if last := egress[len(egress)-1]; last != "-s 10.203.0.0/24 -j ACCEPT" {
		t.Fatalf("last egress rule = %q, want the internet accept", last)
	}
}

func TestEgressPolicyReapplyAndProfileChangeLeaveOneCopyOfEachRule(t *testing.T) {
	fresh := newFakeNetfilter(t, "iptables", "ip6tables")
	if err := fresh.apply(egressConfig("offline")); err != nil {
		t.Fatal(err)
	}
	netfilter := newFakeNetfilter(t, "iptables", "ip6tables")
	for _, profile := range []string{"internet", "internet", "offline", "offline"} {
		if err := netfilter.apply(egressConfig(profile)); err != nil {
			t.Fatalf("apply %s: %v", profile, err)
		}
	}
	binaries := []string{"iptables"}
	if ipv6Enabled() {
		binaries = append(binaries, "ip6tables")
	}
	for _, binary := range binaries {
		entries, err := os.ReadDir(filepath.Join(fresh.root, binary))
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			want := fresh.chain(binary, entry.Name())
			if got := netfilter.chain(binary, entry.Name()); !reflect.DeepEqual(got, want) {
				t.Fatalf("%s %s after reapply and profile change = %q, want %q", binary, entry.Name(), got, want)
			}
		}
	}
	egress := netfilter.chain("iptables", "OPFIELD_BUILDER_EGRESS")
	if containsLine(egress, "-s 10.203.0.0/24 -j ACCEPT") || egress[len(egress)-1] != "-s 10.203.0.0/24 -j REJECT" {
		t.Fatalf("offline egress chain = %q, want the internet accept replaced by a reject", egress)
	}
}

func TestEgressPolicyFailsClosedWithoutIP6TablesOnAnIPv6Host(t *testing.T) {
	if !ipv6Enabled() {
		t.Skip("IPv6 is disabled on this host")
	}
	netfilter := newFakeNetfilter(t, "iptables")
	if err := netfilter.apply(egressConfig("internet")); err == nil {
		t.Fatal("egress policy applied without ip6tables on an IPv6 host")
	}
}

func TestBuilderBridgeNameMatchesTheCNIConfig(t *testing.T) {
	for _, naming := range []Naming{OpfieldNaming, LegacyNaming} {
		if !strings.Contains(RenderInternetCNIConfig(naming), `"bridge": "`+naming.Bridge+`"`) {
			t.Fatalf("CNI config does not use bridge %s", naming.Bridge)
		}
	}
}

func containsLine(lines []string, line string) bool {
	for _, candidate := range lines {
		if candidate == line {
			return true
		}
	}
	return false
}

func TestReapplyEgressPolicyFencesTheNewControlAddressWithoutRestartingTheRuntime(t *testing.T) {
	config := DefaultRuntimeConfig(0)
	config.ControlPlaneAddress = "old.example:9443"
	var commands []string
	supervisor := &RuntimeSupervisor{
		Config:           config,
		egressScriptPath: filepath.Join(t.TempDir(), "apply-egress-policy"),
		run: func(name string, args ...string) error {
			commands = append(commands, name+" "+strings.Join(args, " "))
			return nil
		},
	}
	if err := supervisor.ReapplyEgressPolicy("new.example:7443"); err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile(supervisor.egressScriptPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(script), `CONTROL_HOST="new.example"`) || !strings.Contains(string(script), `CONTROL_PORT="7443"`) {
		t.Fatalf("policy does not fence the new address:\n%s", script)
	}
	if want := []string{"systemctl restart " + OpfieldNaming.EgressService}; !reflect.DeepEqual(commands, want) {
		t.Fatalf("commands = %v, want %v (containerd and BuildKit keep running)", commands, want)
	}
	if supervisor.Config.ControlPlaneAddress != "new.example:7443" {
		t.Fatalf("config keeps %q", supervisor.Config.ControlPlaneAddress)
	}
}
