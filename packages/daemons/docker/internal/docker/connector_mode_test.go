package docker

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/opfield/opfield/docker-daemon/internal/config"
)

func TestStorageConnectorConfigOfPassesValidation(t *testing.T) {
	stateDir := t.TempDir()
	bindingID := "5b0c3b52-5d0f-4c1c-9a59-3f8f0f4c2a11"
	inspect := container.InspectResponse{
		Name: "/gateway-storage-connector-" + bindingID,
		Config: &container.Config{
			Image: developmentSecureLinkImage,
			User:  "65532:65532",
			Env: []string{
				"PATH=/usr/bin",
				"GATEWAY_CONNECTOR_BINDING_ID=" + bindingID,
				"GATEWAY_CONNECTOR_SOCKET=" + legacyStorageConnectorMount + "/" + storageConnectorSocketName,
				"GATEWAY_CONNECTOR_LISTEN=:9000",
			},
			Labels: map[string]string{managedStorageConnectorLabel: managedStorageConnectorWorkload},
		},
		HostConfig: &container.HostConfig{Binds: []string{storageConnectorRelayDirectory(stateDir) + ":/run/gateway:ro"}},
		NetworkSettings: &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{
			"gateway-storage-net": {Aliases: []string{"0123456789ab", storageBindingAlias(bindingID)}},
		}},
	}
	config, err := storageConnectorConfigOf(inspect)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateManagedStorageConnectorConfig(config, storageConnectorRelayDirectory(stateDir)); err != nil {
		t.Fatalf("rebuilt config is rejected: %v (%+v)", err, config)
	}
	if config.NetworkMode != "gateway-storage-net" || len(config.NetworkAliases) != 1 || strings.Contains(strings.Join(config.Env, ","), "PATH=") {
		t.Fatalf("rebuilt config = %+v", config)
	}
}

func TestClaimConnectorDirectoryKeepsOwnDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secure-link-connector")
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "keep"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := claimConnectorDirectory(path, 0o770|os.ModeSetgid); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSetgid == 0 || info.Mode().Perm() != 0o770 {
		t.Fatalf("mode = %s", info.Mode())
	}
	if _, err := os.Stat(filepath.Join(path, "keep")); err != nil {
		t.Fatal("an own directory was set aside")
	}
}

func TestClaimConnectorDirectorySetsAsideForeignDirectory(t *testing.T) {
	previous := daemonEUID
	t.Cleanup(func() { daemonEUID = previous })
	path := filepath.Join(t.TempDir(), "storage-connector")
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	// The directory belongs to the test's uid; a daemon with another uid sees a foreign owner.
	daemonEUID = func() int { return os.Geteuid() + 1 }
	if err := claimConnectorDirectory(path, 0o750); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	aside := false
	for _, entry := range entries {
		aside = aside || strings.HasPrefix(entry.Name(), "storage-connector.previous-owner-")
	}
	if !aside {
		t.Fatal("the foreign directory was not set aside")
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o750 {
		t.Fatalf("new directory: %v %v", info, err)
	}
}

func TestRootDaemonRemovesOnlySetAsideDirectories(t *testing.T) {
	previous := daemonEUID
	t.Cleanup(func() { daemonEUID = previous })
	daemonEUID = func() int { return 0 }
	stateDir := t.TempDir()
	for _, name := range []string{
		"secure-link-connector",
		"secure-link-connector.previous-owner-1791053749357938628",
		"secure-link-connector.previous-owner-12x",
		"storage-connector.previous-owner-1791053749767670040",
	} {
		if err := os.MkdirAll(filepath.Join(stateDir, name), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(stateDir, name, "secure-link.sock"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	target := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(stateDir, "secure-link-connector.previous-owner-42")); err != nil {
		t.Fatal(err)
	}
	p := &DockerPlugin{cfg: &config.Config{}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	p.cfg.StateDir = stateDir

	p.removeSetAsideConnectorDirectories(context.Background(), "secure-link-connector", "")

	for name, want := range map[string]bool{
		"secure-link-connector": true,
		"secure-link-connector.previous-owner-1791053749357938628": false,
		"secure-link-connector.previous-owner-12x":                 true,
		"storage-connector.previous-owner-1791053749767670040":     true,
		"secure-link-connector.previous-owner-42":                  true,
	} {
		_, err := os.Lstat(filepath.Join(stateDir, name))
		if exists := err == nil; exists != want {
			t.Fatalf("%s exists = %v, want %v", name, exists, want)
		}
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("the symlink target was touched")
	}
}
