package enrollment

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

// Enroll performs the initial enrollment with a PSK token.
// The enrollment token is only sent after the Gateway TLS leaf certificate
// matches the expected SHA-256 fingerprint.
func Enroll(address, token, expectedGatewayCertSHA256, hostname, nginxVersion, osInfo, daemonVersion, daemonType, hostIdentityID string) (*pb.EnrollResponse, error) {
	expectedFingerprint, err := normalizeExpectedFingerprint(expectedGatewayCertSHA256)
	if err != nil {
		return nil, err
	}

	tlsCfg := &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			return verifyGatewayFingerprint(expectedFingerprint, state.PeerCertificates)
		},
	}

	conn, err := grpc.NewClient(address,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
	)
	if err != nil {
		return nil, fmt.Errorf("dial Opfield: %w", err)
	}
	defer conn.Close()

	client := pb.NewNodeEnrollmentClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := client.Enroll(ctx, &pb.EnrollRequest{
		Token:          token,
		Hostname:       hostname,
		NginxVersion:   nginxVersion,
		OsInfo:         osInfo,
		DaemonVersion:  daemonVersion,
		DaemonType:     daemonType,
		HostIdentityId: hostIdentityID,
	})
	if err != nil {
		return nil, fmt.Errorf("enrollment failed: %w", err)
	}

	return resp, nil
}

func normalizeExpectedFingerprint(fingerprint string) (string, error) {
	fingerprint = strings.ToLower(strings.TrimSpace(fingerprint))
	if fingerprint == "" {
		return "", fmt.Errorf("gateway.cert_sha256 is required for initial enrollment")
	}
	if !strings.HasPrefix(fingerprint, "sha256:") {
		return "", fmt.Errorf("gateway.cert_sha256 must use sha256:<64-hex> format")
	}

	hexPart := strings.TrimPrefix(fingerprint, "sha256:")
	if len(hexPart) != 64 {
		return "", fmt.Errorf("gateway.cert_sha256 must contain a 64-character SHA-256 hex digest")
	}
	if _, err := hex.DecodeString(hexPart); err != nil {
		return "", fmt.Errorf("gateway.cert_sha256 must contain valid hex: %w", err)
	}

	return "sha256:" + hexPart, nil
}

func verifyGatewayFingerprint(expectedFingerprint string, peerCertificates []*x509.Certificate) error {
	if len(peerCertificates) == 0 {
		return fmt.Errorf("Opfield did not present a TLS certificate")
	}

	sum := sha256.Sum256(peerCertificates[0].Raw)
	actualFingerprint := "sha256:" + hex.EncodeToString(sum[:])
	if actualFingerprint != expectedFingerprint {
		return fmt.Errorf("Opfield certificate fingerprint mismatch: expected %s, got %s", expectedFingerprint, actualFingerprint)
	}

	return nil
}
