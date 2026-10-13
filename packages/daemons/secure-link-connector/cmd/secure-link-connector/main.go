package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/netaccept"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

func main() {
	if directory := osSetting(connectorCleanDirEnv); directory != "" {
		if err := emptyCleanDirectory(directory); err != nil {
			log.Fatal(err)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == pauseCommand {
		runPause(ctx)
		return
	}
	// The Go memory limit follows the container's memory limit, which the daemon may change in place.
	go followCgroupMemoryLimit(ctx)
	storageConfig, storageMode, err := storageConnectorConfigFromEnv(storageConnectorEnvironment())
	if err != nil {
		log.Fatal(err)
	}
	if storageMode {
		if err := runStorageConnector(ctx, storageConfig); err != nil {
			log.Fatal(err)
		}
		return
	}

	socketPath := osSetting(secureLinkSocketEnv)
	if socketPath == "" || !filepath.IsAbs(socketPath) {
		log.Fatal(envPrefix + secureLinkSocketEnv + " must be an absolute path")
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o750); err != nil {
		log.Fatalf("create control directory: %v", err)
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatalf("remove stale control socket: %v", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("listen on control socket: %v", err)
	}
	if err := os.Chmod(socketPath, 0o660); err != nil {
		listener.Close()
		log.Fatalf("set control socket permissions: %v", err)
	}

	// Secure links carry long-lived traffic (WebSockets, database pools), so
	// the connector never caps or times out sessions; nginx bounds the load
	// and TCP keepalive clears dead peers.
	manager := newBindingManager(0, 0)
	// Egress listeners reach the daemon through its egress socket in the same directory: both connector slots
	// mount it, whatever their control socket is named.
	egress := newEgressManager(filepath.Join(filepath.Dir(socketPath), egressSocketName))
	// One set of sessions: a handover passes the ingress and egress sessions together.
	egress.sessions = manager.sessions
	// A connector this one replaces hands its sessions over on the takeover socket (takeover.go).
	takeover, err := listenTakeover(socketPath)
	if err != nil {
		log.Printf("sessions of a replaced connector cannot be taken over: %v", err)
	} else {
		go serveTakeover(takeover, manager, egress)
	}
	go func() {
		<-ctx.Done()
		listener.Close()
		if takeover != nil {
			takeover.Close()
		}
		manager.close()
		egress.close()
	}()
	// The daemon's way to stop a replaced connector accepting when it cannot reach its control socket (a switch of the
	// daemon's user): the same as a drain request.
	drainSignals := make(chan os.Signal, 1)
	signal.Notify(drainSignals, drainSignal)
	go drainOnSignal(ctx, drainSignals, func() {
		active := manager.drain() + egress.drain()
		log.Printf("draining on signal: listeners closed, %d sessions go on", active)
	})

	// A transient accept error (out of file descriptors) backs off instead of spinning and flooding the log.
	var backoff netaccept.Backoff
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("accept control connection: %v", err)
			if !backoff.Retry(err, ctx.Done()) {
				return
			}
			continue
		}
		backoff.Reset()
		go handleControlConnection(connection, manager, egress)
	}
}

func handleControlConnection(connection net.Conn, manager *bindingManager, egress *egressManager) {
	defer connection.Close()
	var request securelink.SyncRequest
	if err := securelink.ReadJSON(connection, &request); err != nil {
		_ = securelink.WriteJSON(connection, securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: err.Error()})
		return
	}
	_ = securelink.WriteJSON(connection, handleSyncRequest(request, manager, egress))
}

// handleSyncRequest applies one control request. A version 1 request comes from a daemon that knows no egress (one
// rolled back to an older release): it sets the ingress bindings, no egress listener stays, and the answer is
// version 1 as that daemon expects. A version 2 request sets both; its egress listeners stand on their own, so
// ingress bindings the connector refuses (response Error) leave the egress statuses in the answer. A version 3
// request is a handover (takeover.go) and nothing else.
func handleSyncRequest(request securelink.SyncRequest, manager *bindingManager, egress *egressManager) securelink.SyncResponse {
	switch request.Version {
	case securelink.ProtocolVersionHandover:
		return handOver(request.Handover, manager, egress)
	case securelink.ProtocolVersionIngressOnly:
		_ = manager.peer.set("")
		if _, err := egress.sync(nil); err != nil {
			return securelink.SyncResponse{Version: securelink.ProtocolVersionIngressOnly, Error: err.Error()}
		}
		statuses, err := manager.sync(request.Bindings)
		if err != nil {
			return securelink.SyncResponse{Version: securelink.ProtocolVersionIngressOnly, Error: err.Error()}
		}
		return securelink.SyncResponse{Version: securelink.ProtocolVersionIngressOnly, Bindings: statuses}
	case securelink.ProtocolVersion:
		if request.Drain {
			return securelink.SyncResponse{Version: securelink.ProtocolVersion, Active: manager.drain() + egress.drain()}
		}
		if err := manager.peer.set(request.IngressPeer); err != nil {
			return securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: err.Error()}
		}
		egressStatuses, err := egress.sync(request.Egress)
		if err != nil {
			return securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: err.Error()}
		}
		response := securelink.SyncResponse{Version: securelink.ProtocolVersion, Egress: egressStatuses}
		statuses, err := manager.sync(request.Bindings)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.Bindings = statuses
		}
		return response
	default:
		return securelink.SyncResponse{Version: securelink.ProtocolVersion, Error: securelink.UnsupportedVersionError}
	}
}
