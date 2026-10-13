package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testBindingID = "0f8fad5b-d9cb-469f-a165-70867728950e"

func environment(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

// docker-daemon 2.12.1 starts the connector with OPFIELD_* settings; a
// connector a 2.12.0 daemon created keeps its GATEWAY_* settings until it is
// recreated. Both start, and the new name wins when a container has both.
func TestStorageConnectorReadsTheOpfieldAndTheLegacyNames(t *testing.T) {
	for name, prefix := range map[string]string{"opfield": "OPFIELD_", "legacy": "GATEWAY_"} {
		config, storage, err := storageConnectorConfigFromEnv(environment(map[string]string{
			prefix + "CONNECTOR_BINDING_ID": testBindingID,
			prefix + "CONNECTOR_SOCKET":     "/run/opfield/storage.sock",
			prefix + "CONNECTOR_LISTEN":     storageConnectorListenAddress,
		}))
		if err != nil || !storage || config.BindingID != testBindingID || config.SocketPath != "/run/opfield/storage.sock" {
			t.Fatalf("%s: config=%#v storage=%v err=%v", name, config, storage, err)
		}
	}
	config, _, err := storageConnectorConfigFromEnv(environment(map[string]string{
		"OPFIELD_CONNECTOR_BINDING_ID": testBindingID,
		"GATEWAY_CONNECTOR_BINDING_ID": "ffffffff-ffff-4fff-bfff-ffffffffffff",
		"OPFIELD_CONNECTOR_SOCKET":     "/run/opfield/new.sock",
		"GATEWAY_CONNECTOR_SOCKET":     "/run/gateway/old.sock",
		"GATEWAY_CONNECTOR_LISTEN":     storageConnectorListenAddress,
	}))
	if err != nil || config.BindingID != testBindingID || config.SocketPath != "/run/opfield/new.sock" || config.Listen != storageConnectorListenAddress {
		t.Fatalf("mixed names: config=%#v err=%v", config, err)
	}
	if _, storage, _ := storageConnectorConfigFromEnv(environment(nil)); storage {
		t.Fatal("storage mode without a binding")
	}
	_, _, err = storageConnectorConfigFromEnv(environment(map[string]string{"GATEWAY_CONNECTOR_BINDING_ID": "not-a-uuid"}))
	if err == nil || !strings.Contains(err.Error(), "OPFIELD_CONNECTOR_BINDING_ID") {
		t.Fatalf("error names the old variable: %v", err)
	}
}

func TestConnectorSettingPrefersTheOpfieldName(t *testing.T) {
	values := map[string]string{"GATEWAY_SECURE_LINK_SOCKET": " /run/gateway/control.sock "}
	if got := connectorSetting(environment(values), secureLinkSocketEnv); got != "/run/gateway/control.sock" {
		t.Fatalf("legacy only = %q", got)
	}
	values["OPFIELD_SECURE_LINK_SOCKET"] = "/run/opfield/control.sock"
	if got := connectorSetting(environment(values), secureLinkSocketEnv); got != "/run/opfield/control.sock" {
		t.Fatalf("both = %q", got)
	}
}

// The clean mode empties only the directory docker-daemon mounted for it, at
// its new or its legacy mount point.
func TestCleanModeAcceptsBothMountPoints(t *testing.T) {
	for _, directory := range []string{"/run/opfield-clean/..", "/run/opfield", filepath.Join(t.TempDir(), "x")} {
		if err := emptyCleanDirectory(directory); err == nil || !strings.Contains(err.Error(), "OPFIELD_CONNECTOR_CLEAN_DIR") {
			t.Fatalf("%s: error = %v, want a refusal naming the setting", directory, err)
		}
	}
	for _, mount := range []string{cleanDirectoryMount, legacyCleanDirectoryMount} {
		if _, err := os.Stat(mount); err == nil {
			t.Logf("%s exists on this host; not emptying it", mount)
			continue
		}
		// Accepted: it gets as far as reading the (absent) directory.
		if err := emptyCleanDirectory(mount + "/"); err == nil || strings.Contains(err.Error(), "must be") {
			t.Fatalf("%s: error = %v, want a read error", mount, err)
		}
	}
}
