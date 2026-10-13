package docker

import (
	"context"
	"regexp"
	"strings"
	"sync"

	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// Names of the Docker objects created for Opfield on a node.
//
// Objects created from 2.12.1 on carry Opfield names. Docker cannot rename a
// network in place, and renaming a container would cut what it serves, so an
// object created before keeps its name for its whole life; every reader here
// accepts both families.
//
//   - Link networks, link connectors and their Compose network keys are named
//     by Opfield and stored on its rows. Opfield uses the Opfield names only for
//     nodes whose daemon advertises opfieldNamesCapability; a daemon before it
//     accepts only the earlier names.
//   - The objects the daemon names itself (the shared Secure Link connector,
//     its anchor and network, managed database containers, Keeper witnesses)
//     get the Opfield names only when the launcher can no longer roll this
//     start back to a daemon that knows only the earlier names: at once
//     without a pending update, else once the start is confirmed. The
//     capability is advertised from the same moment (an update candidate
//     registers again when it is confirmed).
const opfieldNamesCapability = "docker_opfield_names_v1"

// opfieldLabelsCapability tells Opfield that this daemon reads both label
// namespaces, so the labels Opfield sends for new objects use the net.opfield.
// keys. It follows opfieldNamesCapability: a daemon the launcher can still
// roll back to an earlier release keeps getting the earlier keys.
const opfieldLabelsCapability = "opfield_labels_v1"

// opfieldNamesActive reports whether new objects get the Opfield names now (a
// variable for tests).
var opfieldNamesActive = func() bool { return !lifecycle.UpdateCandidate() }

// registeredOpfieldNames records, per plugin, whether its last registration advertised opfieldNamesCapability.
var registeredOpfieldNames sync.Map // *DockerPlugin -> bool

// opfieldNamesCapabilities returns the capability while new objects get the Opfield names, and records what the
// registration advertises.
func (p *DockerPlugin) opfieldNamesCapabilities() []string {
	active := opfieldNamesActive()
	registeredOpfieldNames.Store(p, active)
	if active {
		return []string{opfieldNamesCapability, opfieldLabelsCapability}
	}
	return nil
}

// registerOpfieldNamesOnConfirmedStart registers the node again once its start is confirmed, when its registration
// did not advertise opfieldNamesCapability yet.
func (p *DockerPlugin) registerOpfieldNamesOnConfirmedStart() {
	lifecycle.OnStartConfirmed(func() {
		if advertised, _ := registeredOpfieldNames.Load(p); advertised != true {
			p.signalRegistrationChanged()
		}
	})
}

const (
	databaseLinkNetworkPrefix  = "opfield-db-"
	storageLinkNetworkPrefix   = "opfield-storage-"
	containerLinkNetworkPrefix = "opfield-link-"
	storageConnectorPrefix     = "opfield-storage-connector-"
)

// legacy-name: gateway-db-/gateway-storage-/gateway-link- networks and gateway-storage-connector- containers of links
// created before 2.12.1 or for a node without docker_opfield_names_v1 — remove once every node reports none
const (
	legacyDatabaseLinkNetworkPrefix  = "gateway-db-"
	legacyStorageLinkNetworkPrefix   = "gateway-storage-"
	legacyContainerLinkNetworkPrefix = "gateway-link-"
	legacyStorageConnectorPrefix     = "gateway-storage-connector-"
)

var (
	// legacy-name: gateway-db-* link networks (see legacyDatabaseLinkNetworkPrefix) — remove once every node reports none
	databaseLinkNetworkPattern = regexp.MustCompile(`^(?:opfield|gateway)-db-(?:av-)?[0-9a-f]{16}$`)
	// legacy-name: gateway-link-* link networks (see legacyContainerLinkNetworkPrefix) — remove once every node reports none
	containerLinkNetworkPattern = regexp.MustCompile(`^(?:opfield|gateway)-link-(?:av-)?[0-9a-f]{16}$`)
	// Storage link networks (16 hex) and managed storage cluster networks (the cluster id).
	// legacy-name: gateway-storage-* networks (see legacyStorageLinkNetworkPrefix) — remove once every node reports none
	storageBindingNetworkNamePattern = regexp.MustCompile(`^(?:opfield|gateway)-storage-(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
	// The logical networks Opfield adds to a Compose project for a managed database link and for a container link
	// whose source is one of its services (compose-managed-bindings.ts, compose-container-links.ts); each names the
	// link's network as external.
	// legacy-name: gateway_db_/gateway_link_ keys of links created before 2.12.1 — remove once every node reports none
	composeManagedDatabaseNetworkKey = regexp.MustCompile(`^(?:opfield|gateway)_db_[0-9a-f]{16}$`)
	// legacy-name: gateway_link_ keys (see composeManagedDatabaseNetworkKey) — remove once every node reports none
	composeContainerLinkNetworkKey = regexp.MustCompile(`^(?:opfield|gateway)_link_[0-9a-f]{16}$`)
)

// isDatabaseLinkNetworkName reports a managed database link network (either family, any suffix).
func isDatabaseLinkNetworkName(name string) bool {
	_, ok := databaseLinkNetworkSuffix(name)
	return ok
}

// databaseLinkNetworkSuffix is what follows the managed database link network prefix ("<16 hex>" or "av-<16 hex>").
func databaseLinkNetworkSuffix(name string) (string, bool) {
	if suffix, ok := strings.CutPrefix(name, databaseLinkNetworkPrefix); ok {
		return suffix, true
	}
	return strings.CutPrefix(name, legacyDatabaseLinkNetworkPrefix)
}

// isStorageNetworkName reports a managed storage link or cluster network (either family, by prefix).
func isStorageNetworkName(name string) bool {
	return strings.HasPrefix(name, storageLinkNetworkPrefix) || strings.HasPrefix(name, legacyStorageLinkNetworkPrefix)
}

// isContainerLinkNetworkName reports a container link network (either family, by prefix).
func isContainerLinkNetworkName(name string) bool {
	return strings.HasPrefix(name, containerLinkNetworkPrefix) || strings.HasPrefix(name, legacyContainerLinkNetworkPrefix)
}

// storageConnectorBindingID is the binding id a storage link connector's name carries.
func storageConnectorBindingID(name string) (string, bool) {
	if id, ok := strings.CutPrefix(name, storageConnectorPrefix); ok {
		return id, true
	}
	return strings.CutPrefix(name, legacyStorageConnectorPrefix)
}

// secureLinkNames are the names of the node's shared Secure Link objects: the connector (with its -next and -third
// slots), the anchor that holds its endpoints, and the management network.
type secureLinkNames struct {
	connector string
	anchor    string
	network   string
}

var opfieldSecureLinkNames = secureLinkNames{
	connector: "opfield-secure-link-connector",
	anchor:    "opfield-secure-link-anchor",
	network:   "opfield-secure-links",
}

// legacy-name: the Secure Link connector, anchor and network of nodes that ran them before 2.12.1 — remove once every
// node reports none
var legacySecureLinkNames = secureLinkNames{
	connector: "gateway-secure-link-connector",
	anchor:    "gateway-secure-link-anchor",
	network:   "gateway-secure-links",
}

// secureLinkNameFamilies are both families, Opfield first.
var secureLinkNameFamilies = [...]secureLinkNames{opfieldSecureLinkNames, legacySecureLinkNames}

// isSecureLinkManagementNetwork reports the Secure Link management network of either family.
func isSecureLinkManagementNetwork(name string) bool {
	return name == opfieldSecureLinkNames.network || name == legacySecureLinkNames.network
}

// isSecureLinkAnchorName reports the Secure Link anchor of either family.
func isSecureLinkAnchorName(name string) bool {
	return name == opfieldSecureLinkNames.anchor || name == legacySecureLinkNames.anchor
}

// secureLinkNamesState is the family the node's shared Secure Link objects use, settled once one of them exists.
type secureLinkNamesState struct {
	mu      sync.Mutex
	settled bool
	names   secureLinkNames
}

var secureLinkNamesByPlugin sync.Map // *DockerPlugin -> *secureLinkNamesState

// secureLinkNames returns the family of the node's shared Secure Link objects: the one an existing object of them
// carries (the management network, the anchor or a connector slot), else the Opfield family once the start is
// confirmed, else the earlier one. A node keeps the family of what it runs, so its connector, anchor and network
// always share one family and the connector's slots take turns as before.
func (p *DockerPlugin) secureLinkNames(ctx context.Context) secureLinkNames {
	value, _ := secureLinkNamesByPlugin.LoadOrStore(p, &secureLinkNamesState{})
	state := value.(*secureLinkNamesState)
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.settled {
		return state.names
	}
	if p != nil && p.client != nil && p.client.cli != nil {
		for _, family := range secureLinkNameFamilies {
			if secureLinkFamilyPresent(ctx, p.client.cli, family) {
				state.settled, state.names = true, family
				return family
			}
		}
	}
	if opfieldNamesActive() {
		state.settled, state.names = true, opfieldSecureLinkNames
		return opfieldSecureLinkNames
	}
	return legacySecureLinkNames
}

// secureLinkFamilyPresent reports whether any object of the family exists on the node.
func secureLinkFamilyPresent(ctx context.Context, cli *mobyclient.Client, family secureLinkNames) bool {
	if _, err := cli.NetworkInspect(ctx, family.network, mobyclient.NetworkInspectOptions{}); err == nil {
		return true
	}
	for _, name := range append([]string{family.anchor}, secureLinkConnectorSlotNames(family)...) {
		if _, err := cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{}); err == nil {
			return true
		}
	}
	return false
}

// secureLinkConnectorSlotNames are the connector slot names of a family (see secureLinkConnectorSockets).
func secureLinkConnectorSlotNames(family secureLinkNames) []string {
	return []string{family.connector, family.connector + "-next", family.connector + "-third"}
}

// managedDatabaseContainerPrefix is the prefix of a new managed database's container and network.
func managedDatabaseContainerPrefix() string {
	if opfieldNamesActive() {
		return "opfdb-"
	}
	return legacyManagedDatabaseContainerPrefix
}

// legacy-name: gwdb-<id> containers and gwdb-<id>-net networks of managed databases created before 2.12.1 — remove
// once every node reports none
const legacyManagedDatabaseContainerPrefix = "gwdb-"

// managedDatabaseContainerNames are the names a managed database's container may carry (Opfield first).
func managedDatabaseContainerNames(id string) []string {
	return []string{"opfdb-" + id, legacyManagedDatabaseContainerPrefix + id}
}

// keeperWitnessNames are the names a Keeper witness container may carry (Opfield first); its network is the name
// with -net.
func keeperWitnessNames(id string) []string {
	return []string{"opfkw-" + id, legacyKeeperWitnessPrefix + id}
}

// legacy-name: gwkw-<id> Keeper witness containers created before 2.12.1 — remove once every node reports none
const legacyKeeperWitnessPrefix = "gwkw-"

// Managed storage containers (<prefix><id>-<member>, with -master and -volume beside the filer of a set member) and
// the network of a single-node instance (<prefix><id>) carry the prefix of the record that created them.
const managedStorageNamePrefix = "opfield-storage-"

// legacy-name: gateway-storage-<id>-<member>[-<role>] containers and gateway-storage-<id> networks of managed storage
// created before 2.12.1 — remove once every node reports none
const legacyManagedStorageNamePrefix = "gateway-storage-"

// managedStorageNamePrefixes are the prefixes a managed storage instance's names may carry (Opfield first).
var managedStorageNamePrefixes = [...]string{managedStorageNamePrefix, legacyManagedStorageNamePrefix}

// newManagedStorageNamePrefix is the prefix of a new managed storage instance's names.
func newManagedStorageNamePrefix() string {
	if opfieldNamesActive() {
		return managedStorageNamePrefix
	}
	return legacyManagedStorageNamePrefix
}

// namePrefix is the prefix of the instance's names: the one its container carries.
func (record managedStorageRecord) namePrefix() string {
	if strings.HasPrefix(record.ContainerName, managedStorageNamePrefix) {
		return managedStorageNamePrefix
	}
	return legacyManagedStorageNamePrefix
}
