package main

import (
	"bufio"
	"fmt"
	"net"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

const (
	egressTestLinkID  = "3c9d1e2f-4a5b-4c6d-8e7f-901234567890"
	egressTestOtherID = "4d0e2f3a-5b6c-4d7e-9f80-012345678901"
)

// fakeEgressDaemon is the daemon's egress socket: it records the relay requests and, once it answered one, echoes
// the stream in upper case.
func fakeEgressDaemon(t *testing.T) (string, chan securelink.RelayRequest) {
	t.Helper()
	path := filepath.Join(sockettest.Dir(t), egressSocketName)
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	requests := make(chan securelink.RelayRequest, 8)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				var request securelink.RelayRequest
				if securelink.ReadJSON(connection, &request) != nil {
					return
				}
				requests <- request
				if securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion}) != nil {
					return
				}
				reader := bufio.NewReader(connection)
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						return
					}
					_, _ = fmt.Fprint(connection, strings.ToUpper(line))
				}
			}()
		}
	}()
	return path, requests
}

// egressTestConfig is an egress listener on this host's address, on a free port, for a network around it.
func egressTestConfig(t *testing.T, id string) securelink.EgressConfig {
	t.Helper()
	host := nonLoopbackHost(t)
	probe, err := net.Listen("tcp4", net.JoinHostPort(host, "0"))
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	address := netip.MustParseAddr(host)
	prefix := netip.PrefixFrom(address, 16).Masked()
	if address == prefix.Addr() || address == prefix.Addr().Next() {
		t.Skip("this host's address is the network or gateway address of its /16")
	}
	return securelink.EgressConfig{
		ID: id, OwnerKind: "container_link", Generation: 1, ListenHost: host, ListenPort: uint16(port),
		AllowedPrefix: prefix.String(),
	}
}

func egressStatusOf(t *testing.T, statuses []securelink.EgressStatus, id string) securelink.EgressStatus {
	t.Helper()
	for _, status := range statuses {
		if status.ID == id {
			return status
		}
	}
	t.Fatalf("no status for %s in %+v", id, statuses)
	return securelink.EgressStatus{}
}

// A workload's connection to an egress listener is carried through the daemon's egress socket with the link's owner
// kind and id, in the relay protocol every daemon speaks.
func TestEgressListenerCarriesConnectionsThroughTheDaemon(t *testing.T) {
	socket, requests := fakeEgressDaemon(t)
	egress := newEgressManager(socket)
	t.Cleanup(egress.close)
	config := egressTestConfig(t, egressTestLinkID)

	statuses, err := egress.sync([]securelink.EgressConfig{config})
	if err != nil {
		t.Fatal(err)
	}
	if status := egressStatusOf(t, statuses, egressTestLinkID); status.State != securelink.EgressListening {
		t.Fatalf("status %+v", status)
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort(config.ListenHost, fmt.Sprint(config.ListenPort)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, _ = fmt.Fprint(connection, "hello\n")
	_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	line, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil || line != "HELLO\n" {
		t.Fatalf("relayed answer %q, %v", line, err)
	}
	request := <-requests
	if request.Version != securelink.RelayProtocolVersion || request.OwnerKind != "container_link" || request.BindingID != egressTestLinkID {
		t.Fatalf("relay request %+v", request)
	}
}

// One egress listener that cannot be served is reported on its own; the others and the ingress bindings of the
// request are applied. A version 1 request (a daemon rolled back to a release without egress) leaves no egress
// listener and is answered in version 1.
func TestSyncRequestVersionsAndPerBindingEgressFailures(t *testing.T) {
	socket, _ := fakeEgressDaemon(t)
	egress := newEgressManager(socket)
	t.Cleanup(egress.close)
	manager := newBindingManager(0, 0)
	t.Cleanup(manager.close)
	targetHost, targetPort := startEchoServer(t)
	ingress := []securelink.BindingConfig{{
		ID: "11111111-1111-4111-8111-111111111111", Generation: 1, ListenHost: nonLoopbackHost(t), TargetHost: targetHost, TargetPort: targetPort,
	}}
	good := egressTestConfig(t, egressTestLinkID)
	bad := egressTestConfig(t, egressTestOtherID)
	bad.OwnerKind = "proxy_host_secure_link"

	response := handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersion, Bindings: ingress,
		Egress: []securelink.EgressConfig{good, bad}}, manager, egress)
	if response.Version != securelink.ProtocolVersion || response.Error != "" || len(response.Bindings) != 1 {
		t.Fatalf("v2 response %+v", response)
	}
	if status := egressStatusOf(t, response.Egress, egressTestLinkID); status.State != securelink.EgressListening {
		t.Fatalf("good egress %+v", status)
	}
	if status := egressStatusOf(t, response.Egress, egressTestOtherID); status.State != securelink.EgressError || status.Error == "" {
		t.Fatalf("bad egress %+v", status)
	}

	// An older generation arriving late keeps the listener as it is.
	stale := good
	stale.Generation = 0
	statuses, err := egress.sync([]securelink.EgressConfig{stale})
	if err != nil || egressStatusOf(t, statuses, egressTestLinkID).State != securelink.EgressError || len(egress.listeners) != 1 {
		t.Fatalf("stale generation: %+v, %v", statuses, err)
	}

	duplicate := handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersion, Bindings: ingress,
		Egress: []securelink.EgressConfig{good, good}}, manager, egress)
	if duplicate.Error == "" {
		t.Fatalf("a request naming one egress twice was accepted: %+v", duplicate)
	}

	legacy := handleSyncRequest(securelink.SyncRequest{Version: securelink.ProtocolVersionIngressOnly, Bindings: ingress}, manager, egress)
	if legacy.Version != securelink.ProtocolVersionIngressOnly || legacy.Error != "" || len(legacy.Bindings) != 1 || len(legacy.Egress) != 0 {
		t.Fatalf("v1 response %+v", legacy)
	}
	if len(egress.listeners) != 0 {
		t.Fatalf("egress listeners left after a v1 request: %d", len(egress.listeners))
	}
	if _, err := net.DialTimeout("tcp", net.JoinHostPort(good.ListenHost, fmt.Sprint(good.ListenPort)), 200*time.Millisecond); err == nil {
		t.Fatal("the egress listener still accepts after a v1 request")
	}

	future := handleSyncRequest(securelink.SyncRequest{Version: 4}, manager, egress)
	if future.Error != securelink.UnsupportedVersionError {
		t.Fatalf("unknown version answered %+v", future)
	}
}

func TestEgressPeerMustBeAWorkloadOfTheNetwork(t *testing.T) {
	prefix := netip.MustParsePrefix("10.213.0.16/28")
	for _, test := range []struct {
		peer    string
		allowed bool
	}{
		{"10.213.0.24", true},
		{"10.213.0.17", false}, // the bridge gateway: the host
		{"10.213.0.16", false},
		{"10.213.0.40", false},
		{"172.17.0.2", false},
	} {
		remote := &net.TCPAddr{IP: net.ParseIP(test.peer), Port: 40000}
		if got := peerAllowed(prefix, remote); got != test.allowed {
			t.Errorf("peer %s allowed = %v, want %v", test.peer, got, test.allowed)
		}
	}
}
