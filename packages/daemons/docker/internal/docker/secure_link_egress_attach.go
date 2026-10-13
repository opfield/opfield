package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/statecompat"
)

// The connector's address on a link network is kept: a client that resolved the link alias once (nginx with a
// static proxy_pass) keeps using that address. The address is, in this order, the one Gateway names
// (connector_address: a storage link takes the address its sidecar had), the pool's reserved base+2, or the address
// the connector got on that network the first time (recorded, so an anchor restart or recreate takes it back).
const (
	secureLinkAddressesFile = "secure-link-addresses.json"
)

// egressAddressRetry is how soon a reconcile tries again for an address still in use (a variable for tests).
var egressAddressRetry = 3 * time.Second

// errEgressAddressInUse: the address the connector must take is still held by another container (a sidecar being
// removed); the egress is pending and retried.
var errEgressAddressInUse = errors.New("the connector address on the link network is still in use")

// loadEgressAddresses reads the recorded addresses (network name to IPv4).
func (m *dockerSecureLinkManager) loadEgressAddresses(stateDir string) {
	m.egress.addressFile = filepath.Join(stateDir, secureLinkAddressesFile)
	data, err := os.ReadFile(m.egress.addressFile)
	if err != nil {
		return
	}
	var recorded map[string]string
	if json.Unmarshal(data, &recorded) != nil {
		return
	}
	m.egress.addresses = map[string]netip.Addr{}
	for name, value := range recorded {
		if address, err := netip.ParseAddr(value); err == nil && address.Is4() {
			m.egress.addresses[name] = address
		}
	}
}

// recordEgressAddressLocked keeps the connector's address on a network, or forgets it (invalid address).
func (m *dockerSecureLinkManager) recordEgressAddressLocked(networkName string, address netip.Addr) {
	if current, ok := m.egress.addresses[networkName]; (ok && current == address) || (!ok && !address.IsValid()) {
		return
	}
	if m.egress.addresses == nil {
		m.egress.addresses = map[string]netip.Addr{}
	}
	if address.IsValid() {
		m.egress.addresses[networkName] = address
	} else {
		delete(m.egress.addresses, networkName)
	}
	if m.egress.addressFile == "" {
		return
	}
	recorded := make(map[string]string, len(m.egress.addresses))
	for name, value := range m.egress.addresses {
		recorded[name] = value.String()
	}
	data, err := json.Marshal(recorded)
	if err == nil {
		err = statecompat.WriteAtomic(m.egress.addressFile, data)
	}
	if err != nil && m.plugin != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not record the secure-link connector addresses", "error", err)
	}
}

// wantedEgressAddress is the address the connector must have on the link network (invalid: any), and whether it is
// only the recorded one, which yields to another holder. Docker attaches at a chosen address only on a network with
// its own IPAM configuration: on one of the default pools the connector takes any address.
func (m *dockerSecureLinkManager) wantedEgressAddress(desired egressDesired, info egressNetwork) (netip.Addr, bool) {
	if !info.userSubnet {
		return netip.Addr{}, false
	}
	switch {
	case desired.connectorAddress.IsValid():
		return desired.connectorAddress, false
	case info.reserved.IsValid():
		return info.reserved, false
	}
	recorded, ok := m.egress.addresses[desired.networkName]
	if ok && info.prefix.Contains(recorded) {
		return recorded, true
	}
	return netip.Addr{}, false
}

// egressAttach is the outcome of attaching the connector to one link network. With err the egress is not served
// there; a warning is an error the egress reports while it is served (a refused address, a failed rejoin that put
// the previous endpoint back).
type egressAttach struct {
	info    egressNetwork
	changed bool
	state   string
	err     error
	warning string
}

// attachEgressLocked joins the connector to the link network at its wanted address, with the link's alias unless
// Gateway holds it back. A desired network the connector is not on is joined again (self-heal). A rejoin never leaves
// the connector off the network: when the new endpoint is refused, the previous one is put back.
func (m *dockerSecureLinkManager) attachEgressLocked(ctx context.Context, desired egressDesired, endpoint *network.EndpointSettings) egressAttach {
	info, known := m.egress.networks[desired.networkName]
	if !known || endpoint == nil || endpoint.NetworkID != info.id {
		inspected, err := m.plugin.client.cli.NetworkInspect(ctx, desired.networkName, mobyclient.NetworkInspectOptions{})
		if isNotFoundErr(err) {
			return egressAttach{state: egressStatePending, err: errors.New("the link network does not exist yet")}
		}
		if err != nil {
			return egressAttach{state: egressStatePending, err: fmt.Errorf("inspect the link network: %w", err)}
		}
		if info, err = egressNetworkOf(inspected.Network); err != nil {
			return egressAttach{state: egressStateError, err: err}
		}
		if m.egress.networks == nil {
			m.egress.networks = map[string]egressNetwork{}
		}
		m.egress.networks[desired.networkName] = info
		if known && endpoint != nil && endpoint.NetworkID != info.id {
			// The network was created again under the same name: the endpoint belongs to the removed one.
			endpoint = nil
		}
	}
	result := egressAttach{info: info}
	if desired.connectorAddress.IsValid() && !info.userSubnet {
		result.warning = fmt.Sprintf("connector address %s refused: the link network has no subnet of its own (one of Docker's default pools), "+
			"where Docker attaches at no chosen address", desired.connectorAddress)
	}
	want, onlyRecorded := m.wantedEgressAddress(desired, info)
	if want.IsValid() && !info.prefix.Contains(want) {
		return egressAttach{state: egressStateError, err: fmt.Errorf("the connector address %s is outside the link network", want)}
	}
	attachedRight := endpoint != nil && endpoint.NetworkID == info.id && endpointHasAlias(endpoint, desired.alias) != desired.aliasDisabled
	if attachedRight && (!want.IsValid() || endpoint.IPAddress == want) {
		return result
	}
	if want.IsValid() {
		taken, err := m.takeEgressAddressLocked(ctx, desired.networkName, want)
		switch {
		case err != nil:
			return egressAttach{state: egressStateError, err: err}
		case taken && onlyRecorded:
			// Another container got the recorded address meanwhile: the connector keeps or takes a new one.
			m.recordEgressAddressLocked(desired.networkName, netip.Addr{})
			if attachedRight {
				return result
			}
			want = netip.Addr{}
		case taken:
			// The current endpoint stays until the address is free: no gap while it is not.
			m.scheduleEgressRetryLocked()
			return egressAttach{state: egressStatePending, err: fmt.Errorf("%w (%s); retrying", errEgressAddressInUse, want)}
		}
	}
	settings := &network.EndpointSettings{}
	if !desired.aliasDisabled {
		settings.Aliases = []string{desired.alias}
	}
	if want.IsValid() {
		settings.IPAMConfig = &network.EndpointIPAMConfig{IPv4Address: want}
	}
	// What puts the connector back on the network when the new endpoint is refused: its previous aliases (the link's
	// alias when it must have one) at its previous address where the network allows one, else any address.
	restore := &network.EndpointSettings{Aliases: settings.Aliases}
	if endpoint != nil {
		if desired.aliasDisabled {
			restore.Aliases = endpoint.Aliases
		}
		if info.userSubnet && endpoint.IPAddress.IsValid() {
			restore.IPAMConfig = &network.EndpointIPAMConfig{IPv4Address: endpoint.IPAddress}
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, desired.networkName, mobyclient.NetworkDisconnectOptions{Container: m.networkHolder(), Force: true}); err != nil && !isNotFoundErr(err) {
			return egressAttach{state: egressStateError, err: fmt.Errorf("detach the connector to rejoin the link network: %w", err)}
		}
	}
	if _, err := m.plugin.client.cli.NetworkConnect(ctx, desired.networkName, mobyclient.NetworkConnectOptions{Container: m.networkHolder(), EndpointConfig: settings}); err != nil {
		m.scheduleEgressRetryLocked()
		if !m.rejoinEgressNetworkLocked(ctx, desired.networkName, restore) {
			return egressAttach{state: egressStateError, err: fmt.Errorf("attach the secure-link connector to the link network: %w", err)}
		}
		result.changed = true
		result.warning = fmt.Sprintf("the connector kept its previous endpoint on the link network: %v", err)
		if want.IsValid() && strings.Contains(strings.ToLower(err.Error()), "in use") {
			result.warning = fmt.Sprintf("%v (%s); retrying", errEgressAddressInUse, want)
		}
		return result
	}
	if m.attached != nil {
		m.attached[desired.networkName] = struct{}{}
	}
	result.changed = true
	return result
}

// rejoinEgressNetworkLocked puts the connector back on a link network it was taken off: with restore, else at any
// address. It reports whether the connector is on the network again.
func (m *dockerSecureLinkManager) rejoinEgressNetworkLocked(ctx context.Context, networkName string, restore *network.EndpointSettings) bool {
	attempts := []*network.EndpointSettings{restore}
	if restore.IPAMConfig != nil {
		attempts = append(attempts, &network.EndpointSettings{Aliases: restore.Aliases})
	}
	for _, settings := range attempts {
		if _, err := m.plugin.client.cli.NetworkConnect(ctx, networkName, mobyclient.NetworkConnectOptions{Container: m.networkHolder(), EndpointConfig: settings}); err == nil ||
			strings.Contains(strings.ToLower(err.Error()), "already exists") {
			if m.attached != nil {
				m.attached[networkName] = struct{}{}
			}
			return true
		}
	}
	return false
}

// takeEgressAddressLocked makes the connector's address free on a link network: a connector it replaces (the other
// slot, retiring with its own namespace) gives it up. It reports an address another container holds.
func (m *dockerSecureLinkManager) takeEgressAddressLocked(ctx context.Context, networkName string, address netip.Addr) (bool, error) {
	inspected, err := m.plugin.client.cli.NetworkInspect(ctx, networkName, mobyclient.NetworkInspectOptions{})
	if err != nil {
		return false, fmt.Errorf("inspect the link network: %w", err)
	}
	for id, endpoint := range inspected.Network.Containers {
		if !endpoint.IPv4Address.IsValid() || endpoint.IPv4Address.Addr() != address || id == m.networkHolder() {
			continue
		}
		if !isSecureLinkConnectorName(strings.TrimPrefix(endpoint.Name, "/")) {
			return true, nil
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, networkName, mobyclient.NetworkDisconnectOptions{Container: id, Force: true}); err != nil && !isNotFoundErr(err) {
			return false, fmt.Errorf("take the connector address from the replaced connector: %w", err)
		}
	}
	return false, nil
}

// scheduleEgressRetryLocked reconciles the egress again shortly (an address still in use), once at a time.
func (m *dockerSecureLinkManager) scheduleEgressRetryLocked() {
	if m.egress.retryScheduled {
		return
	}
	m.egress.retryScheduled = true
	time.AfterFunc(egressAddressRetry, func() {
		m.mu.Lock()
		m.egress.retryScheduled = false
		m.mu.Unlock()
		m.resyncEgress()
	})
}
