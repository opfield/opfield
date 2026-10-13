package docker

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

// connectorRequest is a connector sync: every one names the daemon's address towards the connector as the only peer
// of its ingress listeners.
func (m *dockerSecureLinkManager) connectorRequest(ingress []securelink.BindingConfig, egress []securelink.EgressConfig) securelink.SyncRequest {
	return securelink.SyncRequest{Bindings: ingress, Egress: egress, IngressPeer: m.managementGateway}
}

// syncConnectorLocked sends ingress to the connector together with the egress listeners it already holds, which a
// sync of the ingress side therefore leaves as they are.
func (m *dockerSecureLinkManager) syncConnectorLocked(ctx context.Context, ingress []securelink.BindingConfig) (*securelink.SyncResponse, error) {
	egress, known := m.heldEgressLocked(ctx)
	response, err := securelink.Sync(ctx, m.socketPath, m.connectorRequest(ingress, egress))
	if err == nil {
		m.egress.ingressConfigs, m.egress.ingressFor = ingress, m.connectorID
		if !known {
			// The connector holds these now, whatever it held before.
			m.egress.configs, m.egress.configsFor = egress, m.connectorID
		}
	}
	return response, err
}

// heldEgressLocked returns the egress listeners the connector holds, for a sync of its ingress side: the ones this
// process sent it last (known), or, before this process synced the egress at all (its start, before the first egress
// reconcile), the ones the previous process left it. Those are rebuilt from the desired egress (the persisted grant
// bundle) and the anchor's endpoints on the link networks, without changing anything: a connector sync names every
// listener it keeps, and one without them would close them with every workload connection they carry, which the
// previous process handed over to this one (stand rc.7 F-1).
func (m *dockerSecureLinkManager) heldEgressLocked(ctx context.Context) (configs []securelink.EgressConfig, known bool) {
	if m.egress.configsFor == m.connectorID {
		return m.egress.configs, true
	}
	serving := m.egress.serving(time.Now())
	if len(serving) == 0 || m.connectorID == "" || m.plugin == nil || m.plugin.client == nil {
		return nil, false
	}
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.networkHolder(), mobyclient.ContainerInspectOptions{})
	if err != nil {
		if m.plugin.logger != nil {
			m.plugin.logger.Warn("could not read the secure-link connector's link networks; its egress listeners are set again", "error", err)
		}
		return nil, false
	}
	connectorNetworks := connectorNetworksOf(inspected.Container.NetworkSettings)
	ids := make([]string, 0, len(serving))
	for id := range serving {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		desired := serving[id]
		endpoint := connectorNetworks[desired.networkName]
		if endpoint == nil || !endpoint.IPAddress.IsValid() || !endpoint.IPAddress.Is4() {
			continue
		}
		info, cached := m.egress.networks[desired.networkName]
		if !cached || info.id != endpoint.NetworkID {
			linkNetwork, err := m.plugin.client.cli.NetworkInspect(ctx, desired.networkName, mobyclient.NetworkInspectOptions{})
			if err != nil {
				continue
			}
			if info, err = egressNetworkOf(linkNetwork.Network); err != nil || info.id != endpoint.NetworkID {
				continue
			}
			if m.egress.networks == nil {
				m.egress.networks = map[string]egressNetwork{}
			}
			m.egress.networks[desired.networkName] = info
		}
		if !info.prefix.Contains(endpoint.IPAddress) {
			continue
		}
		configs = append(configs, egressConfigFor(id, desired, endpoint.IPAddress, info.prefix))
	}
	return configs, false
}

// egressConfigFor is the connector's listener id of desired at address on a link network of prefix.
func egressConfigFor(id string, desired egressDesired, address netip.Addr, prefix netip.Prefix) securelink.EgressConfig {
	return securelink.EgressConfig{
		ID: id, OwnerKind: desired.ownerKind, Generation: desired.generation, ListenHost: address.String(),
		ListenPort: desired.listenPort, AllowedPrefix: prefix.String(), MaxSessions: desired.maxSessions,
		TLSCAPEM: desired.tlsCAPEM, TLSServerName: desired.tlsName,
	}
}

// releaseIngressLocked leaves the connector without ingress bindings. It is removed with its management network
// unless it serves egress (D5).
func (m *dockerSecureLinkManager) releaseIngressLocked(ctx context.Context) error {
	m.egress.ingressConfigs, m.egress.ingressNetworks = nil, nil
	if !m.egress.wanted() {
		return m.removeConnector(ctx)
	}
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.unbound = nil
	m.publishViewLocked()
	if m.connectorID != "" {
		if _, err := m.syncConnectorLocked(ctx, nil); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector did not take the release of its ingress bindings", "error", err)
		}
		// The target networks of the released bindings: the connector stays on its link networks only.
		for name := range m.attached {
			if m.egress.networkDesired(name) {
				continue
			}
			if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, name, mobyclient.NetworkDisconnectOptions{Container: m.networkHolder(), Force: true}); err != nil && !isNotFoundErr(err) {
				return fmt.Errorf("detach secure-link connector from %s: %w", name, err)
			}
			delete(m.attached, name)
		}
	}
	m.reconcileEgressLocked(ctx)
	return nil
}

// releaseIngress is releaseIngressLocked for the startup cleanup of an interrupted teardown.
func (m *dockerSecureLinkManager) releaseIngress(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.releaseIngressLocked(ctx)
}

// reconcileEgressLocked brings the connector's egress to the desired set: the connector exists while it has ingress
// or egress, joins each link network with the link's alias (its reserved address on a network of
// create_link_network), and listens on its address there. Every failure is the status of its own egress.
//
// It reports whether every desired egress listens on the current connector. Only then does a connector it replaced
// (pendingRetire) stop accepting and drain: until the replacement listens on every egress address, the previous one
// keeps taking the workloads' connections.
func (m *dockerSecureLinkManager) reconcileEgressLocked(ctx context.Context) bool {
	if m.plugin == nil || m.plugin.client == nil {
		return false
	}
	statuses := m.reconcileEgressStatusesLocked(ctx)
	// The previous connector stops accepting once the new one listens on every egress address the anchor holds (the
	// ones sent to it, orphans included): an egress waiting for its network or rejected listens on neither.
	ready := true
	for _, config := range m.egress.configs {
		if m.egress.configsFor != m.connectorID || statuses[config.ID].State != egressStateReady {
			ready = false
		}
	}
	// Orphans keep their listeners but are no longer Opfield's to hear about.
	for id := range statuses {
		_, desired := m.egress.desired[id]
		_, rejected := m.egress.rejected[id]
		if !desired && !rejected {
			delete(statuses, id)
		}
	}
	m.egress.publish(statuses)
	if m.pendingRetire != nil {
		// Availability first: while an egress does not listen on the replacement, the previous connector keeps
		// serving it, up to the retire limit.
		switch {
		case ready || time.Since(m.pendingRetireSince) >= secureLinkConnectorRetireLimit:
			if !ready && m.plugin.logger != nil {
				m.plugin.logger.Warn("the replaced secure-link connector stops accepting at the retire limit although an egress does not listen on the new one",
					"limit", secureLinkConnectorRetireLimit.String())
			}
			m.retirePendingLocked()
		default:
			if !m.pendingRetireLogged && m.plugin.logger != nil {
				m.pendingRetireLogged = true
				m.plugin.logger.Warn("the replaced secure-link connector keeps serving until every egress listens on the new one")
			}
			// Checked again shortly: it stops accepting as soon as the new one listens.
			m.scheduleEgressRetryLocked()
		}
	}
	return ready
}

// setPendingRetireLocked keeps a replaced connector accepting until every egress listens on its replacement. One still
// waiting from an earlier replacement stops accepting now and finishes its sessions: its successor was replaced too.
func (m *dockerSecureLinkManager) setPendingRetireLocked(previous connectorRuntime) {
	if m.pendingRetire != nil && m.pendingRetire.id != previous.id {
		m.retirePendingLocked()
	}
	m.pendingRetire = &previous
	m.pendingRetireSince, m.pendingRetireLogged = time.Now(), false
	// Recorded, so that a daemon start meanwhile counts its retirement from this replacement too (settleLeftoverLocked).
	if err := m.replaced.record(previous.id, m.pendingRetireSince.Add(secureLinkConnectorRetireLimit)); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not record the replaced secure-link connector", "error", err)
	}
}

// retirePendingLocked tells the replaced connector that kept accepting (pendingRetire) to drain. Its retirement counts
// from its replacement: it finishes its sessions until the retire limit after it was replaced, not after it stopped
// accepting.
func (m *dockerSecureLinkManager) retirePendingLocked() {
	m.retireConnectorUntil(*m.pendingRetire, m.pendingRetireSince.Add(secureLinkConnectorRetireLimit))
	m.clearPendingRetireLocked()
}

// clearPendingRetireLocked forgets pendingRetire, and every record of a replaced connector but the one still accepting.
func (m *dockerSecureLinkManager) clearPendingRetireLocked() {
	m.pendingRetire = nil
	m.forgetReplacedLocked()
}

// forgetReplacedLocked drops the records of replaced connectors other than pendingRetire: retired, removed, or settled
// at a daemon start.
func (m *dockerSecureLinkManager) forgetReplacedLocked() {
	var stale []string
	for id := range m.replaced.snapshot() {
		if m.pendingRetire == nil || m.pendingRetire.id != id {
			stale = append(stale, id)
		}
	}
	if err := m.replaced.forget(stale...); err != nil && m.plugin != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not record the end of a replaced secure-link connector's wait", "error", err)
	}
}

func (m *dockerSecureLinkManager) reconcileEgressStatusesLocked(ctx context.Context) map[string]egressStatus {
	statuses := map[string]egressStatus{}
	for id, status := range m.egress.rejected {
		statuses[id] = status
	}
	serving := m.egress.serving(time.Now())
	if len(serving) == 0 {
		m.dropEgressLocked(ctx)
		return statuses
	}
	pending := func(reason string) map[string]egressStatus {
		for id, desired := range serving {
			statuses[id] = egressStatus{State: egressStatePending, Error: reason, RouteGeneration: desired.generation, network: desired.networkName}
		}
		return statuses
	}
	connectorNetworks, _, replacement, err := m.egressConnectorLocked(ctx)
	if err != nil {
		return pending(err.Error())
	}
	ids := make([]string, 0, len(serving))
	for id := range serving {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	attached := map[string]egressNetwork{}
	warnings := map[string]string{}
	changed := false
	for _, id := range ids {
		desired := serving[id]
		result := m.attachEgressLocked(ctx, desired, connectorNetworks[desired.networkName])
		if result.err != nil {
			statuses[id] = egressStatus{State: result.state, Error: result.err.Error(), RouteGeneration: desired.generation, network: desired.networkName}
			continue
		}
		changed = changed || result.changed
		attached[id] = result.info
		if result.warning != "" {
			warnings[id] = result.warning
		}
	}
	if changed {
		reinspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.networkHolder(), mobyclient.ContainerInspectOptions{})
		if err != nil {
			if replacement != nil {
				m.abortReplacement(replacement)
			}
			return pending(fmt.Sprintf("inspect secure-link anchor: %v", err))
		}
		connectorNetworks = connectorNetworksOf(reinspected.Container.NetworkSettings)
	}
	configs := make([]securelink.EgressConfig, 0, len(attached))
	for _, id := range ids {
		info, ok := attached[id]
		if !ok {
			continue
		}
		desired := serving[id]
		endpoint := connectorNetworks[desired.networkName]
		if endpoint == nil || !endpoint.IPAddress.IsValid() || !endpoint.IPAddress.Is4() || !info.prefix.Contains(endpoint.IPAddress) {
			statuses[id] = egressStatus{State: egressStatePending, Error: "the connector has no address on the link network yet",
				RouteGeneration: desired.generation, network: desired.networkName}
			continue
		}
		m.recordEgressAddressLocked(desired.networkName, endpoint.IPAddress)
		configs = append(configs, egressConfigFor(id, desired, endpoint.IPAddress, info.prefix))
	}
	m.egress.configs, m.egress.configsFor = configs, m.connectorID
	ingress := m.egress.ingressConfigs
	if m.egress.ingressFor != m.connectorID {
		ingress = nil
	}
	response, err := securelink.Sync(ctx, m.socketPath, m.connectorRequest(ingress, configs))
	if replacement != nil {
		if response == nil || response.Version < securelink.ProtocolVersion {
			// The new connector took nothing: the previous one serves on as before.
			m.abortReplacement(replacement)
			m.egress.configsFor = m.connectorID
		} else {
			// Retired once every egress listens on the new connector too (reconcileEgressLocked).
			m.setPendingRetireLocked(replacement.previous)
		}
	}
	if replacement == nil && securelink.IsShuttingDown(err) && !m.abandoning {
		// The connector was told to drain: it never serves again. The egress (and the ingress, restored in the
		// background) goes to a new one at once.
		m.abandonDrainingConnectorLocked()
		m.abandoning = true
		defer func() { m.abandoning = false }()
		return m.reconcileEgressStatusesLocked(ctx)
	}
	if response == nil {
		for _, config := range configs {
			statuses[config.ID] = egressStatus{State: egressStateError, Error: fmt.Sprintf("secure-link connector sync: %v", err),
				RouteGeneration: config.Generation, network: serving[config.ID].networkName}
		}
		return statuses
	}
	if err != nil && m.egress.refusalLogged != m.connectorID {
		// The ingress bindings the connector holds were refused again; the next proxy secure-link sync deals with them.
		m.egress.refusalLogged = m.connectorID
		if m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector refused its ingress bindings during an egress sync", "error", err)
		}
	}
	m.recordEgressResponseLocked(response, configs, serving, statuses)
	// Served, but not as Opfield asked (a refused address, a rejoin that kept the previous endpoint): the egress
	// listens, and its status says what was not done.
	for id, warning := range warnings {
		if status, ok := statuses[id]; ok && status.Error == "" {
			status.Error = warning
			statuses[id] = status
		}
	}
	m.detachStaleEgressNetworksLocked(ctx, connectorNetworks)
	return statuses
}

// recordEgressResponseLocked turns the connector's answer into statuses.
func (m *dockerSecureLinkManager) recordEgressResponseLocked(response *securelink.SyncResponse, configs []securelink.EgressConfig, serving map[string]egressDesired, statuses map[string]egressStatus) {
	answered := make(map[string]securelink.EgressStatus, len(response.Egress))
	for _, status := range response.Egress {
		answered[status.ID] = status
	}
	for _, config := range configs {
		networkName := serving[config.ID].networkName
		status := egressStatus{RouteGeneration: config.Generation, network: networkName}
		answer, ok := answered[config.ID]
		switch {
		case response.Version < securelink.ProtocolVersion:
			status.State, status.Error = egressStateError, "the secure-link connector image does not serve egress: it needs the connector image of this Opfield release"
		case !ok:
			status.State, status.Error = egressStateError, "the secure-link connector did not report the egress listener"
		case answer.State == securelink.EgressListening && answer.Generation == config.Generation:
			status.State, status.Address, status.Port = egressStateReady, config.ListenHost, config.ListenPort
		default:
			status.State, status.Error = egressStateError, answer.Error
			if status.Error == "" {
				status.Error = "the secure-link connector did not listen for the egress"
			}
		}
		statuses[config.ID] = status
	}
}

// egressConnectorLocked brings the connector and its anchor up for the egress and returns the anchor's networks, the
// connector's image, and the replacement it started for another egress image (a node without ingress), which the
// caller retires once the egress listens on the new connector. With ingress, the proxy secure-link sync owns the
// image: the running connector keeps its own.
func (m *dockerSecureLinkManager) egressConnectorLocked(ctx context.Context) (map[string]*network.EndpointSettings, string, *connectorReplacement, error) {
	ingress := m.ingressWantedLocked()
	var running *container.InspectResponse
	if m.connectorID != "" {
		inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.connectorID, mobyclient.ContainerInspectOptions{})
		if err != nil && !isNotFoundErr(err) {
			return nil, "", nil, fmt.Errorf("inspect secure-link connector: %w", err)
		}
		if err == nil && inspected.Container.State != nil && inspected.Container.State.Running {
			running = &inspected.Container
		}
	}
	image := m.egressImageLocked()
	if running != nil && (ingress || image == "") {
		image = connectorImageOf(*running)
	}
	if image == "" {
		return nil, "", nil, errors.New("no secure-link connector image is known on this node yet")
	}
	if ingress && running != nil {
		// The proxy secure-link sync owns the connector of a node with ingress (its image, its replacement).
		if m.anchorID == "" {
			return nil, "", nil, errors.New(connectorImageTooOld)
		}
		networks, err := m.anchorNetworks(ctx)
		if err != nil {
			return nil, "", nil, err
		}
		return networks, image, nil, nil
	}
	// A replacement this sync would not keep is not started: the ingress bindings of a node with ingress must move with
	// it (the next proxy secure-link sync replaces it), and the egress needs an image with the anchor. Starting it could
	// cut a retiring connector for nothing.
	supported, err := m.anchorSupported(ctx, image)
	if err != nil {
		return nil, "", nil, fmt.Errorf("start the secure-link connector: %w", err)
	}
	replacement, err := m.ensureConnector(ctx, image, !ingress && supported)
	if err != nil {
		return nil, "", nil, fmt.Errorf("start the secure-link connector: %w", err)
	}
	if ingress && (running == nil || running.ID != m.connectorID) {
		// A connector started here holds none of the ingress bindings: bind them again once this sync is done.
		go func() { _ = m.restoreBindingsCoalesced(true) }()
	}
	if m.anchorID == "" {
		// Opfield still sends the connector image of an earlier release: the connector serves ingress in its own
		// namespace, and the egress waits for an image with the anchor.
		return nil, "", nil, errors.New(connectorImageTooOld)
	}
	networks, err := m.anchorNetworks(ctx)
	if err != nil {
		if replacement != nil {
			m.abortReplacement(replacement)
		}
		return nil, "", nil, err
	}
	return networks, image, replacement, nil
}

func connectorImageOf(inspect container.InspectResponse) string {
	if inspect.Config == nil {
		return ""
	}
	return inspect.Config.Image
}

func connectorNetworksOf(settings *container.NetworkSettings) map[string]*network.EndpointSettings {
	if settings == nil || settings.Networks == nil {
		return map[string]*network.EndpointSettings{}
	}
	return settings.Networks
}

// egressNetworkOf checks a link network and reads its subnet and the connector's reserved address on it.
func egressNetworkOf(inspected network.Inspect) (egressNetwork, error) {
	if inspected.ID == "" || inspected.Driver != "bridge" || inspected.Ingress || inspected.ConfigOnly {
		return egressNetwork{}, errors.New("the link network is not a dedicated bridge network")
	}
	info := egressNetwork{id: inspected.ID}
	for _, config := range inspected.IPAM.Config {
		if config.Subnet.IsValid() && config.Subnet.Addr().Is4() {
			info.prefix = config.Subnet.Masked()
			break
		}
	}
	if !info.prefix.IsValid() {
		return egressNetwork{}, errors.New("the link network has no IPv4 subnet")
	}
	if reserved, ok := linkNetworkReservedAddress(inspected); ok {
		info.reserved, info.userSubnet = reserved, true
	}
	for _, config := range inspected.IPAM.Config {
		if config.IPRange.IsValid() || len(config.AuxAddress) > 0 {
			info.userSubnet = true
		}
	}
	return info, nil
}

func endpointHasAlias(endpoint *network.EndpointSettings, alias string) bool {
	for _, name := range append(append([]string(nil), endpoint.Aliases...), endpoint.DNSNames...) {
		if name == alias {
			return true
		}
	}
	return false
}

// dropEgressLocked removes every egress listener; the connector goes when it serves nothing else.
func (m *dockerSecureLinkManager) dropEgressLocked(ctx context.Context) {
	hadEgress := len(m.egress.configs) > 0 && m.egress.configsFor == m.connectorID
	m.egress.configs, m.egress.configsFor = nil, ""
	if m.connectorID == "" {
		return
	}
	if !m.ingressWantedLocked() {
		if err := m.removeConnector(ctx); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("could not remove the secure-link connector without links", "error", err)
		}
		return
	}
	if hadEgress {
		ingress := m.egress.ingressConfigs
		if m.egress.ingressFor != m.connectorID {
			ingress = nil
		}
		if _, err := securelink.Sync(ctx, m.socketPath, m.connectorRequest(ingress, nil)); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector did not take the removal of its egress listeners", "error", err)
		}
	}
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.networkHolder(), mobyclient.ContainerInspectOptions{})
	if err == nil && inspected.Container.NetworkSettings != nil {
		m.detachStaleEgressNetworksLocked(ctx, inspected.Container.NetworkSettings.Networks)
	}
}

// detachStaleEgressNetworksLocked detaches the connector from the link networks no egress and no ingress binding
// uses any more.
func (m *dockerSecureLinkManager) detachStaleEgressNetworksLocked(ctx context.Context, connectorNetworks map[string]*network.EndpointSettings) {
	for name := range connectorNetworks {
		if !isEgressLinkNetwork(name) || m.egress.networkDesired(name) {
			continue
		}
		if _, ingress := m.egress.ingressNetworks[name]; ingress {
			continue
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, name, mobyclient.NetworkDisconnectOptions{Container: m.networkHolder(), Force: true}); err != nil && !isNotFoundErr(err) {
			if m.plugin.logger != nil {
				m.plugin.logger.Warn("could not detach the secure-link connector from a link network it no longer serves", "network", name, "error", err)
			}
			continue
		}
		delete(m.attached, name)
		delete(m.egress.networks, name)
		m.recordEgressAddressLocked(name, netip.Addr{})
	}
}
