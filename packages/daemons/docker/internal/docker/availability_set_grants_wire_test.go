package docker

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/protobuf/proto"
)

const setGrantsVectorPath = "../../../../../proto/testdata/relay-grant-set-paths-v1.json"

// Gateway's grant bundle with set paths, as its gRPC stream encodes it
// (backend relay-grant-wire.test.ts), lands in the daemon's grant store with
// the lease target of each peer route and the lease group of a link: the
// member mesh finds the primary's replication route by them, and a link to a
// set opens the holder's route. (A field-by-field copy on Gateway's side once
// dropped both, so the member mesh could not open any route.)
func TestRelayGrantBundleCarriesSetPathsIntoTheGrantStore(t *testing.T) {
	data, err := os.ReadFile(setGrantsVectorPath)
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		GatewayCommandBase64 string `json:"gatewayCommandBase64"`
	}
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(vector.GatewayCommandBase64)
	if err != nil {
		t.Fatal(err)
	}
	var command pb.GatewayCommand
	if err := proto.Unmarshal(raw, &command); err != nil {
		t.Fatal(err)
	}
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.sync(command.GetSyncRelayGrants()); err != nil {
		t.Fatal(err)
	}
	plugin := &DockerPlugin{relayGrants: store}

	const set = "11111111-1111-4111-8111-111111111111"
	routes := plugin.setPeerRoutes(set, "primary-pg-repl")
	if len(routes) != 1 || routes[0].GetRouteId() != "route-peer" {
		t.Fatalf("the primary's replication route is not found by its lease target: %v", routes)
	}
	if target := routes[0].GetLeaseTarget(); target.GetLeasePolicyId() != "22222222-2222-4222-8222-222222222222" ||
		target.GetMemberId() != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" || !target.GetPrimaryPort() {
		t.Fatalf("peer route lease target = %v", target)
	}
	links := store.filter(func(a *pb.RelayGrantAssignment) bool { return a.GetOwnerKind() == "managed_database_link" })
	if len(links) != 1 || len(links[0].GetLeaseGroup()) != 2 {
		t.Fatalf("the link's lease group did not arrive: %v", links)
	}
	for i, want := range []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"} {
		if got := links[0].GetLeaseGroup()[i].GetTarget().GetMemberId(); got != want {
			t.Fatalf("lease group route %d reaches %s, want %s", i, got, want)
		}
	}
	if !plugin.needsSetLeaseGates() {
		t.Fatal("set routes under a running lease need the relays' gate views")
	}
}
