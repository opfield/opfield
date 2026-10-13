package docker

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

// The connector's egress side (D2-D5): a workload of this node reaches a link's target (managed storage, a managed
// database, another container) through an alias on the link's network that names the shared connector. The desired
// listeners come with the signed connect assignments of the relay grant bundle, never with the proxy secure-link
// sync or its state files: daemons of earlier releases reject that whole state when it holds anything but targets.
// The secure-link manager is the one owner of the connector sync and sends ingress and egress together.

const (
	containerLinkOwnerKind = "container_link"
	// secureLinkEgressCapability: the node serves egress listeners on its shared connector, container links and the
	// link networks of create_link_network (C7).
	secureLinkEgressCapability = "secure_link_egress_v1"
	secureLinkEgressTimeout    = 45 * time.Second
)

// Egress states reported to Opfield (C2).
const (
	egressStateReady   = "ready"
	egressStatePending = "pending"
	egressStateError   = "error"
)

var (
	egressAliasPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
)

// egressNetworkPattern is the network an egress of ownerKind may use (nil: the kind has no egress).
func egressNetworkPattern(ownerKind string) *regexp.Regexp {
	switch ownerKind {
	case storageBindingOwnerKind:
		return storageBindingNetworkNamePattern
	case linkKindManagedDatabaseBinding:
		return databaseLinkNetworkPattern
	case containerLinkOwnerKind:
		return containerLinkNetworkPattern
	}
	return nil
}

// isEgressLinkNetwork reports a network name the connector joins for egress only.
func isEgressLinkNetwork(name string) bool {
	return storageBindingNetworkNamePattern.MatchString(name) || databaseLinkNetworkPattern.MatchString(name) ||
		containerLinkNetworkPattern.MatchString(name)
}

// egressDesired is one egress listener a connect assignment asks for.
type egressDesired struct {
	id, ownerKind      string
	generation         uint64
	networkName, alias string
	listenPort         uint16
	maxSessions        int
	tlsCAPEM, tlsName  string
	image              string
	// aliasDisabled: listen without the DNS alias yet; connectorAddress: the connector's address on the network.
	aliasDisabled    bool
	connectorAddress netip.Addr
}

// egressStatus is what Opfield hears of one egress (SyncRelayGrants ACK, egressStatuses).
type egressStatus struct {
	State           string `json:"state"`
	Address         string `json:"address,omitempty"`
	Port            uint16 `json:"port,omitempty"`
	Error           string `json:"error,omitempty"`
	RouteGeneration uint64 `json:"routeGeneration"`
	network         string
}

// egressNetwork is what the connector knows of a link network: its id, IPv4 subnet, and the connector's static
// address on it (a network of create_link_network) or none (a network created before, where Docker assigns one).
type egressNetwork struct {
	id       string
	prefix   netip.Prefix
	reserved netip.Addr
	// userSubnet: the network was created with its own IPAM configuration, the only kind Docker attaches a container
	// to at a chosen address. A network of Docker's default pools shows its subnet in the inspect as well, so only
	// the pool's networks (create_link_network) and an IP range tell them apart.
	userSubnet bool
}

type secureLinkEgress struct {
	desired  map[string]egressDesired
	rejected map[string]egressStatus
	// orphans left the bundle without a successor on their socket yet (secure_link_egress_runner.go): the connector
	// keeps their listeners, and the connections they carry, for egressSuccessorWait.
	orphans map[string]egressOrphan
	// configs were last sent to the connector configsFor; ingress likewise.
	configs        []securelink.EgressConfig
	configsFor     string
	ingressConfigs []securelink.BindingConfig
	ingressFor     string
	// refusalLogged is the connector whose refusal of its ingress bindings during an egress sync was logged: once
	// per connector, not on every sync.
	refusalLogged string
	// ingressNetworks are the target networks the last apply attached the connector to.
	ingressNetworks map[string]struct{}
	networks        map[string]egressNetwork
	// addresses are the connector's addresses on the link networks (secure_link_egress_attach.go), kept in
	// addressFile; retryScheduled is set while a reconcile waits for an address still in use.
	addresses      map[string]netip.Addr
	addressFile    string
	retryScheduled bool

	// The published statuses: the ACK and the ExtraHosts rule read them without waiting for a sync.
	viewMu    sync.RWMutex
	statuses  map[string]egressStatus
	listening map[string]bool
}

func (e *secureLinkEgress) wanted() bool { return len(e.serving(time.Now())) > 0 }

// serving is what the connector listens for: the desired egress and the orphans still waiting for a successor.
func (e *secureLinkEgress) serving(now time.Time) map[string]egressDesired {
	serving := make(map[string]egressDesired, len(e.desired)+len(e.orphans))
	for id, orphan := range e.orphans {
		if now.Before(orphan.until) {
			serving[id] = orphan.desired
		}
	}
	for id, desired := range e.desired {
		serving[id] = desired
	}
	return serving
}

func (e *secureLinkEgress) networkDesired(name string) bool {
	for _, desired := range e.serving(time.Now()) {
		if desired.networkName == name {
			return true
		}
	}
	return false
}

func (e *secureLinkEgress) publish(statuses map[string]egressStatus) {
	listening := map[string]bool{}
	for _, status := range statuses {
		if status.State == egressStateReady {
			listening[status.network] = true
		}
	}
	e.viewMu.Lock()
	e.statuses, e.listening = statuses, listening
	e.viewMu.Unlock()
}

// currentStatuses returns a copy of the published statuses.
func (e *secureLinkEgress) currentStatuses() map[string]egressStatus {
	e.viewMu.RLock()
	defer e.viewMu.RUnlock()
	statuses := make(map[string]egressStatus, len(e.statuses))
	for id, status := range e.statuses {
		statuses[id] = status
	}
	return statuses
}

// listeningOn reports a network where an egress listens: its workloads resolve the link alias through Docker's DNS
// to the connector, and the daemon gives them no ExtraHosts entry for it (C6).
func (e *secureLinkEgress) listeningOn(networkName string) bool {
	e.viewMu.RLock()
	defer e.viewMu.RUnlock()
	return e.listening[networkName]
}

// desiredEgressFromBundle reads the egress listeners of a grant bundle. A malformed one is reported as an error and
// served by nothing; the others are unaffected.
func desiredEgressFromBundle(bundle *pb.SyncRelayGrantsCommand) (map[string]egressDesired, map[string]egressStatus) {
	desired := map[string]egressDesired{}
	rejected := map[string]egressStatus{}
	for _, assignment := range bundle.GetGrants() {
		egress := assignment.GetSecureLinkEgress()
		if assignment.GetRole() != "connect" || egress == nil {
			continue
		}
		id := assignment.GetOwnerId()
		config, err := egressFromAssignment(assignment)
		if err != nil {
			rejected[id] = egressStatus{State: egressStateError, Error: err.Error(), RouteGeneration: egress.GetRouteGeneration(), network: egress.GetNetworkName()}
			continue
		}
		if _, duplicate := desired[id]; duplicate {
			delete(desired, id)
			rejected[id] = egressStatus{State: egressStateError, Error: "duplicate secure-link egress", RouteGeneration: config.generation}
			continue
		}
		if _, refused := rejected[id]; refused {
			continue
		}
		desired[id] = config
	}
	return desired, rejected
}

func egressFromAssignment(assignment *pb.RelayGrantAssignment) (egressDesired, error) {
	egress := assignment.GetSecureLinkEgress()
	kind := assignment.GetOwnerKind()
	pattern := egressNetworkPattern(kind)
	switch {
	case pattern == nil:
		return egressDesired{}, fmt.Errorf("secure-link egress is not supported for %s", kind)
	case !proxySecureLinkIDPattern.MatchString(assignment.GetOwnerId()):
		return egressDesired{}, errors.New("secure-link egress owner id is invalid")
	case !pattern.MatchString(egress.GetNetworkName()):
		return egressDesired{}, errors.New("secure-link egress network is invalid")
	case !egressAliasPattern.MatchString(egress.GetAlias()):
		return egressDesired{}, errors.New("secure-link egress alias is invalid")
	case egress.GetListenPort() == 0 || egress.GetListenPort() > 65535:
		return egressDesired{}, errors.New("secure-link egress port is invalid")
	case egress.GetRouteGeneration() == 0:
		return egressDesired{}, errors.New("secure-link egress route generation is required")
	case egress.GetMaxSessions() > 1<<20:
		return egressDesired{}, errors.New("secure-link egress session limit is invalid")
	case (egress.GetTlsCaPem() == "") != (egress.GetTlsServerName() == ""):
		return egressDesired{}, errors.New("secure-link egress TLS needs both a CA and a server name")
	case egress.GetConnectorImage() != "" && !allowedSecureLinkConnectorImage(egress.GetConnectorImage()):
		return egressDesired{}, errors.New("secure-link egress connector image is not an allowed image")
	case assignment.GetGrant() == nil && len(relaybridge.PoolCandidates(assignment, false)) == 0:
		return egressDesired{}, errors.New("secure-link egress relay grant is unavailable")
	}
	var connectorAddress netip.Addr
	if value := egress.GetConnectorAddress(); value != "" {
		address, err := netip.ParseAddr(value)
		if err != nil || !address.Is4() || address.IsUnspecified() || address.IsLoopback() || address.IsMulticast() {
			return egressDesired{}, errors.New("secure-link egress connector address is invalid")
		}
		connectorAddress = address
	}
	return egressDesired{
		aliasDisabled: egress.GetAliasDisabled(), connectorAddress: connectorAddress,
		id: assignment.GetOwnerId(), ownerKind: kind, generation: egress.GetRouteGeneration(),
		networkName: egress.GetNetworkName(), alias: egress.GetAlias(), listenPort: uint16(egress.GetListenPort()),
		maxSessions: int(egress.GetMaxSessions()), tlsCAPEM: egress.GetTlsCaPem(), tlsName: egress.GetTlsServerName(),
		image: egress.GetConnectorImage(),
	}, nil
}

// databaseLinkOnConnector reports a database link network whose binding Opfield moved to the connector: its connect
// grant carries an egress on that network and either no host listener, or a host listener only for the consumers
// not moved yet with consumers_use_alias set (desired state, F4, S1). Its consumers resolve the link alias through
// Docker's DNS and get no ExtraHosts entry; a binding still only on the host listener keeps the entry.
func (p *DockerPlugin) databaseLinkOnConnector(networkName string) bool {
	if p.relayGrants == nil {
		return false
	}
	onConnector := false
	p.relayGrants.withCurrent(func(bundle *pb.SyncRelayGrantsCommand) {
		onConnector = databaseLinkOnConnectorIn(bundle, networkName)
	})
	return onConnector
}

func databaseLinkOnConnectorIn(bundle *pb.SyncRelayGrantsCommand, networkName string) bool {
	for _, assignment := range bundle.GetGrants() {
		egress := assignment.GetSecureLinkEgress()
		// During a migration the grant keeps the host listener for the consumers not moved yet, and marks the ones
		// recreated from now on as moved (consumers_use_alias).
		if assignment.GetRole() == "connect" && assignment.GetOwnerKind() == linkKindManagedDatabaseBinding && egress != nil &&
			egress.GetNetworkName() == networkName && (assignment.GetManagedDatabaseListener() == nil || egress.GetConsumersUseAlias()) {
			return true
		}
	}
	return false
}

// setDesiredEgress records the egress of bundle without touching the connector (the startup restore applies it).
func (m *dockerSecureLinkManager) setDesiredEgress(bundle *pb.SyncRelayGrantsCommand) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.egress.desired, m.egress.rejected = desiredEgressFromBundle(bundle)
}

// resyncEgress applies the recorded egress again (a connector that restarted lost its listeners).
func (m *dockerSecureLinkManager) resyncEgress() {
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), secureLinkEgressTimeout)
	defer cancel()
	m.reconcileEgressLocked(ctx)
}

// ingressWantedLocked reports committed ingress bindings: the connector serves or will serve them.
func (m *dockerSecureLinkManager) ingressWantedLocked() bool {
	if len(m.bindings) > 0 || len(m.unbound) > 0 {
		return true
	}
	return m.plugin != nil && m.plugin.secureLinkState != nil && len(m.plugin.secureLinkState.Get().Bindings) > 0
}

// egressImageLocked is the image a connector started for egress runs: the committed ingress image (the next sync
// would replace any other), else the one the egress assignments name.
func (m *dockerSecureLinkManager) egressImageLocked() string {
	if m.plugin != nil && m.plugin.secureLinkState != nil {
		if bindings := m.plugin.secureLinkState.Get().Bindings; len(bindings) > 0 && allowedSecureLinkConnectorImage(bindings[0].ConnectorImage) {
			return bindings[0].ConnectorImage
		}
	}
	ids := make([]string, 0, len(m.egress.desired))
	for id := range m.egress.desired {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if image := m.egress.desired[id].image; image != "" {
			return image
		}
	}
	return ""
}
