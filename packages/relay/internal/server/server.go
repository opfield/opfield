package server

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/admin"
	"github.com/opfield/opfield/relay/internal/broker"
	"github.com/opfield/opfield/relay/internal/codec"
	"github.com/opfield/opfield/relay/internal/config"
	"github.com/opfield/opfield/relay/internal/identity"
	"github.com/opfield/opfield/relay/internal/lease"
	"github.com/opfield/opfield/relay/internal/policy"
	"github.com/opfield/opfield/relay/internal/proxy"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
	grpcpeer "google.golang.org/grpc/peer"
)

const (
	maxOpfieldMessageBytes = 512 * 1024 * 1024
	// A remote relay proxies no Gateway RPCs: it carries tunnel frames of at
	// most 1 MiB and policy snapshots from its supervisor. A smaller limit keeps
	// a peer from making it buffer huge messages.
	maxRemoteMessageBytes  = 64 * 1024 * 1024
	clientKeepaliveMinTime = 20 * time.Second
	// gracefulStopTimeout bounds how long Stop waits for open RPCs. Tunnels and
	// proxied daemon streams are long-lived and do not end on their own, and the
	// supervisor and Docker kill the relay ten seconds after asking it to stop,
	// which would skip closing the policy state cleanly.
	gracefulStopTimeout = 5 * time.Second
)

type Runtime struct {
	// GRPC is the servers of the relay port: clients with and without a
	// certificate (listener.go).
	GRPC     serverPair
	Listener net.Listener
	State    *policy.Store
	Proxy    *proxy.Handler
	Lease    *lease.Coordinator
}

// laneStreamWindow and laneConnWindow match the daemons' relay lanes
// (connector.LaneStreamWindow, connector.LaneConnWindow).
const (
	laneStreamWindow = 8 << 20
	laneConnWindow   = 32 << 20
)

func Start(cfg config.Config, buildVersion string) (*Runtime, error) {
	identityStore, err := identity.NewStore(cfg.IdentityDir, cfg.StateDir)
	if err != nil {
		return nil, fmt.Errorf("load relay identity: %w", err)
	}
	mode := relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED
	if cfg.Mode == config.ModeRemoteDataOnly {
		mode = relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY
	}
	state, err := policy.OpenWithOptions(cfg.StateDir, policy.Options{Mode: mode, PoolID: cfg.PoolID, InstanceID: cfg.InstanceID})
	if err != nil {
		return nil, fmt.Errorf("open relay state: %w", err)
	}
	tunnelBroker := broker.New(state)
	var app *grpc.ClientConn
	var proxyHandler *proxy.Handler
	reloadUpstream := func() error { return nil }
	maxMessageBytes := maxOpfieldMessageBytes
	if cfg.Mode == config.ModeRemoteDataOnly {
		maxMessageBytes = maxRemoteMessageBytes
	}
	// The split listener completes the TLS handshake (see listener.go); both
	// servers read the identity it established.
	serverOptions := []grpc.ServerOption{
		grpc.Creds(handshakenCredentials{}),
		grpc.ForceServerCodecV2(codec.ServerCodec{}),
		grpc.MaxSendMsgSize(maxMessageBytes),
		// Fixed HTTP/2 receive windows, as the daemons' lanes: gRPC's BDP
		// estimator grows windows only on a new maximum of measured
		// bandwidth, so a connection that once carried LAN traffic kept
		// LAN-sized windows when its round trip grew (< 0.5 MB/s at 300 ms).
		// What the relay can hold for a reader that does not read is bounded
		// by them: 8 MiB per stream, 32 MiB per connection.
		grpc.InitialWindowSize(laneStreamWindow), grpc.InitialConnWindowSize(laneConnWindow),
		grpc.KeepaliveParams(peerKeepalive()),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             clientKeepaliveMinTime,
			PermitWithoutStream: true,
		}),
	}
	if cfg.Mode == config.ModeLocalCombined {
		serverName, targetErr := targetServerName(cfg.AppTarget)
		if targetErr != nil {
			state.Close()
			return nil, targetErr
		}
		connectApp := func() (*grpc.ClientConn, error) {
			return grpc.NewClient(cfg.AppTarget,
				grpc.WithTransportCredentials(credentials.NewTLS(identityStore.AppTLSConfig(serverName))),
				grpc.WithDefaultCallOptions(grpc.ForceCodec(codec.Codec{}), grpc.MaxCallRecvMsgSize(maxOpfieldMessageBytes), grpc.MaxCallSendMsgSize(maxOpfieldMessageBytes)),
			)
		}
		app, err = connectApp()
		if err != nil {
			state.Close()
			return nil, fmt.Errorf("create app client: %w", err)
		}
		proxyHandler = proxy.New(app, connectApp)
		reloadUpstream = proxyHandler.ReloadUpstream
		serverOptions = append(serverOptions, grpc.UnknownServiceHandler(proxyHandler.Handle))
	}
	adminService := admin.New(state, tunnelBroker, identityStore, reloadUpstream, buildVersion)
	coordinator := startLease(cfg, state, identityStore, tunnelBroker, adminService)
	// The same services on both: a client without a certificate gets the
	// answers it got before (Unauthenticated, or the enrollment it may
	// call), within small message and stream limits.
	shared := serverOptions[:len(serverOptions):len(serverOptions)]
	grpcServer := grpc.NewServer(append(shared, grpc.MaxRecvMsgSize(maxMessageBytes))...)
	anonymousServer := grpc.NewServer(append(shared, grpc.MaxRecvMsgSize(anonymousMessageBytes),
		grpc.MaxConcurrentStreams(anonymousStreamsPerConnection))...)
	for _, server := range []*grpc.Server{grpcServer, anonymousServer} {
		relayv1.RegisterTunnelBrokerServer(server, tunnelBroker)
		relayv1.RegisterRelayAdminServer(server, adminService)
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", cfg.Port))
	if err != nil {
		if app != nil {
			app.Close()
		}
		if coordinator != nil {
			coordinator.Stop()
		}
		state.Close()
		return nil, err
	}
	listener = withPeerLiveness(listener)
	split := newSplitListener(listener, identityStore.ServerTLSConfig())
	tunnelBroker.SetLaneHint(func(ctx context.Context) bool {
		client, ok := grpcpeer.FromContext(ctx)
		return ok && client.Addr != nil && split.laneCollapsed(client.Addr.String())
	})
	runtime := &Runtime{GRPC: serverPair{grpcServer, anonymousServer}, Listener: listener, State: state, Proxy: proxyHandler, Lease: coordinator}
	go func() { _ = grpcServer.Serve(split.authenticated) }()
	go func() { _ = anonymousServer.Serve(split.anonymous) }()
	return runtime, nil
}

func (r *Runtime) Stop() {
	r.GRPCStop()
	if r.Proxy != nil {
		_ = r.Proxy.Close()
	}
	if r.Lease != nil {
		r.Lease.Stop()
	}
	_ = r.State.Close()
}

func (r *Runtime) GRPCStop() { stopWithin(r.GRPC, gracefulStopTimeout) }

type grpcStopper interface {
	GracefulStop()
	Stop()
}

// stopWithin stops accepting RPCs and lets open ones finish for up to timeout,
// then closes whatever is still open. It reports whether it had to force.
func stopWithin(server grpcStopper, timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		server.GracefulStop()
		close(done)
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return false
	case <-timer.C:
		server.Stop()
		<-done
		return true
	}
}

func targetServerName(target string) (string, error) {
	parsed, err := url.Parse("dns://" + target)
	if err != nil {
		return "", fmt.Errorf("invalid app target: %w", err)
	}
	host := parsed.Hostname()
	if host == "" {
		host = strings.Split(target, ":")[0]
	}
	return host, nil
}

// startLease runs availability lease coordination when the relay has a lease
// member id (its relay instance id). Without it, or when its state cannot be
// opened, the relay does not advertise the capability and lease-bound
// endpoints stay closed.
func startLease(cfg config.Config, state *policy.Store, identityStore *identity.Store, tunnelBroker *broker.Broker, adminService *admin.Service) *lease.Coordinator {
	if cfg.InstanceID == "" {
		return nil
	}
	leaseState, fresh, err := state.LeaseState()
	if err != nil {
		slog.Error("availability lease state unavailable; lease coordination disabled", "error", err)
		return nil
	}
	coordinator, err := lease.New(lease.Config{
		ID: cfg.InstanceID, Store: leaseState, Keys: lease.StoreKeys{Identity: identityStore},
		TrustedKeys: state.TrustedPolicyKeys, Logger: slog.Default(),
	})
	if err != nil {
		slog.Error("availability lease coordination disabled", "error", err)
		return nil
	}
	if fresh {
		slog.Warn("availability lease state created fresh; the relay abstains from voting after start", "abstain", availabilitylease.AbstainAfterStart.String())
	}
	tunnelBroker.SetLeaseGate(coordinator)
	coordinator.SetHolderEndpoints(tunnelBroker.HolderEndpoint)
	coordinator.ApplyPolicy(state.Current())
	coordinator.Start(tunnelBroker.EnforceLeaseGates)
	adminService.SetLeaseReporter(coordinator)
	return coordinator
}
