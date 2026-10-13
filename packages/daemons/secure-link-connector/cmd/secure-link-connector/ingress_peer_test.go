package main

import (
	"bufio"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

// The ingress listeners take connections only from the peer the daemon names (the management network's gateway): a
// workload that routes to the connector's management address from a link or target network is closed at once. A v1
// request (an older daemon) names no peer, and every peer is accepted as before.
func TestIngressListenersAcceptOnlyTheDaemonPeer(t *testing.T) {
	targetHost, targetPort := startEchoServer(t)
	host := nonLoopbackHost(t)
	manager := newBindingManager(0, 0)
	t.Cleanup(manager.close)
	egress := newEgressManager(t.TempDir() + "/" + egressSocketName)
	t.Cleanup(egress.close)
	bindings := []securelink.BindingConfig{{
		ID: "11111111-1111-4111-8111-111111111111", Generation: 1, ListenHost: host, TargetHost: targetHost, TargetPort: targetPort,
	}}
	echoes := func(port uint16) bool {
		connection, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprint(port)), time.Second)
		if err != nil {
			return false
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = fmt.Fprint(connection, "hello\n")
		line, err := bufio.NewReader(connection).ReadString('\n')
		return err == nil && line == "HELLO\n"
	}

	response := handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersion, Bindings: bindings, IngressPeer: "192.0.2.1"}, manager, egress)
	if response.Error != "" || len(response.Bindings) != 1 {
		t.Fatalf("v2 response %+v", response)
	}
	if echoes(response.Bindings[0].Port) {
		t.Fatal("an ingress listener served a peer other than the daemon")
	}

	response = handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersion, Bindings: bindings, IngressPeer: host}, manager, egress)
	if response.Error != "" || !echoes(response.Bindings[0].Port) {
		t.Fatalf("the daemon's peer was not served: %+v", response)
	}

	response = handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersion, Bindings: bindings, IngressPeer: "not-an-address"}, manager, egress)
	if response.Error == "" {
		t.Fatal("a malformed ingress peer was accepted")
	}

	legacy := handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersionIngressOnly, Bindings: bindings}, manager, egress)
	if legacy.Error != "" || !echoes(legacy.Bindings[0].Port) {
		t.Fatalf("a v1 request no longer serves every peer: %+v", legacy)
	}
}
