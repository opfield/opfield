//go:build linux

package supervisor

import "syscall"

// witnessProcAttr runs a witness in its own process group. orphanKill ends a
// witness with the supervisor when no systemd scope owns it, so a restarted
// supervisor never finds an old witness on its ports.
func witnessProcAttr(credential *syscall.Credential, orphanKill bool) *syscall.SysProcAttr {
	attr := &syscall.SysProcAttr{Setpgid: true, Credential: credential}
	if orphanKill {
		attr.Pdeathsig = syscall.SIGKILL
	}
	return attr
}
