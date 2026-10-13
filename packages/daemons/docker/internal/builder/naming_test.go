package builder

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelectNamingKeepsALegacyWorkerUntilTheSwitch(t *testing.T) {
	saved := systemdDir
	systemdDir = t.TempDir()
	t.Cleanup(func() { systemdDir = saved })
	if SelectNaming().Legacy || LegacyUnits() != 0 {
		t.Fatal("a new worker runs under the Opfield names")
	}
	if err := os.WriteFile(LegacyNaming.ContainerdUnitPath(), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !SelectNaming().Legacy || LegacyUnits() != 1 {
		t.Fatal("a worker with the old units keeps them until its start is confirmed")
	}
	// While the old units are installed nothing of them is touched.
	var commands []string
	supervisor := &RuntimeSupervisor{Config: DefaultRuntimeConfigFor(LegacyNaming, 0), run: func(name string, args ...string) error {
		commands = append(commands, name+" "+strings.Join(args, " "))
		return nil
	}}
	if err := supervisor.RemoveLegacyLeftovers(); err != nil || len(commands) != 0 {
		t.Fatalf("leftovers removed next to running old units: %v %v", commands, err)
	}
}

func TestNamingsRenderTheirOwnNames(t *testing.T) {
	for _, naming := range []Naming{OpfieldNaming, LegacyNaming} {
		config := DefaultRuntimeConfigFor(naming, 0)
		if err := config.Validate(); err != nil {
			t.Fatalf("%s: %v", naming.ConfigDir, err)
		}
		buildkit, _ := config.RenderBuildkitConfig()
		if !strings.Contains(buildkit, `defaultCgroupParent = "`+naming.CgroupParent+`"`) || !strings.Contains(buildkit, naming.CNIConfigPath()) {
			t.Fatalf("buildkit config of %s:\n%s", naming.ConfigDir, buildkit)
		}
		unit := renderBuildkitUnit(config)
		if !strings.Contains(unit, "Requires="+naming.ContainerdService) || !strings.Contains(unit, "--config "+naming.BuildkitConfigPath()) {
			t.Fatalf("buildkit unit of %s:\n%s", naming.ConfigDir, unit)
		}
		if !strings.Contains(renderEgressScript(config), "CHAIN="+naming.EgressChain) || !strings.Contains(renderEgressUnit(naming), "ExecStart="+naming.EgressScriptPath()) {
			t.Fatalf("egress of %s", naming.ConfigDir)
		}
	}
	opfield := DefaultRuntimeConfigFor(OpfieldNaming, 0)
	for _, text := range []string{renderContainerdUnit(opfield), renderBuildkitUnit(opfield), renderEgressScript(opfield), RenderInternetCNIConfig(OpfieldNaming), renderGitAskpass()} {
		// The bundle directory is wherever the installer put it (it may still be
		// under the pre-Opfield name on this host until a confirmed start moves it).
		text = strings.ReplaceAll(text, filepath.Dir(OpfieldNaming.BinDir()), "<bundle>")
		if strings.Contains(text, "gateway-builder") || strings.Contains(text, "GATEWAY_") || strings.Contains(text, "gateway-builds0") {
			t.Fatalf("Opfield runtime carries an old name:\n%s", text)
		}
	}
	if filepath.Dir(OpfieldNaming.GitAskpassPath()) != OpfieldNaming.LibDir {
		t.Fatal("askpass path")
	}
}
