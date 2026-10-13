package nginx

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

// DeployCert writes cert, key, and optional chain to the cert directory.
func DeployCert(certsDir, certID string, certPem, keyPem, chainPem []byte) error {
	dir := filepath.Join(certsDir, certID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create cert dir: %w", err)
	}

	if err := WriteAtomic(filepath.Join(dir, "fullchain.pem"), fullchainOf(certPem, chainPem)); err != nil {
		return fmt.Errorf("write cert: %w", err)
	}

	if err := WriteAtomic(filepath.Join(dir, "privkey.pem"), keyPem); err != nil {
		return fmt.Errorf("write key: %w", err)
	}

	// Set restrictive permissions on private key
	if err := os.Chmod(filepath.Join(dir, "privkey.pem"), 0600); err != nil {
		return fmt.Errorf("chmod key: %w", err)
	}

	if len(chainPem) > 0 {
		if err := WriteAtomic(filepath.Join(dir, "chain.pem"), chainPem); err != nil {
			return fmt.Errorf("write chain: %w", err)
		}
	}

	return nil
}

func fullchainOf(certPem, chainPem []byte) []byte {
	if len(chainPem) == 0 {
		return certPem
	}
	fullchainPem := make([]byte, 0, len(certPem)+1+len(chainPem))
	fullchainPem = append(fullchainPem, certPem...)
	if len(certPem) > 0 && certPem[len(certPem)-1] != '\n' {
		fullchainPem = append(fullchainPem, '\n')
	}
	return append(fullchainPem, chainPem...)
}

// CertMatches reports whether DeployCert would leave the files of certID as they are.
func CertMatches(certsDir, certID string, certPem, keyPem, chainPem []byte) bool {
	dir := filepath.Join(certsDir, certID)
	expected := map[string][]byte{"fullchain.pem": fullchainOf(certPem, chainPem), "privkey.pem": keyPem}
	if len(chainPem) > 0 {
		expected["chain.pem"] = chainPem
	}
	for name, content := range expected {
		current, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || !bytes.Equal(current, content) {
			return false
		}
	}
	return true
}

// RemoveCert removes a certificate directory.
func RemoveCert(certsDir, certID string) error {
	return RemoveDir(filepath.Join(certsDir, certID))
}

// CertPointer captures the current version symlink before a TLS bundle is
// activated. Keeping the pointer separate from the immutable version directory
// lets the command handler roll a failed nginx test back without rewriting key
// material.
type CertPointer struct {
	Exists                  bool
	Target                  string
	ReplicaGenerationExists bool
	ReplicaGeneration       string
}

type CertificateSnapshot struct {
	Present     bool
	Version     string
	Fingerprint string
}

// DeployVersionedCert stages a complete certificate/key pair under an
// immutable version directory and atomically switches <certID>/current.
// Existing legacy files remain untouched until a v2 config has been applied.
func DeployVersionedCert(certsDir, certID, version, replicaGeneration string, certPem, keyPem, chainPem []byte) (CertPointer, error) {
	previous, err := CurrentCertPointer(certsDir, certID)
	if err != nil {
		return CertPointer{}, err
	}

	root := filepath.Join(certsDir, certID)
	versionsDir := filepath.Join(root, "versions")
	versionDir := filepath.Join(versionsDir, version)
	if _, err := os.Stat(versionDir); err == nil {
		if err := switchCurrentPointer(root, version); err != nil {
			return CertPointer{}, err
		}
		if err := writeReplicaGeneration(root, replicaGeneration); err != nil {
			_ = RestoreCertPointer(certsDir, certID, previous)
			return CertPointer{}, err
		}
		return previous, nil
	} else if !os.IsNotExist(err) {
		return CertPointer{}, fmt.Errorf("stat certificate version: %w", err)
	}

	if err := os.MkdirAll(versionsDir, 0755); err != nil {
		return CertPointer{}, fmt.Errorf("create versions dir: %w", err)
	}
	stage, err := os.MkdirTemp(root, ".certificate-stage-")
	if err != nil {
		return CertPointer{}, fmt.Errorf("create certificate stage: %w", err)
	}
	defer os.RemoveAll(stage)

	if err := WriteAtomic(filepath.Join(stage, "fullchain.pem"), fullchainOf(certPem, chainPem)); err != nil {
		return CertPointer{}, fmt.Errorf("write staged certificate: %w", err)
	}
	if err := WriteAtomic(filepath.Join(stage, "privkey.pem"), keyPem); err != nil {
		return CertPointer{}, fmt.Errorf("write staged key: %w", err)
	}
	if err := os.Chmod(filepath.Join(stage, "privkey.pem"), 0600); err != nil {
		return CertPointer{}, fmt.Errorf("chmod staged key: %w", err)
	}
	if len(chainPem) > 0 {
		if err := WriteAtomic(filepath.Join(stage, "chain.pem"), chainPem); err != nil {
			return CertPointer{}, fmt.Errorf("write staged chain: %w", err)
		}
	}
	if err := WriteAtomic(filepath.Join(stage, naming.File(certVersionFile)), []byte(version)); err != nil {
		return CertPointer{}, fmt.Errorf("write certificate version: %w", err)
	}

	if err := os.Rename(stage, versionDir); err != nil {
		if !os.IsExist(err) {
			return CertPointer{}, fmt.Errorf("activate certificate version: %w", err)
		}
	}
	if err := switchCurrentPointer(root, version); err != nil {
		return CertPointer{}, err
	}
	if err := writeReplicaGeneration(root, replicaGeneration); err != nil {
		_ = RestoreCertPointer(certsDir, certID, previous)
		return CertPointer{}, err
	}
	return previous, nil
}

// CertVersionActive reports whether certID already serves the staged version: its current pointer names that
// version and the version's certificate is in place.
func CertVersionActive(certsDir, certID, version string) bool {
	root := filepath.Join(certsDir, certID)
	target, err := os.Readlink(filepath.Join(root, "current"))
	if err != nil || target != filepath.Join("versions", version) {
		return false
	}
	info, err := os.Stat(filepath.Join(root, "versions", version, "fullchain.pem"))
	return err == nil && info.Mode().IsRegular()
}

func CurrentCertPointer(certsDir, certID string) (CertPointer, error) {
	root := filepath.Join(certsDir, certID)
	pointer := CertPointer{}
	target, err := os.Readlink(filepath.Join(root, "current"))
	if err == nil {
		pointer.Exists = true
		pointer.Target = target
	} else if !os.IsNotExist(err) {
		return CertPointer{}, fmt.Errorf("read current certificate pointer: %w", err)
	}
	generation, err := readCertMeta(root, replicaGenerationFile)
	if err == nil {
		pointer.ReplicaGenerationExists = true
		pointer.ReplicaGeneration = string(generation)
	} else if !os.IsNotExist(err) {
		return CertPointer{}, fmt.Errorf("read certificate replica generation: %w", err)
	}
	return pointer, nil
}

func RestoreCertPointer(certsDir, certID string, pointer CertPointer) error {
	root := filepath.Join(certsDir, certID)
	current := filepath.Join(root, "current")
	if !pointer.Exists {
		if err := os.Remove(current); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove current certificate pointer: %w", err)
		}
	} else if err := switchCurrentPointerTarget(root, pointer.Target); err != nil {
		return err
	}
	if !pointer.ReplicaGenerationExists {
		for _, name := range certMetaNames(replicaGenerationFile) {
			if err := os.Remove(filepath.Join(root, name)); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("remove certificate replica generation: %w", err)
			}
		}
		return nil
	}
	if err := writeReplicaGeneration(root, pointer.ReplicaGeneration); err != nil {
		return fmt.Errorf("restore certificate replica generation: %w", err)
	}
	return nil
}

func writeReplicaGeneration(root, generation string) error {
	name := naming.File(replicaGenerationFile)
	if err := WriteAtomic(filepath.Join(root, name), []byte(generation)); err != nil {
		return fmt.Errorf("write certificate replica generation: %w", err)
	}
	// The other name would be read first by a daemon of the other scheme.
	for _, other := range certMetaNames(replicaGenerationFile) {
		if other != name {
			_ = os.Remove(filepath.Join(root, other))
		}
	}
	return nil
}

// Metadata files the daemon keeps next to a certificate.
const (
	certVersionFile       = ".opfield-version"
	replicaGenerationFile = ".opfield-replica-generation"
)

// certMetaNames are the names of a metadata file: the one of the names in effect first, then the other.
// legacy-name: .gateway-version and .gateway-replica-generation of certificates written before 2.12.1 — remove once
// every node reports none
func certMetaNames(name string) []string {
	current := naming.File(name)
	if current == name {
		return []string{name, naming.LegacyFile(name)}
	}
	return []string{current, name}
}

// readCertMeta reads a metadata file under either name.
func readCertMeta(dir, name string) ([]byte, error) {
	var firstErr error
	for _, candidate := range certMetaNames(name) {
		content, err := os.ReadFile(filepath.Join(dir, candidate))
		if err == nil {
			return content, nil
		}
		if firstErr == nil || !os.IsNotExist(err) {
			firstErr = err
		}
	}
	return nil, firstErr
}

func switchCurrentPointer(root, version string) error {
	return switchCurrentPointerTarget(root, filepath.Join("versions", version))
}

func switchCurrentPointerTarget(root, target string) error {
	if err := os.MkdirAll(root, 0755); err != nil {
		return fmt.Errorf("create certificate root: %w", err)
	}
	tmp := filepath.Join(root, ".current.tmp")
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("clear temporary certificate pointer: %w", err)
	}
	if err := os.Symlink(target, tmp); err != nil {
		return fmt.Errorf("create temporary certificate pointer: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(root, "current")); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("switch certificate pointer: %w", err)
	}
	return nil
}

// InspectCertificate returns a non-secret fingerprint of the complete current
// pair. The key itself never leaves this package through the inventory path.
func InspectCertificate(certsDir, certID string) (CertificateSnapshot, error) {
	root := filepath.Join(certsDir, certID)
	base := root
	if pointer, err := CurrentCertPointer(certsDir, certID); err != nil {
		return CertificateSnapshot{}, err
	} else if pointer.Exists {
		base = filepath.Join(root, "current")
	}
	certPem, err := os.ReadFile(filepath.Join(base, "fullchain.pem"))
	if os.IsNotExist(err) {
		return CertificateSnapshot{Present: false}, nil
	}
	if err != nil {
		return CertificateSnapshot{}, fmt.Errorf("read certificate: %w", err)
	}
	keyPem, err := os.ReadFile(filepath.Join(base, "privkey.pem"))
	if err != nil {
		return CertificateSnapshot{}, fmt.Errorf("read certificate key: %w", err)
	}
	chainPem, err := os.ReadFile(filepath.Join(base, "chain.pem"))
	if err != nil && !os.IsNotExist(err) {
		return CertificateSnapshot{}, fmt.Errorf("read certificate chain: %w", err)
	}
	versionRaw, err := readCertMeta(base, certVersionFile)
	if err != nil && !os.IsNotExist(err) {
		return CertificateSnapshot{}, fmt.Errorf("read certificate version: %w", err)
	}
	hash := sha256.New()
	hash.Write(certPem)
	hash.Write([]byte{0})
	hash.Write(keyPem)
	hash.Write([]byte{0})
	hash.Write(chainPem)
	return CertificateSnapshot{
		Present:     true,
		Version:     string(versionRaw),
		Fingerprint: hex.EncodeToString(hash.Sum(nil)),
	}, nil
}

// ReadCertificateForExport supports the one-time legacy migration command.
// It accepts only a cert ID the handler already validated and never lists a
// directory or otherwise exposes arbitrary daemon files.
func ReadCertificateForExport(certsDir, certID string) (certPem, keyPem, chainPem []byte, err error) {
	root := filepath.Join(certsDir, certID)
	base := root
	if pointer, pointerErr := CurrentCertPointer(certsDir, certID); pointerErr != nil {
		return nil, nil, nil, pointerErr
	} else if pointer.Exists {
		base = filepath.Join(root, "current")
	}
	certPem, err = os.ReadFile(filepath.Join(base, "fullchain.pem"))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read certificate: %w", err)
	}
	keyPem, err = os.ReadFile(filepath.Join(base, "privkey.pem"))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read certificate key: %w", err)
	}
	chainPem, err = os.ReadFile(filepath.Join(base, "chain.pem"))
	if os.IsNotExist(err) {
		return certPem, keyPem, nil, nil
	}
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read certificate chain: %w", err)
	}
	// Legacy DeployCert wrote fullchain.pem as leaf + chain and retained a
	// separate chain.pem. Export the original leaf when this known layout is
	// present so Opfield does not append the chain twice when it builds v2.
	if leaf := bytes.TrimSuffix(certPem, chainPem); len(leaf) != len(certPem) {
		certPem = bytes.TrimSuffix(leaf, []byte("\n"))
	}
	return certPem, keyPem, chainPem, nil
}

func RemoveCertificateReplica(certsDir, certID, expectedVersion, expectedReplicaGeneration string) error {
	pointer, err := CurrentCertPointer(certsDir, certID)
	if err != nil {
		return err
	}
	if expectedVersion != "" {
		snapshot, err := InspectCertificate(certsDir, certID)
		if err != nil {
			return err
		}
		if snapshot.Present && snapshot.Version != expectedVersion {
			return fmt.Errorf("certificate replica generation changed")
		}
	}
	if expectedReplicaGeneration != "" && (!pointer.ReplicaGenerationExists || pointer.ReplicaGeneration != expectedReplicaGeneration) {
		return fmt.Errorf("certificate replica generation changed")
	}
	return RemoveCert(certsDir, certID)
}
