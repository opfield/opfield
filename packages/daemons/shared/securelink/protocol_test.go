package securelink

import (
	"context"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/sockettest"
)

// fakeConnector answers each control request with answer and records the request versions.
func fakeConnector(t *testing.T, answer func(SyncRequest) SyncResponse) (string, chan SyncRequest) {
	t.Helper()
	path := filepath.Join(sockettest.Dir(t), "secure-link.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	requests := make(chan SyncRequest, 4)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			var request SyncRequest
			if ReadJSON(connection, &request) == nil {
				requests <- request
				_ = WriteJSON(connection, answer(request))
			}
			connection.Close()
		}
	}()
	return path, requests
}

// A connector of the first release answers a v2 request as unsupported: it is sent the ingress bindings again in v1,
// and the response says so, without egress statuses.
func TestSyncFallsBackToIngressOnlyForAV1Connector(t *testing.T) {
	path, requests := fakeConnector(t, func(request SyncRequest) SyncResponse {
		if request.Version != ProtocolVersionIngressOnly {
			return SyncResponse{Version: ProtocolVersionIngressOnly, Error: UnsupportedVersionError}
		}
		return SyncResponse{Version: ProtocolVersionIngressOnly, Bindings: []BindingStatus{{ID: request.Bindings[0].ID, Port: 4000}}}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	bindings := []BindingConfig{{ID: "a", Generation: 1}}
	response, err := Sync(ctx, path, SyncRequest{Bindings: bindings, Egress: []EgressConfig{{ID: "e"}}})
	if err != nil {
		t.Fatal(err)
	}
	if response.Version != ProtocolVersionIngressOnly || len(response.Bindings) != 1 || response.Egress != nil {
		t.Fatalf("response %+v", response)
	}
	first, second := <-requests, <-requests
	if first.Version != ProtocolVersion || len(first.Egress) != 1 || second.Version != ProtocolVersionIngressOnly || len(second.Egress) != 0 {
		t.Fatalf("requests %+v then %+v", first, second)
	}
}

// Ingress bindings a v2 connector refused come back as an error together with the egress statuses.
func TestSyncKeepsEgressStatusesWhenIngressIsRefused(t *testing.T) {
	path, _ := fakeConnector(t, func(request SyncRequest) SyncResponse {
		return SyncResponse{Version: ProtocolVersion, Error: "bind failed",
			Egress: []EgressStatus{{ID: request.Egress[0].ID, State: EgressListening}}}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	response, err := Sync(ctx, path, SyncRequest{Egress: []EgressConfig{{ID: "e"}}})
	if err == nil || response == nil || len(response.Egress) != 1 || response.Egress[0].State != EgressListening {
		t.Fatalf("response %+v, error %v", response, err)
	}
}
