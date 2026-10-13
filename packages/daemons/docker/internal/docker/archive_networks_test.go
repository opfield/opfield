package docker

import (
	"context"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

// An imported archive names the networks its container joins. Like a direct
// create, it may not take the host's or another container's namespace or a
// network Opfield owns on the node; none only alone.
func TestGwcaImportRefusesHostAndOpfieldNetworks(t *testing.T) {
	manifest := func(names ...string) gwcaContainerManifest {
		result := gwcaContainerManifest{SchemaVersion: 1, Name: "app"}
		for _, name := range names {
			result.Networks = append(result.Networks, gwcaNetwork{Name: name})
		}
		return result
	}
	refused := map[string][]string{
		"host":                             {"host"},
		"another container's namespace":    {"container:abc"},
		"Secure Links management network":  {"bridge", "gateway-secure-links"},
		"managed database network":         {"gateway-db-0123456789abcdef"},
		"managed storage network":          {"gateway-storage-0123456789abcdef"},
		"none together with other network": {"none", "bridge"},
	}
	for name, networks := range refused {
		t.Run(name, func(t *testing.T) {
			if _, err := gwcaManifestToMigration(manifest(networks...), "sha256:"+strings.Repeat("a", 64), "app:1", "app", "archive-1"); err == nil {
				t.Fatalf("archive on networks %v accepted", networks)
			}
			plugin := &DockerPlugin{}
			entries := manifest(networks...)
			if _, err := plugin.prepareGwcaNetworks(context.Background(), "archive-1", &entries); err == nil {
				t.Fatalf("archive networks %v prepared", networks)
			}
		})
	}
	for _, networks := range [][]string{{"bridge"}, {"app-net", "bridge"}, {"none"}} {
		request, err := gwcaManifestToMigration(manifest(networks...), "sha256:"+strings.Repeat("a", 64), "app:1", "app", "archive-1")
		if err != nil {
			t.Fatalf("archive on networks %v refused: %v", networks, err)
		}
		if got := string(request.Manifest.HostConfig.NetworkMode); got != networks[0] {
			t.Fatalf("network mode %q, want %q", got, networks[0])
		}
	}
}

// A stopped create (migration target or archive import) refuses the host's or
// another container's namespace and the Secure Links management network
// before it touches dockerd.
func TestStoppedCreateRefusesHostNamespacesAndSecureLinks(t *testing.T) {
	client := &Client{}
	for _, tc := range []struct {
		mode      string
		endpoints []string
	}{
		{mode: "host"},
		{mode: "container:abc"},
		{mode: "gateway-secure-links"},
		{mode: "app-net", endpoints: []string{"app-net", "gateway-secure-links"}},
	} {
		endpoints := map[string]*network.EndpointSettings{}
		for _, name := range tc.endpoints {
			endpoints[name] = &network.EndpointSettings{}
		}
		request := createStoppedContainerRequest{MigrationID: "migration-1", Manifest: dockerMigrationManifest{
			SchemaVersion: 1, Name: "app", Config: &container.Config{},
			HostConfig:       &container.HostConfig{NetworkMode: container.NetworkMode(tc.mode)},
			NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: endpoints},
		}}
		if _, err := client.CreateContainerStopped(context.Background(), request); err == nil || !strings.Contains(err.Error(), "not allowed") && !strings.Contains(err.Error(), "cannot be attached") {
			t.Fatalf("stopped create on %q %v: %v", tc.mode, tc.endpoints, err)
		}
	}
}
