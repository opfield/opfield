package sysmetrics

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The fingerprint matches what ssh-keygen -lf prints and what Opfield pins
// for an SSH connector (external-ssh-transport.ts fingerprint).
const fixtureHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAeoqiQTiF+oQy2zio4lXdB7giV/rYcQxJal3rYLcj+ test\n"
const fixtureHostKeyFingerprint = "SHA256:UNOQE+Vd9DdwYPA6TCygH6JCI2905u/kQkm7EjZj+tE"

func TestSSHHostKeyFingerprintsMatchSSHKeygen(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ssh_host_ed25519_key.pub"), []byte(fixtureHostKey), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ssh_host_rsa_key.pub"), []byte("not a key\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	previous := sshHostKeyGlob
	sshHostKeyGlob = filepath.Join(dir, "ssh_host_*_key.pub")
	t.Cleanup(func() { sshHostKeyGlob = previous })

	if got := SSHHostKeyFingerprints(); !reflect.DeepEqual(got, []string{fixtureHostKeyFingerprint}) {
		t.Fatalf("fingerprints = %v, want [%s]", got, fixtureHostKeyFingerprint)
	}
}

func TestSSHHostKeyFingerprintsWithoutOpenSSH(t *testing.T) {
	previous := sshHostKeyGlob
	sshHostKeyGlob = filepath.Join(t.TempDir(), "ssh_host_*_key.pub")
	t.Cleanup(func() { sshHostKeyGlob = previous })
	if got := SSHHostKeyFingerprints(); len(got) != 0 {
		t.Fatalf("fingerprints = %v, want none", got)
	}
}
