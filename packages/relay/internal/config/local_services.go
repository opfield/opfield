package config

import (
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
)

const (
	RegistryServiceID = "opfield-internal-registry"
	// legacy-name: legacycompat.InternalRegistryServiceID service id — remove once every node reports none.
	// Opfield 2.12.0 names the internal registry so in its policy snapshots.
	LegacyRegistryServiceID = legacycompat.InternalRegistryServiceID
	RegistryServiceTarget   = "registry:5000"
	// OpfieldRegistryCapability tells Opfield this relay serves the internal
	// registry under RegistryServiceID as well as under the legacy id.
	OpfieldRegistryCapability = "local_service_opfield_registry_v1"
)

type LocalServiceTarget struct {
	ID     string
	Target string
}

// BuiltinLocalServiceTarget returns an immutable relay-owned destination.
// Callers cannot supply a host or port, which prevents policy metadata from
// turning the local Relay into an arbitrary network dialer.
func BuiltinLocalServiceTarget(id string) (LocalServiceTarget, error) {
	if id != RegistryServiceID && id != LegacyRegistryServiceID {
		return LocalServiceTarget{}, fmt.Errorf("unknown built-in local service %q", id)
	}
	return LocalServiceTarget{ID: id, Target: RegistryServiceTarget}, nil
}
