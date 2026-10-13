package peer

import (
	"context"
	"fmt"
	"strings"

	"github.com/opfield/opfield/relay/internal/identity"
	"google.golang.org/grpc/credentials"
	grpcpeer "google.golang.org/grpc/peer"
)

type Identity struct {
	SubjectID              string
	CertificateSerial      string
	CertificateFingerprint string
}

func FromContext(ctx context.Context) (Identity, bool) {
	p, ok := grpcpeer.FromContext(ctx)
	if !ok {
		return Identity{}, false
	}
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.VerifiedChains) == 0 || len(tlsInfo.State.PeerCertificates) == 0 {
		return Identity{}, false
	}
	certificate := tlsInfo.State.PeerCertificates[0]
	if certificate.Subject.CommonName == "" {
		return Identity{}, false
	}
	return Identity{
		SubjectID:              certificate.Subject.CommonName,
		CertificateSerial:      strings.ToLower(certificate.SerialNumber.Text(16)),
		CertificateFingerprint: identity.Fingerprint(certificate.Raw),
	}, true
}

func Require(ctx context.Context) (Identity, error) {
	value, ok := FromContext(ctx)
	if !ok {
		return Identity{}, fmt.Errorf("verified client certificate required")
	}
	return value, nil
}
