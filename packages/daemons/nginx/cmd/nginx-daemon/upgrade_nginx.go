package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/opfield/opfield/nginx-daemon/internal/nginxupgrade"
)

// runUpgradeNginx is the operator's way to the nginx upgrade on a node whose daemon cannot run it itself (its own
// user, no upgrade helper): as root, the embedded helper installs the nginx.org stable package and hands the running
// nginx over to it.
func runUpgradeNginx() {
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "nginx-daemon upgrade-nginx must run as root")
		os.Exit(1)
	}
	path, cleanup, err := nginxupgrade.ScriptFile()
	if err != nil {
		fmt.Fprintf(os.Stderr, "nginx-daemon upgrade-nginx: %v\n", err)
		os.Exit(1)
	}
	cmd := exec.Command("/bin/sh", path, "upgrade")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	err = cmd.Run()
	cleanup()
	if err != nil {
		os.Exit(1)
	}
}
