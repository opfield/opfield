package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/netaccept"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

const (
	storageConnectorListenAddress = ":9000"
	storageBindingOwnerKind       = "managed_storage_binding"
	// storageRelayFailureLogInterval spaces the lines of one relay failure: S3 clients retry a refused connection
	// at once, and each retry would log again.
	storageRelayFailureLogInterval = time.Minute
)

var storageConnectorBindingIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type storageConnectorConfig struct {
	BindingID  string
	SocketPath string
	Listen     string
	CAPEM      string
	ServerName string
}

func storageConnectorConfigFromEnv(getenv func(string) string) (storageConnectorConfig, bool, error) {
	bindingID := connectorSetting(getenv, connectorBindingEnv)
	if bindingID == "" {
		return storageConnectorConfig{}, false, nil
	}
	config := storageConnectorConfig{
		BindingID:  bindingID,
		SocketPath: connectorSetting(getenv, connectorSocketEnv),
		Listen:     connectorSetting(getenv, connectorListenEnv),
		CAPEM:      connectorSetting(getenv, connectorCAPEMEnv),
		ServerName: connectorSetting(getenv, connectorServerEnv),
	}
	if !storageConnectorBindingIDPattern.MatchString(config.BindingID) {
		return config, true, errors.New(envPrefix + connectorBindingEnv + " must be a UUID")
	}
	if config.SocketPath == "" || !filepath.IsAbs(config.SocketPath) {
		return config, true, errors.New(envPrefix + connectorSocketEnv + " must be an absolute path")
	}
	if config.Listen != storageConnectorListenAddress {
		return config, true, fmt.Errorf("%s must be %s", envPrefix+connectorListenEnv, storageConnectorListenAddress)
	}
	if (config.CAPEM == "") != (config.ServerName == "") {
		return config, true, errors.New(envPrefix + connectorCAPEMEnv + " and " + envPrefix + connectorServerEnv + " must be set together")
	}
	return config, true, nil
}

func storageConnectorTLSConfig(config storageConnectorConfig) (*tls.Config, error) {
	tlsConfig, err := relayTLSConfig(config.CAPEM, config.ServerName)
	if err != nil {
		return nil, errors.New(envPrefix + connectorCAPEMEnv + " is not a valid certificate")
	}
	return tlsConfig, nil
}

// relayTLSConfig is the TLS client the connector speaks over a relayed stream to a server whose certificate caPEM
// signed (nil without caPEM).
func relayTLSConfig(caPEM, serverName string) (*tls.Config, error) {
	if caPEM == "" {
		return nil, nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(caPEM)) {
		return nil, errors.New("the TLS CA is not a valid certificate")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: serverName}, nil
}

func runStorageConnector(ctx context.Context, config storageConnectorConfig) error {
	tlsConfig, err := storageConnectorTLSConfig(config)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", config.Listen)
	if err != nil {
		return fmt.Errorf("listen storage connector: %w", err)
	}
	defer listener.Close()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	// A transient accept error (out of file descriptors) backs off and retries: exiting on it cut every storage
	// session of the binding (B-22). Only the stop closes the listener.
	netaccept.Serve(listener, ctx.Done(), func(connection net.Conn) {
		proxyStorageConnectorConnection(ctx, connection, config, tlsConfig)
	})
	return nil
}

func proxyStorageConnectorConnection(ctx context.Context, local net.Conn, config storageConnectorConfig, tlsConfig *tls.Config) {
	defer local.Close()
	remote, err := openStorageRelay(ctx, config)
	if err != nil {
		if ctx.Err() == nil {
			storageRelayFailures.record(err)
		}
		return
	}
	defer remote.Close()
	remote, err = clientTLS(ctx, remote, tlsConfig, false)
	if err != nil {
		return
	}
	bridge(local, remote)
}

func openStorageRelay(ctx context.Context, config storageConnectorConfig) (net.Conn, error) {
	return openRelayStream(ctx, config.SocketPath, storageBindingOwnerKind, config.BindingID)
}

// openRelayStream asks the daemon at socketPath for the relayed stream of one link (ownerKind and bindingID) and
// returns it once the daemon answered that the stream is open.
func openRelayStream(ctx context.Context, socketPath, ownerKind, bindingID string) (net.Conn, error) {
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("connect relay socket: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	} else {
		_ = connection.SetDeadline(time.Now().Add(targetDialTimeout))
	}
	request := securelink.RelayRequest{Version: securelink.RelayProtocolVersion, OwnerKind: ownerKind, BindingID: bindingID}
	if err := securelink.WriteJSON(connection, request); err != nil {
		_ = connection.Close()
		return nil, err
	}
	var response securelink.RelayResponse
	if err := securelink.ReadJSON(connection, &response); err != nil {
		_ = connection.Close()
		return nil, err
	}
	if response.Version != securelink.RelayProtocolVersion {
		_ = connection.Close()
		return nil, errors.New("unsupported relay protocol version")
	}
	if response.Error != "" {
		_ = connection.Close()
		return nil, errors.New(response.Error)
	}
	_ = connection.SetDeadline(time.Time{})
	return connection, nil
}

func storageConnectorEnvironment() func(string) string { return os.Getenv }

// storageRelayFailureLog logs why the daemon did not open the relay for a connection (the link's session capacity
// reached, the relay route unavailable): the first time a reason occurs, then at most once per
// storageRelayFailureLogInterval with the number of connections it closed in between.
type storageRelayFailureLog struct {
	now  func() time.Time
	logf func(format string, args ...any)
	// subject names the connections in the lines ("storage connection" when empty).
	subject string
	mu      sync.Mutex
	entries map[string]*storageRelayFailureEntry
}

type storageRelayFailureEntry struct {
	logged     time.Time
	suppressed int
}

var storageRelayFailures = &storageRelayFailureLog{now: time.Now, logf: log.Printf}

func (l *storageRelayFailureLog) record(err error) {
	reason := err.Error()
	now := l.now()
	l.mu.Lock()
	entry := l.entries[reason]
	if entry != nil && now.Sub(entry.logged) < storageRelayFailureLogInterval {
		entry.suppressed++
		l.mu.Unlock()
		return
	}
	if entry == nil {
		if l.entries == nil {
			l.entries = map[string]*storageRelayFailureEntry{}
		}
		for staleReason, stale := range l.entries {
			if now.Sub(stale.logged) >= 10*storageRelayFailureLogInterval {
				delete(l.entries, staleReason)
			}
		}
		entry = &storageRelayFailureEntry{}
		l.entries[reason] = entry
	}
	suppressed := entry.suppressed
	entry.logged, entry.suppressed = now, 0
	l.mu.Unlock()
	subject := l.subject
	if subject == "" {
		subject = "storage connection"
	}
	if suppressed > 0 {
		l.logf("%s closed, relay not opened: %s (%d more since the last line)", subject, reason, suppressed)
		return
	}
	l.logf("%s closed, relay not opened: %s", subject, reason)
}
