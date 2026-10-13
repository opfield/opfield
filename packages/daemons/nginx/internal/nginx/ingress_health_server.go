package nginx

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/opfield/opfield/nginx-daemon/internal/naming"
)

const (
	ingressHealthServerFilename = "00-opfield-ingress-health.conf"
	ingressHealthCertDirName    = "opfield-ingress-health"
	// legacy-name: certificate directory of the reserved server written before 2.12.1 — remove once every node reports none
	legacyIngressHealthCertDirName = "gateway-ingress-health"
	// The reserved server's self-signed certificate lives a year and is replaced 30 days before it expires, while
	// the daemon runs (checked at start and every 12 hours).
	ingressHealthCertLifetime    = 365 * 24 * time.Hour
	ingressHealthCertRenewBefore = 30 * 24 * time.Hour
)

// IngressHealthServerPath is the daemon-managed server block that answers the reserved hostname.
func IngressHealthServerPath(configDir string) string {
	return filepath.Join(configDir, naming.File(ingressHealthServerFilename))
}

// LegacyIngressHealthCertDir is the certificate directory of the reserved server a daemon before 2.12.1 kept.
func LegacyIngressHealthCertDir(certsDir string) string {
	return filepath.Join(certsDir, legacyIngressHealthCertDirName)
}

func ingressHealthCertPaths(certsDir string) (cert, key string) {
	dir := filepath.Join(certsDir, ingressHealthCertDirName)
	return filepath.Join(dir, "fullchain.pem"), filepath.Join(dir, "privkey.pem")
}

// IngressHealthServerConfig answers the reserved hostname on :80 and :443 with only the health locations. Probes that
// address the node by IP use this hostname (SNI and Host); the TLS catch-all rejects every other unknown name.
func IngressHealthServerConfig(certsDir string) string {
	cert, key := ingressHealthCertPaths(certsDir)
	return naming.Render(fmt.Sprintf(`# Managed by Opfield: ingress health server (auto-generated).
# Answers %s and %s for probes that address this node by IP address.
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name %s;
    ssl_certificate %s;
    ssl_certificate_key %s;

%s
    location / {
        return 404;
    }
}
`, IngressHealthPath, LegacyIngressHealthPath, IngressHealthHostname, cert, key, IngressHealthLocation()))
}

// EnsureIngressHealthCertificate keeps a valid self-signed certificate for the reserved hostname: it is created when
// missing, unreadable or for another name, and replaced when fewer than 30 days are left. It names the reserved
// hostname under both schemes, so moving the node to the Opfield names needs no new certificate. Returns true when
// written.
func EnsureIngressHealthCertificate(certsDir string, now time.Time) (bool, error) {
	certPath, keyPath := ingressHealthCertPaths(certsDir)
	if current, err := os.ReadFile(certPath); err == nil {
		if block, _ := pem.Decode(current); block != nil {
			if parsed, err := x509.ParseCertificate(block.Bytes); err == nil &&
				parsed.Subject.CommonName == IngressHealthHostname &&
				slices.Contains(parsed.DNSNames, naming.ToLegacy(IngressHealthHostname)) &&
				now.Add(ingressHealthCertRenewBefore).Before(parsed.NotAfter) {
				if _, err := os.Stat(keyPath); err == nil {
					return false, nil
				}
			}
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return false, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 126))
	if err != nil {
		return false, err
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: IngressHealthHostname},
		DNSNames:              []string{IngressHealthHostname, naming.ToLegacy(IngressHealthHostname)},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(ingressHealthCertLifetime),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return false, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0o755); err != nil {
		return false, err
	}
	if err := writePrivateAtomic(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})); err != nil {
		return false, err
	}
	if err := WriteAtomic(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})); err != nil {
		return false, err
	}
	return true, nil
}

// EnsureIngressHealthServer writes the reserved-hostname server when it differs from the managed content.
func EnsureIngressHealthServer(configDir, certsDir string) (bool, error) {
	path := IngressHealthServerPath(configDir)
	desired := []byte(IngressHealthServerConfig(certsDir))
	existing, err := ReadFile(path)
	if err != nil {
		return false, err
	}
	if bytes.Equal(existing, desired) {
		return false, nil
	}
	return true, WriteAtomic(path, desired)
}

// defaultHTTPServerCandidates are the installer-written HTTP catch-all files of a managed-mode node.
func defaultHTTPServerCandidates(globalConfig string) []string {
	base := filepath.Dir(globalConfig)
	if globalConfig == "" {
		base = "/etc/nginx"
	}
	return []string{filepath.Join(base, "conf.d", "default.conf"), filepath.Join(base, "http.d", "default.conf")}
}

// isInstallerDefaultHTTPServer recognises the default server the installer writes in managed mode; files an
// operator owns (integrate mode) never match and are left alone.
func isInstallerDefaultHTTPServer(content string) bool {
	return strings.Contains(content, "listen 80 default_server;") &&
		strings.Contains(content, "server_name _;") &&
		strings.Contains(content, "location /.well-known/acme-challenge/ {") &&
		strings.Contains(content, "location /health {")
}

// DefaultHTTPServerHealthPatch returns the installer default server file (managed mode) with the reserved health
// locations it lacks added right after `server_name _;`, or ("", nil, false) when no such file needs the patch. The
// caller validates the result with nginx -t and restores the original on failure.
func DefaultHTTPServerHealthPatch(globalConfig string) (path string, original []byte, patched []byte, ok bool) {
	for _, candidate := range defaultHTTPServerCandidates(globalConfig) {
		content, err := ReadFile(candidate)
		if err != nil || content == nil {
			continue
		}
		text := string(content)
		if !isInstallerDefaultHTTPServer(text) {
			continue
		}
		missing := missingIngressHealthLocations(text)
		if missing == "" {
			continue
		}
		marker := "server_name _;\n"
		index := strings.Index(text, marker)
		if index < 0 {
			continue
		}
		index += len(marker)
		next := text[:index] + "\n" + missing + text[index:]
		return candidate, content, []byte(next), true
	}
	return "", nil, nil, false
}

// writePrivateAtomic writes a private key with mode 0600 from the first byte on, then renames it into place.
func writePrivateAtomic(path string, content []byte) error {
	tmpPath := path + ".tmp"
	_ = os.Remove(tmpPath)
	file, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create temp key file: %w", err)
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp key file: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("fsync temp key file: %w", err)
	}
	if err := file.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename temp key: %w", err)
	}
	return nil
}

// InstallerDefaultHTTPServers returns the installer-written HTTP default server files of a managed-mode node (the
// files DefaultHTTPServerHealthPatch patches).
func InstallerDefaultHTTPServers(globalConfig string) []string {
	var found []string
	for _, candidate := range defaultHTTPServerCandidates(globalConfig) {
		if content, err := ReadFile(candidate); err == nil && content != nil && isInstallerDefaultHTTPServer(string(content)) {
			found = append(found, candidate)
		}
	}
	return found
}
