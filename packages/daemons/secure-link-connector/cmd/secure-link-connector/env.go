package main

import (
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"strings"
)

// The connector's settings come from docker-daemon in OPFIELD_* variables.
const (
	envPrefix = "OPFIELD_"
	// legacy-name: legacycompat.EnvPrefix* connector env — remove once every node reports none.
	// docker-daemon 2.12.0 starts the connector image Opfield pins with these
	// names, and a running connector keeps its env until it is recreated.
	legacyEnvPrefix = legacycompat.EnvPrefix

	secureLinkSocketEnv  = "SECURE_LINK_SOCKET"
	connectorBindingEnv  = "CONNECTOR_BINDING_ID"
	connectorSocketEnv   = "CONNECTOR_SOCKET"
	connectorListenEnv   = "CONNECTOR_LISTEN"
	connectorCAPEMEnv    = "CONNECTOR_CA_PEM"
	connectorServerEnv   = "CONNECTOR_SERVER_NAME"
	connectorCleanDirEnv = "CONNECTOR_CLEAN_DIR"
)

// connectorSetting reads setting under its OPFIELD_ name, or its legacy name
// when that one is unset, trimmed.
func connectorSetting(getenv func(string) string, setting string) string {
	if value := strings.TrimSpace(getenv(envPrefix + setting)); value != "" {
		return value
	}
	return strings.TrimSpace(getenv(legacyEnvPrefix + setting))
}

func osSetting(setting string) string { return connectorSetting(os.Getenv, setting) }
