package docker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"

	mobyclient "github.com/moby/moby/client"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// Relay clients of a managed database endpoint (database links from app
// containers, the Gateway's own database tools) reach PostgreSQL as plain
// protocol bytes: the relay is the transport security for that leg, and
// application URIs carry no sslmode. A TLS-enabled managed PostgreSQL accepts
// only hostssl connections, so for a client that does not negotiate TLS itself
// the endpoint daemon speaks TLS to PostgreSQL on its behalf. A client that
// asks for TLS (SSLRequest) keeps its own end-to-end TLS session with
// PostgreSQL, exactly as before.
const (
	postgresCancelRequestCode = 80877102
	postgresGSSENCRequestCode = 80877104
	// A StartupMessage is at least 9 bytes; only SSLRequest, GSSENCRequest
	// (and unknown future negotiation codes) are exactly 8.
	postgresNegotiationPacketLength = 8
	// GSSENCRequest may be followed by SSLRequest; nothing legitimate sends more.
	managedPostgresLinkMaxNegotiations = 2
)

var (
	// managedPostgresLinkClientTimeout bounds how long a relay client may take
	// to send its first PostgreSQL packet.
	managedPostgresLinkClientTimeout = 30 * time.Second
	// managedPostgresLinkServerTimeout bounds the SSLRequest answer and the TLS
	// handshake with PostgreSQL, so a stuck engine never holds a relay stream.
	managedPostgresLinkServerTimeout = 10 * time.Second
)

// managedPostgresLinkIdentity is the common name the Gateway Database CA
// issues a managed database leaf with (the Gateway checks the same identity).
func managedPostgresLinkIdentity(managedDatabaseID string) string {
	return "managed-db-" + managedDatabaseID
}

func managedDatabaseLinkNeedsPostgresTLS(record managedDatabaseRecord) bool {
	return record.Type == "postgres" && record.TLSEnabled
}

func (m *managedDatabaseManager) dial(ctx context.Context, managedDatabaseID string) (net.Conn, error) {
	connection, _, err := m.dialRecord(ctx, managedDatabaseID)
	return connection, err
}

// prepareLinkConnection readies a relay client's connection of the
// managed_database endpoint: for a TLS-enabled PostgreSQL it negotiates the
// opening of the client's session (see negotiateManagedPostgresLink); every
// other engine is used as dialed. stream is the raw tunnel or, for a
// resumable stream, its session.
func (m *managedDatabaseManager) prepareLinkConnection(ctx context.Context, connection net.Conn, record managedDatabaseRecord, stream relayFrameStream, cancel context.CancelFunc) (net.Conn, error) {
	if !managedDatabaseLinkNeedsPostgresTLS(record) {
		return connection, nil
	}
	caPEM, err := os.ReadFile(filepath.Join(m.tlsDirectory(record), "ca.pem"))
	if err != nil {
		_ = connection.Close()
		return nil, errors.New("managed PostgreSQL link: database CA certificate is unavailable")
	}
	config, err := managedPostgresLinkTLSConfig(caPEM, managedPostgresLinkIdentity(record.ID))
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	linked, err := negotiateManagedPostgresLink(ctx, connection, stream, cancel, config)
	if err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("managed PostgreSQL link: %w", err)
	}
	return linked, nil
}

func (m *managedDatabaseManager) dialRecord(ctx context.Context, managedDatabaseID string) (net.Conn, managedDatabaseRecord, error) {
	if !managedDatabaseIDPattern.MatchString(managedDatabaseID) {
		return nil, managedDatabaseRecord{}, errors.New("invalid managed database id")
	}
	// Without the manager lock: commands hold it for their whole run (a
	// runtime stats sample takes about two seconds, lifecycle operations much
	// longer), and every relay connection to every database on the node would
	// wait behind them. Records are replaced atomically, and the container is
	// verified live below.
	record, err := m.loadRecord(managedDatabaseID)
	if err != nil || record.ID != managedDatabaseID {
		return nil, managedDatabaseRecord{}, errors.New("managed database record not found")
	}
	// dockerd names the container's address; while it does not answer, the
	// last address it named is used (B-26).
	key := record.ContainerID + "\x00" + record.NetworkName + "\x00" + record.ID + "\x00" + record.Type
	address, err := m.dialTargets.get(ctx, key, func(ctx context.Context) (string, error) {
		inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
		if err != nil && !isNotFoundErr(err) {
			return "", dockerUnansweredError{message: "managed database container is unavailable", cause: err}
		}
		if err != nil || inspect.Container.Config == nil || inspect.Container.State == nil || !inspect.Container.State.Running {
			return "", errors.New("managed database container is unavailable")
		}
		labels := inspect.Container.Config.Labels
		if labels[managedDatabaseLabel] != record.ID || labels[managedDatabaseTypeTag] != record.Type || inspect.Container.NetworkSettings == nil {
			return "", errors.New("managed database container identity is invalid")
		}
		endpoint := inspect.Container.NetworkSettings.Networks[record.NetworkName]
		if endpoint == nil || !endpoint.IPAddress.IsValid() {
			return "", errors.New("managed database private network is unavailable")
		}
		return endpoint.IPAddress.String(), nil
	})
	if err != nil {
		return nil, managedDatabaseRecord{}, err
	}
	port, err := managedDatabaseEnginePort(record.Type)
	if err != nil {
		return nil, managedDatabaseRecord{}, err
	}
	connection, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(address, port))
	if err != nil {
		return nil, managedDatabaseRecord{}, err
	}
	return connection, record, nil
}

// negotiateManagedPostgresLink reads the relay client's first PostgreSQL
// packet and returns the connection the relay bridge should use:
//
//   - SSLRequest: forwarded unchanged; the client negotiates TLS end to end
//     with PostgreSQL (the Gateway's verified database tools, sslmode=require).
//   - GSSENCRequest: answered 'N' here; the client's next packet is read.
//   - StartupMessage, CancelRequest or anything else: the daemon opens TLS to
//     PostgreSQL itself and forwards the packet through it.
//
// Only a packet whose length field is 8 can be a negotiation request, so the
// remaining bytes of any other packet are never waited for. On error the
// caller closes connection; the relay stream is cancelled on client timeout.
func negotiateManagedPostgresLink(ctx context.Context, connection net.Conn, stream relayFrameStream, cancel context.CancelFunc, config *tls.Config) (net.Conn, error) {
	reader := &relayStreamReader{stream: stream}
	clientTimer := time.AfterFunc(managedPostgresLinkClientTimeout, cancel)
	opening, clientTLS, err := readManagedPostgresLinkOpening(reader, stream)
	if !clientTimer.Stop() {
		return nil, errors.New("relay client sent no PostgreSQL startup packet in time")
	}
	if err != nil {
		return nil, err
	}
	target := connection
	if !clientTLS {
		secured, tlsErr := startManagedPostgresTLS(ctx, connection, config)
		if tlsErr != nil {
			return nil, tlsErr
		}
		target = secured
	}
	_ = target.SetDeadline(time.Now().Add(managedPostgresLinkServerTimeout))
	if err := writeDatabaseTunnelBytes(target, append(opening, reader.pending...)); err != nil {
		return nil, fmt.Errorf("forward PostgreSQL startup packet: %w", err)
	}
	_ = target.SetDeadline(time.Time{})
	return target, nil
}

func readManagedPostgresLinkOpening(reader *relayStreamReader, stream relayFrameStream) ([]byte, bool, error) {
	for negotiations := 0; ; negotiations++ {
		header, err := reader.readFull(4)
		if err != nil {
			return nil, false, err
		}
		if binary.BigEndian.Uint32(header) != postgresNegotiationPacketLength {
			return header, false, nil
		}
		code, err := reader.readFull(4)
		if err != nil {
			return nil, false, err
		}
		packet := append(header, code...)
		switch binary.BigEndian.Uint32(code) {
		case postgresSSLRequestCode:
			return packet, true, nil
		case postgresGSSENCRequestCode:
			if negotiations >= managedPostgresLinkMaxNegotiations {
				return nil, false, errors.New("relay client repeated PostgreSQL encryption negotiation")
			}
			if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte{'N'}}}}); err != nil {
				return nil, false, fmt.Errorf("answer PostgreSQL GSSENCRequest: %w", err)
			}
		default:
			// Unknown 8-byte packet: PostgreSQL decides what it means.
			return packet, false, nil
		}
	}
}

// startManagedPostgresTLS performs the PostgreSQL SSLRequest and a TLS
// handshake verified by config, both bounded by managedPostgresLinkServerTimeout.
func startManagedPostgresTLS(ctx context.Context, connection net.Conn, config *tls.Config) (net.Conn, error) {
	_ = connection.SetDeadline(time.Now().Add(managedPostgresLinkServerTimeout))
	request := make([]byte, postgresNegotiationPacketLength)
	binary.BigEndian.PutUint32(request[0:4], postgresNegotiationPacketLength)
	binary.BigEndian.PutUint32(request[4:8], postgresSSLRequestCode)
	if err := writeDatabaseTunnelBytes(connection, request); err != nil {
		return nil, fmt.Errorf("send PostgreSQL SSLRequest: %w", err)
	}
	answer := make([]byte, 1)
	if _, err := io.ReadFull(connection, answer); err != nil {
		return nil, fmt.Errorf("read PostgreSQL SSLRequest answer: %w", err)
	}
	if answer[0] != 'S' {
		return nil, errors.New("PostgreSQL refused TLS")
	}
	handshakeCtx, stop := context.WithTimeout(ctx, managedPostgresLinkServerTimeout)
	defer stop()
	secured := tls.Client(connection, config)
	if err := secured.HandshakeContext(handshakeCtx); err != nil {
		return nil, fmt.Errorf("PostgreSQL TLS handshake: %w", err)
	}
	return secured, nil
}

// managedPostgresLinkTLSConfig verifies the served certificate against the
// managed database's own CA material and the identity the Gateway issued it.
// The daemon dials the container's private bridge address, which is never a
// certificate name (the leaf carries the node's service addresses), so the
// hostname check is replaced by the chain and common-name check below.
func managedPostgresLinkTLSConfig(caPEM []byte, identity string) (*tls.Config, error) {
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("managed PostgreSQL link: database CA certificate is invalid")
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		// #nosec G402 -- VerifyConnection checks the chain and identity; see above.
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			return verifyManagedPostgresLinkCertificate(state.PeerCertificates, roots, identity)
		},
	}, nil
}

func verifyManagedPostgresLinkCertificate(peers []*x509.Certificate, roots *x509.CertPool, identity string) error {
	if len(peers) == 0 {
		return errors.New("PostgreSQL presented no certificate")
	}
	intermediates := x509.NewCertPool()
	for _, certificate := range peers[1:] {
		intermediates.AddCert(certificate)
	}
	if _, err := peers[0].Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		return fmt.Errorf("PostgreSQL certificate is not issued by the managed database CA: %w", err)
	}
	if peers[0].Subject.CommonName != identity {
		return fmt.Errorf("PostgreSQL certificate was not issued for this managed database (expected %s)", identity)
	}
	return nil
}

// errRelayClientLeftEarly: the relay client ended the tunnel before it sent
// a byte. Its own client went away while the tunnel opened (it gave up
// waiting for a relay to take the connection); nothing failed on this side.
var errRelayClientLeftEarly = errors.New("relay client closed before its PostgreSQL startup packet")

// relayStreamReader reads relay data frames as a byte stream; bytes beyond
// the requested length stay in pending for the caller to forward.
type relayStreamReader struct {
	stream  relayFrameStream
	pending []byte
	// received is set once the client sent any data.
	received bool
}

func (r *relayStreamReader) readFull(n int) ([]byte, error) {
	for len(r.pending) < n {
		frame, err := r.stream.Recv()
		if err != nil {
			return nil, fmt.Errorf("read relay client: %w", err)
		}
		if !r.received && (frame.GetHalfClose() != nil || frame.GetClose() != nil) {
			return nil, errRelayClientLeftEarly
		}
		data := frame.GetData()
		if data == nil || len(data.Data) == 0 || len(data.Data) > databaseTunnelMaxChunkBytes {
			return nil, errors.New("relay client closed before its PostgreSQL startup packet")
		}
		r.received = true
		r.pending = append(r.pending, data.Data...)
	}
	out := append([]byte(nil), r.pending[:n]...)
	r.pending = r.pending[n:]
	return out, nil
}
