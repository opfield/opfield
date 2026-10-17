package sysmetrics

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// sshHostKeyGlob is where OpenSSH keeps the public halves of the host keys
// (world-readable, so a daemon running as any user can read them).
var sshHostKeyGlob = "/etc/ssh/ssh_host_*_key.pub"

// SSHHostKeyFingerprints returns the SHA256 fingerprints of the host's SSH
// host keys in the form ssh-keygen -l prints and SSH clients pin
// ("SHA256:" + unpadded base64 of the SHA-256 of the key blob). Opfield
// matches an SSH connector's pinned host key against them, so an agent
// cannot reach an enrolled node over SSH through an address the node does not
// report. A host without OpenSSH host keys returns none.
func SSHHostKeyFingerprints() []string {
	paths, err := filepath.Glob(sshHostKeyGlob)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var fingerprints []string
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		fingerprint := sshPublicKeyFingerprint(string(data))
		if fingerprint == "" || seen[fingerprint] {
			continue
		}
		seen[fingerprint] = true
		fingerprints = append(fingerprints, fingerprint)
	}
	sort.Strings(fingerprints)
	return fingerprints
}

// sshPublicKeyFingerprint fingerprints one authorized_keys-format line
// ("<type> <base64 blob> [comment]"); an unreadable line gives "".
func sshPublicKeyFingerprint(line string) string {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return ""
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) == 0 {
		return ""
	}
	sum := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}
