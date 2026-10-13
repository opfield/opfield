package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	mobyclient "github.com/moby/moby/client"
	"gopkg.in/yaml.v3"
)

// Tests run without a launcher, so new objects get the Opfield names; these name the objects of that family.
var (
	secureLinkConnectorName     = opfieldSecureLinkNames.connector
	secureLinkAnchorName        = opfieldSecureLinkNames.anchor
	secureLinkManagementNetwork = opfieldSecureLinkNames.network
	secureLinkConnectorSlots    = [len(secureLinkConnectorSockets)]struct{ name, socket string }{
		{name: secureLinkConnectorName, socket: secureLinkConnectorSockets[0]},
		{name: secureLinkConnectorName + "-next", socket: secureLinkConnectorSockets[1]},
		{name: secureLinkConnectorName + "-third", socket: secureLinkConnectorSockets[2]},
	}
)

func keeperWitnessName(id string) string { return keeperWitnessNames(id)[0] }

// withOpfieldNamesActive sets whether new objects get the Opfield names for one test.
func withOpfieldNamesActive(t *testing.T, active bool) {
	t.Helper()
	previous := opfieldNamesActive
	opfieldNamesActive = func() bool { return active }
	t.Cleanup(func() { opfieldNamesActive = previous })
}

// namesEngine is a Docker API that knows only the named networks and containers.
func namesEngine(t *testing.T, networks, containers []string) *DockerPlugin {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		if index := strings.Index(path, "/networks/"); index >= 0 {
			name := path[index+len("/networks/"):]
			if slices.Contains(networks, name) {
				_ = json.NewEncoder(w).Encode(map[string]any{"Name": name, "Id": name + "-id"})
				return
			}
		}
		if index := strings.Index(path, "/containers/"); index >= 0 && strings.HasSuffix(path, "/json") {
			name := strings.TrimSuffix(path[index+len("/containers/"):], "/json")
			if slices.Contains(containers, name) {
				_ = json.NewEncoder(w).Encode(map[string]any{"Id": name + "-id", "Name": "/" + name})
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "not found"})
	}))
	t.Cleanup(server.Close)
	cli, err := mobyclient.NewClientWithOpts(mobyclient.WithHost("tcp://"+strings.TrimPrefix(server.URL, "http://")),
		mobyclient.WithAPIVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	return &DockerPlugin{client: &Client{cli: cli}}
}

func TestSecureLinkNamesKeepTheFamilyTheNodeRuns(t *testing.T) {
	cases := []struct {
		name       string
		active     bool
		networks   []string
		containers []string
		want       secureLinkNames
	}{
		{name: "a new node", active: true, want: opfieldSecureLinkNames},
		{name: "a node whose start may still roll back", active: false, want: legacySecureLinkNames},
		{name: "a node with the earlier network", active: true, networks: []string{legacySecureLinkNames.network}, want: legacySecureLinkNames},
		{name: "a node with only an earlier connector", active: true, containers: []string{legacySecureLinkNames.connector + "-next"}, want: legacySecureLinkNames},
		{name: "a node with only the earlier anchor", active: true, containers: []string{legacySecureLinkNames.anchor}, want: legacySecureLinkNames},
		{name: "an Opfield node started again before its start is confirmed", active: false, networks: []string{opfieldSecureLinkNames.network}, want: opfieldSecureLinkNames},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withOpfieldNamesActive(t, tc.active)
			plugin := namesEngine(t, tc.networks, tc.containers)
			if got := plugin.secureLinkNames(context.Background()); got != tc.want {
				t.Fatalf("secureLinkNames = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestSecureLinkNamesSettleOnceTheStartIsConfirmed(t *testing.T) {
	active := false
	previous := opfieldNamesActive
	opfieldNamesActive = func() bool { return active }
	t.Cleanup(func() { opfieldNamesActive = previous })
	plugin := namesEngine(t, nil, nil)
	if got := plugin.secureLinkNames(context.Background()); got != legacySecureLinkNames {
		t.Fatalf("before the confirmed start: %+v", got)
	}
	active = true
	if got := plugin.secureLinkNames(context.Background()); got != opfieldSecureLinkNames {
		t.Fatalf("after the confirmed start: %+v", got)
	}
	active = false
	if got := plugin.secureLinkNames(context.Background()); got != opfieldSecureLinkNames {
		t.Fatalf("the family changed after it settled: %+v", got)
	}
}

func TestReadersAcceptBothNameFamilies(t *testing.T) {
	for _, name := range []string{"opfield-db-0123456789abcdef", "gateway-db-0123456789abcdef", "opfield-db-av-0123456789abcdef", "gateway-db-av-0123456789abcdef"} {
		if !databaseLinkNetworkPattern.MatchString(name) || !isDatabaseLinkNetworkName(name) || !isLinkNetwork(name) || !isReservedOpfieldNetworkName(name) {
			t.Fatalf("%s is not read as a managed database link network", name)
		}
	}
	for _, name := range []string{"opfield-storage-0123456789abcdef", "gateway-storage-0123456789abcdef", "opfield-storage-6f1c2a1e-3b4d-4c5e-8f9a-0b1c2d3e4f5a"} {
		if !storageBindingNetworkNamePattern.MatchString(name) || !isLinkNetwork(name) || !isReservedOpfieldNetworkName(name) {
			t.Fatalf("%s is not read as a storage network", name)
		}
	}
	for _, name := range []string{"opfield-link-0123456789abcdef", "gateway-link-0123456789abcdef"} {
		if !containerLinkNetworkPattern.MatchString(name) || !isLinkNetwork(name) || !isReservedOpfieldNetworkName(name) {
			t.Fatalf("%s is not read as a container link network", name)
		}
	}
	for _, name := range []string{"opfield-secure-links", "gateway-secure-links"} {
		if !isReservedOpfieldNetworkName(name) || validateUserWorkloadNetworkMode(name) == nil {
			t.Fatalf("%s is not reserved", name)
		}
	}
	for _, name := range []string{"opfield-secure-link-anchor", "gateway-secure-link-anchor", "opfield-secure-link-connector-third", "gateway-secure-link-connector"} {
		if !isSecureLinkConnectorName(name) {
			t.Fatalf("%s is not read as a connector container", name)
		}
	}
	if suffix, ok := databaseLinkNetworkSuffix("opfield-db-av-0123456789abcdef"); !ok || suffix != "av-0123456789abcdef" {
		t.Fatalf("suffix = %q, %v", suffix, ok)
	}
	for _, name := range []string{"opfield-storage-connector-6f1c2a1e-3b4d-4c5e-8f9a-0b1c2d3e4f5a", "gateway-storage-connector-6f1c2a1e-3b4d-4c5e-8f9a-0b1c2d3e4f5a"} {
		if id, ok := storageConnectorBindingID(name); !ok || id != "6f1c2a1e-3b4d-4c5e-8f9a-0b1c2d3e4f5a" {
			t.Fatalf("binding of %s = %q, %v", name, id, ok)
		}
	}
}

func TestComposeLinkNetworkKeysOfEitherFamily(t *testing.T) {
	const part = "0123456789abcdef"
	for _, tc := range []struct{ key, name string }{
		{"opfield_db_" + part, "opfield-db-" + part},
		{"gateway_db_" + part, "gateway-db-" + part},
		// A link keeps its key when its network moves to the network of an Availability copy of the other family.
		{"gateway_db_" + part, "opfield-db-av-" + part},
		{"opfield_db_" + part, "gateway-db-av-" + part},
		{"opfield_link_" + part, "opfield-link-" + part},
		{"gateway_link_" + part, "gateway-link-" + part},
	} {
		yamlText := "networks:\n  " + tc.key + ":\n    external: true\n    name: " + tc.name + "\n"
		if err := validateComposeNetworkNamesYAML(t, yamlText); err != nil {
			t.Fatalf("%s naming %s: %v", tc.key, tc.name, err)
		}
	}
	// Only the link keys may name a reserved network.
	if err := validateComposeNetworkNamesYAML(t, "networks:\n  mine:\n    external: true\n    name: opfield-db-"+part+"\n"); err == nil {
		t.Fatal("a user network key named a managed database link network")
	}
}

func TestKeeperWitnessAndManagedDatabaseNames(t *testing.T) {
	if got := keeperWitnessNames("w1"); !slices.Equal(got, []string{"opfkw-w1", "gwkw-w1"}) {
		t.Fatalf("witness names %v", got)
	}
	if got := managedDatabaseContainerNames("d1"); !slices.Equal(got, []string{"opfdb-d1", "gwdb-d1"}) {
		t.Fatalf("database names %v", got)
	}
	withOpfieldNamesActive(t, true)
	if prefix := managedDatabaseContainerPrefix(); prefix != "opfdb-" {
		t.Fatalf("new database prefix %q", prefix)
	}
	withOpfieldNamesActive(t, false)
	if prefix := managedDatabaseContainerPrefix(); prefix != "gwdb-" {
		t.Fatalf("database prefix of a start that may roll back %q", prefix)
	}
}

func TestOpfieldNamesCapabilityFollowsTheConfirmedStart(t *testing.T) {
	plugin := &DockerPlugin{registrationChanged: make(chan struct{}, 1)}
	withOpfieldNamesActive(t, false)
	if got := plugin.opfieldNamesCapabilities(); len(got) != 0 {
		t.Fatalf("a start that may roll back advertised %v", got)
	}
	withOpfieldNamesActive(t, true)
	if got := plugin.opfieldNamesCapabilities(); !slices.Equal(got, []string{opfieldNamesCapability, opfieldLabelsCapability}) {
		t.Fatalf("capabilities %v", got)
	}
}

// validateComposeNetworkNamesYAML runs the network name check on the top-level networks of a Compose file.
func validateComposeNetworkNamesYAML(t *testing.T, text string) error {
	t.Helper()
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(text), &document); err != nil {
		t.Fatal(err)
	}
	root := document.Content[0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "networks" {
			return validateComposeNetworkNames(root.Content[i+1])
		}
	}
	t.Fatal("no networks")
	return nil
}
