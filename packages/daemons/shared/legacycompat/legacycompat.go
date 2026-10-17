// Package legacycompat holds the literals of the product names before Opfield that nodes, relays, installations and
// clients released earlier still read or send. Every other place uses the Opfield names; code that must recognise or
// send one of these values takes it from here. Each constant names what reads it. Do not change a value: it is a
// contract with something already running.
package legacycompat

// Update manifests and the release feed.
const (
	// AppImageManifestKind is the kind of the signed app image manifest the updater of every installed release verifies.
	AppImageManifestKind = "gateway-image"
	// MinVersionField is the relay and core manifest field with the minimum app version, read by installed releases.
	MinVersionField = "minGatewayVersion"
	// MaxVersionField is the core manifest field with the maximum app version, read by installed releases.
	MaxVersionField = "maxGatewayVersion"
	// UpdateKeyID is the key id of update manifests and the license endpoints document, checked by installed releases.
	UpdateKeyID = "wiolett-update-v1"
	// UpdateFeedBase is the release feed path installs up to 2.12.2 are pinned to (lease watchdog self-update).
	UpdateFeedBase = "https://get.opfield.dev/gateway"
)
