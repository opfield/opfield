//go:build !linux

package supervisor

import "syscall"

// witnessProcAttr: witnesses run on Linux only (witnessHosting reports
// disabled elsewhere); this keeps the package building for tests.
func witnessProcAttr(credential *syscall.Credential, _ bool) *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Credential: credential}
}
