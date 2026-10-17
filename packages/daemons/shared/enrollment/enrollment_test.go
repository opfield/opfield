package enrollment

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"strings"
	"testing"
)

var testPeerCert = &x509.Certificate{Raw: []byte("opfield leaf certificate")}

func testFingerprint() string {
	sum := sha256.Sum256(testPeerCert.Raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func TestVerifyOpfieldFingerprintAcceptsValidFingerprint(t *testing.T) {
	if err := verifyOpfieldFingerprint(testFingerprint(), []*x509.Certificate{testPeerCert}); err != nil {
		t.Fatalf("expected fingerprint to verify: %v", err)
	}
}

func TestNormalizeExpectedFingerprintAcceptsUppercase(t *testing.T) {
	upper := strings.ToUpper(testFingerprint())
	normalized, err := normalizeExpectedFingerprint(upper)
	if err != nil {
		t.Fatalf("expected uppercase fingerprint to normalize: %v", err)
	}
	if normalized != testFingerprint() {
		t.Fatalf("unexpected normalized fingerprint: %s", normalized)
	}
}

func TestNormalizeExpectedFingerprintRejectsMissing(t *testing.T) {
	if _, err := normalizeExpectedFingerprint(""); err == nil {
		t.Fatal("expected missing fingerprint to fail")
	}
}

func TestNormalizeExpectedFingerprintRejectsMalformed(t *testing.T) {
	cases := []string{
		"not-a-fingerprint",
		"sha256:abcd",
		"sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
	}

	for _, tc := range cases {
		t.Run(tc, func(t *testing.T) {
			if _, err := normalizeExpectedFingerprint(tc); err == nil {
				t.Fatal("expected malformed fingerprint to fail")
			}
		})
	}
}

func TestVerifyOpfieldFingerprintRejectsEmptyPeerCerts(t *testing.T) {
	if err := verifyOpfieldFingerprint(testFingerprint(), nil); err == nil {
		t.Fatal("expected empty peer certificates to fail")
	}
}

func TestVerifyOpfieldFingerprintRejectsMismatch(t *testing.T) {
	expected := "sha256:" + strings.Repeat("0", 64)
	if err := verifyOpfieldFingerprint(expected, []*x509.Certificate{testPeerCert}); err == nil {
		t.Fatal("expected fingerprint mismatch to fail")
	}
}
