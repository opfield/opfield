package lifecycle

import (
	"os"
	"strings"
	"testing"
)

// The installers pass the enrollment token in the environment, not on the command line every local user can read
// (R3-04); --token stays for automation, and --token - reads it from standard input.
func TestInstallTokenComesFromTheEnvironmentOrStdin(t *testing.T) {
	t.Setenv(InstallTokenEnv, " opf_node_v2_env \n")
	token, err := InstallToken("", nil)
	if err != nil || token != "opf_node_v2_env" {
		t.Fatalf("token from the environment = %q, %v", token, err)
	}
	if _, set := os.LookupEnv(InstallTokenEnv); set {
		t.Fatal("the token stays in the environment of what the install command starts")
	}

	t.Setenv(InstallTokenEnv, "opf_node_v2_env")
	if token, err := InstallToken("opf_node_v2_flag", nil); err != nil || token != "opf_node_v2_flag" {
		t.Fatalf("token from --token = %q, %v", token, err)
	}
	if token, err := InstallToken("-", strings.NewReader("opf_node_v2_stdin\nrest")); err != nil || token != "opf_node_v2_stdin" {
		t.Fatalf("token from standard input = %q, %v", token, err)
	}
	if token, err := InstallToken("", nil); err != nil || token != "" {
		t.Fatalf("no token = %q, %v", token, err)
	}
	if !strings.Contains(InstallTokenUsage, InstallTokenEnv) {
		t.Fatal("the usage line does not name the variable the installers look for")
	}
}

func TestCommandsWithoutArgumentsRefuseExtraOnes(t *testing.T) {
	for _, args := range [][]string{{"relay-supervisor"}, {"relay-supervisor", "run"}, {"relay-supervisor", "version"}} {
		if err := ExtraArgs(args); err != nil {
			t.Fatalf("%v refused: %v", args, err)
		}
	}
	if err := ExtraArgs([]string{"relay-supervisor", "run", "version"}); err == nil {
		t.Fatal("run version was accepted")
	}
}
