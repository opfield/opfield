package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Port        int
	AppTarget   string
	IdentityDir string
	StateDir    string
	Mode        Mode
	PoolID      string
	InstanceID  string
}

type Mode string

const (
	ModeLocalCombined  Mode = "local"
	ModeRemoteDataOnly Mode = "remote"
)

func Load() (Config, error) {
	port, err := positiveInt("RELAY_PORT", 9443)
	if err != nil {
		return Config{}, err
	}
	mode, err := relayMode(os.Getenv("RELAY_MODE"))
	if err != nil {
		return Config{}, err
	}
	config := Config{
		Port:        port,
		AppTarget:   value("RELAY_APP_GRPC_TARGET", "app:9443"),
		IdentityDir: filepath.Clean(value("RELAY_IDENTITY_DIR", "/var/lib/opfield-relay/identity")),
		StateDir:    filepath.Clean(value("RELAY_STATE_DIR", "/var/lib/opfield-relay/state")),
		Mode:        mode,
		PoolID:      os.Getenv("RELAY_POOL_ID"),
		InstanceID:  os.Getenv("RELAY_INSTANCE_ID"),
	}
	if config.Mode == ModeRemoteDataOnly {
		if config.PoolID == "" {
			return Config{}, fmt.Errorf("RELAY_POOL_ID is required in remote mode")
		}
		if config.InstanceID == "" {
			return Config{}, fmt.Errorf("RELAY_INSTANCE_ID is required in remote mode")
		}
	}
	if config.Mode == ModeLocalCombined && (config.PoolID == "") != (config.InstanceID == "") {
		return Config{}, fmt.Errorf("RELAY_POOL_ID and RELAY_INSTANCE_ID must be configured together")
	}
	return config, nil
}

func relayMode(raw string) (Mode, error) {
	switch raw {
	case "", string(ModeLocalCombined):
		return ModeLocalCombined, nil
	case string(ModeRemoteDataOnly):
		return ModeRemoteDataOnly, nil
	default:
		return "", fmt.Errorf("RELAY_MODE must be local or remote")
	}
}

func value(name, fallback string) string {
	if current := os.Getenv(name); current != "" {
		return current
	}
	return fallback
}

func positiveInt(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 || parsed > 65535 {
		return 0, fmt.Errorf("%s must be an integer between 1 and 65535", name)
	}
	return parsed, nil
}
