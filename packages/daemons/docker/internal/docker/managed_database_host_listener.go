package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/netaccept"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
)

const (
	// managedDatabaseHostListenerGlobalConnections bounds the connections of every binding's host listener on the
	// node together (file descriptors and per-connection buffers). A binding may carry as many connections as its
	// database accepts, so this only stops a runaway node, never one binding's ordinary pool.
	managedDatabaseHostListenerGlobalConnections = 8192
	managedDatabaseHostListenerInspectTimeout    = 5 * time.Second
)

// managedDatabaseListenerSuccessorWait bounds how long a listener whose binding left the grant bundle keeps its socket
// for the binding that takes over its route in a later bundle (an Availability adopt or release that reaches the node
// in two syncs); connections wait for it meanwhile. A variable for tests.
var managedDatabaseListenerSuccessorWait = 5 * time.Second

// errManagedDatabaseListenerUnverified marks a listener network that could not be inspected (a slow or failing
// Docker API). That proves nothing about the network, so a running listener keeps serving its connections.
var errManagedDatabaseListenerUnverified = errors.New("inspect managed database listener network")

var managedDatabaseHostContainerName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

type managedDatabaseHostListenerConfig struct {
	bindingID       string
	networkName     string
	networkID       string
	listenAddress   netip.Addr
	listenPort      uint16
	allowedSources  []string
	routeGeneration uint64
	// maxConnections is the link's capacity: the session limit Opfield signed into the binding's grant. The listener
	// is the link's single gate on the node and holds it there whichever relay of the pool carries a connection; each
	// relay caps the route at the same limit, so any one of them can carry the whole link. A grant refresh changes it
	// on the running listener; it is not part of the listener's identity (equal), so a new limit never drops a
	// connection.
	maxConnections int
}

type managedDatabaseHostListenerStatus struct {
	Address string `json:"address"`
	Port    uint16 `json:"port"`
	State   string `json:"state"`
	Error   string `json:"error,omitempty"`
}

type managedDatabaseHostListener struct {
	listener *net.TCPListener
	mu       sync.Mutex
	// config changes in place while the socket stays (sameSocket): a new limit, source list, route generation or
	// binding (re-key on an Availability adopt).
	config      managedDatabaseHostListenerConfig
	closed      bool
	connections map[net.Conn]struct{}
	// sources are the containers the connections the listener serves came from, by connection.
	sources map[net.Conn]listenerPeer
	// keptName names the socket's copy in the listener keeper, which outlives this process ("" without a keeper,
	// or once the copy was handed over to the next process).
	keptName string
	// successor is open while the listener's binding left the grant bundle and no binding took the socket over yet:
	// connections accepted meanwhile wait for one (awaitBinding). It closes when a binding claims the listener or the
	// listener closes.
	successor chan struct{}
}

type managedDatabaseHostListenerManager struct {
	plugin           *DockerPlugin
	logger           *slog.Logger
	mu               sync.Mutex
	listeners        map[string]*managedDatabaseHostListener
	global           chan struct{}
	inspectNetwork   func(context.Context, string) (network.Inspect, error)
	inspectContainer func(context.Context, string) (mobyclient.ContainerInspectResult, error)
	events           func(context.Context, mobyclient.EventsListOptions) mobyclient.EventsResult
	openBinding      func(net.Conn, string, uint64, listenerPeer, bool)
	rejections       *linkRejectionLog
	// peers names the container behind each address of the listeners' networks without asking dockerd for every
	// connection (listenerPeers).
	peers              listenerPeers
	peerRefreshMu      sync.Mutex
	peerRefreshRunning bool
	peerRefreshPending *peerSnapshot
	// adopted are the listening sockets the previous process or the boot step handed over, by keeper name, until a
	// reconcile claims them (link_listener_handover.go); guarded by mu.
	adopted       map[string]*os.File
	adoptionTimer *time.Timer
	// handingOver is set once the listeners went to the next process: nothing changes them any more.
	handingOver bool
	// orphans are the listeners whose binding left the grant bundle without a successor on the same socket, by keeper
	// name, until a later bundle's binding claims them or managedDatabaseListenerSuccessorWait ends; guarded by mu.
	orphans map[string]*managedDatabaseHostListener
	// stateDir holds the addresses of the open listeners for the boot step (link_listener_boot.go), last written as
	// bootSetWritten; "" records nothing (tests).
	stateDir       string
	bootSetWritten string
}

func newManagedDatabaseHostListenerManager(plugin *DockerPlugin) *managedDatabaseHostListenerManager {
	manager := &managedDatabaseHostListenerManager{
		plugin:    plugin,
		logger:    plugin.logger,
		listeners: map[string]*managedDatabaseHostListener{},
		global:    make(chan struct{}, managedDatabaseHostListenerGlobalConnections),
		// The plugin's log: the health report counts what the listeners refuse.
		rejections: &plugin.linkRejections,
	}
	manager.inspectNetwork = func(ctx context.Context, name string) (network.Inspect, error) {
		inspected, err := plugin.client.cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{})
		return inspected.Network, err
	}
	manager.inspectContainer = func(ctx context.Context, id string) (mobyclient.ContainerInspectResult, error) {
		return plugin.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	}
	manager.events = func(ctx context.Context, options mobyclient.EventsListOptions) mobyclient.EventsResult {
		return plugin.client.cli.Events(ctx, options)
	}
	if plugin.cfg != nil {
		manager.stateDir = plugin.cfg.StateDir
	}
	manager.openBinding = plugin.openManagedDatabaseBinding
	return manager
}

func (m *managedDatabaseHostListenerManager) reconcile(
	ctx context.Context,
	bundle *pb.SyncRelayGrantsCommand,
) map[string]managedDatabaseHostListenerStatus {
	desired, statuses := m.desired(bundle)
	resolved := make(map[string]managedDatabaseHostListenerConfig, len(desired))
	// unverified holds the bindings whose network could not be inspected now. Their running listeners stay and
	// report the error; only a sync that inspects the network again replaces or closes them.
	unverified := map[string]managedDatabaseHostListenerConfig{}
	peers := peerSnapshot{networks: map[string]network.Inspect{}, generation: m.peers.begin()}
	for bindingID, config := range desired {
		resolvedConfig, inspected, err := m.resolve(ctx, config)
		if err != nil {
			statuses[bindingID] = listenerStatus(config, "error", err)
			if errors.Is(err, errManagedDatabaseListenerUnverified) {
				unverified[bindingID] = config
			}
			continue
		}
		resolved[bindingID] = resolvedConfig
		peers.networks[resolvedConfig.networkID] = inspected
	}
	m.refreshPeers(peers)

	for _, bindingIDs := range duplicateListenerAddresses(resolved) {
		for _, bindingID := range bindingIDs {
			config := resolved[bindingID]
			statuses[bindingID] = listenerStatus(config, "error", errors.New("managed database listeners cannot share an address and port"))
			delete(resolved, bindingID)
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.handingOver {
		// The process stops: its listeners belong to the next one.
		return statuses
	}
	// released are the listeners of bindings that left the bundle. One may serve on as another binding.
	var released []*managedDatabaseHostListener
	for bindingID, listener := range m.listeners {
		current := listener.currentConfig()
		// A new source list (an Availability disable narrows it to the survivor) or route generation keeps the
		// listening socket: only the connections the new route no longer carries close (see update).
		if config, present := resolved[bindingID]; present && current.sameSocket(config) {
			if config.routeGeneration != current.routeGeneration {
				m.logger.Info("managed database host listener took a new route generation", "binding_id", bindingID,
					"route_generation", config.routeGeneration, "previous_route_generation", current.routeGeneration)
			}
			listener.update(config)
			statuses[bindingID] = listenerStatus(config, "ready", nil)
			continue
		}
		if config, present := unverified[bindingID]; present {
			config.networkID = current.networkID
			if current.sameSocket(config) {
				listener.update(config)
				continue
			}
		}
		delete(m.listeners, bindingID)
		_, stillDesired := desired[bindingID]
		_, stillListed := statuses[bindingID]
		if !stillDesired && !stillListed {
			released = append(released, listener)
			continue
		}
		listener.close()
	}
	for _, listener := range released {
		previous := listener.currentConfig()
		next, verified, found := m.successorLocked(previous, resolved, unverified)
		if !found {
			// The binding that takes the route over may reach the node in a later bundle: the socket and its
			// connections wait for it instead of refusing the workload meanwhile.
			m.orphanLocked(listener)
			continue
		}
		// An Availability adopt or release moves the binding's route to another binding id on the same network and
		// address: the listener serves on under the new id, and keeps the connections the new route still carries.
		listener.update(next)
		m.listeners[next.bindingID] = listener
		if verified {
			statuses[next.bindingID] = listenerStatus(next, "ready", nil)
		}
		m.logger.Info("managed database host listener moved to another binding", "from_binding_id", previous.bindingID,
			"binding_id", next.bindingID, "address", net.JoinHostPort(next.listenAddress.String(), fmt.Sprintf("%d", next.listenPort)))
	}
	for bindingID, config := range unverified {
		if _, exists := m.listeners[bindingID]; exists {
			continue
		}
		if listener := m.claimOrphanLocked(config, false); listener != nil {
			m.listeners[bindingID] = listener
		}
	}
	for bindingID, config := range resolved {
		if _, exists := m.listeners[bindingID]; exists {
			continue
		}
		if listener := m.claimOrphanLocked(config, true); listener != nil {
			m.listeners[bindingID] = listener
			statuses[bindingID] = listenerStatus(config, "ready", nil)
			continue
		}
		listener, err := m.listen(config)
		if err != nil {
			statuses[bindingID] = listenerStatus(config, "error", err)
			continue
		}
		m.listeners[bindingID] = listener
		statuses[bindingID] = listenerStatus(config, "ready", nil)
	}
	m.adoptRestoredLocked()
	m.persistBootSetLocked()
	return statuses
}

// orphanLocked keeps a listener whose binding left the grant bundle for the binding that takes its socket over in a
// later bundle, and closes it once managedDatabaseListenerSuccessorWait passes without one. Callers hold m.mu.
func (m *managedDatabaseHostListenerManager) orphanLocked(listener *managedDatabaseHostListener) {
	config := listener.currentConfig()
	name := hostListenerKeepName(config.listenAddress, config.listenPort)
	if previous := m.orphans[name]; previous != nil && previous != listener {
		previous.close()
	}
	if m.orphans == nil {
		m.orphans = map[string]*managedDatabaseHostListener{}
	}
	m.orphans[name] = listener
	listener.mu.Lock()
	if listener.successor == nil && !listener.closed {
		listener.successor = make(chan struct{})
	}
	listener.mu.Unlock()
	m.logger.Info("managed database host listener waits for the binding that takes its route over", "binding_id", config.bindingID,
		"address", net.JoinHostPort(config.listenAddress.String(), fmt.Sprintf("%d", config.listenPort)),
		"wait", managedDatabaseListenerSuccessorWait)
	time.AfterFunc(managedDatabaseListenerSuccessorWait, func() {
		m.mu.Lock()
		expired := m.orphans[name] == listener
		if expired {
			delete(m.orphans, name)
		}
		m.mu.Unlock()
		if !expired {
			return
		}
		m.logger.Info("managed database host listener closed: its binding left the grant bundle", "binding_id", config.bindingID,
			"address", net.JoinHostPort(config.listenAddress.String(), fmt.Sprintf("%d", config.listenPort)))
		listener.close()
	})
}

// claimOrphanLocked hands the orphaned listener at config's address to config's binding when it is the same socket
// (verified: config's network was inspected now), and closes an orphan at that address that is another socket so
// the binding can listen there. Callers hold m.mu.
func (m *managedDatabaseHostListenerManager) claimOrphanLocked(config managedDatabaseHostListenerConfig, verified bool) *managedDatabaseHostListener {
	name := hostListenerKeepName(config.listenAddress, config.listenPort)
	listener := m.orphans[name]
	if listener == nil {
		return nil
	}
	previous := listener.currentConfig()
	if !verified {
		config.networkID = previous.networkID
	}
	if !previous.sameSocket(config) {
		if verified {
			delete(m.orphans, name)
			listener.close()
		}
		return nil
	}
	delete(m.orphans, name)
	listener.update(config)
	listener.mu.Lock()
	if listener.successor != nil {
		close(listener.successor)
		listener.successor = nil
	}
	listener.mu.Unlock()
	m.logger.Info("managed database host listener moved to another binding", "from_binding_id", previous.bindingID,
		"binding_id", config.bindingID, "address", net.JoinHostPort(config.listenAddress.String(), fmt.Sprintf("%d", config.listenPort)))
	return listener
}

// successorLocked finds the binding a released listener serves on as: one without a listener on the same socket
// (network, address and port). verified reports a successor whose network was inspected now.
func (m *managedDatabaseHostListenerManager) successorLocked(
	previous managedDatabaseHostListenerConfig,
	resolved, unverified map[string]managedDatabaseHostListenerConfig,
) (next managedDatabaseHostListenerConfig, verified bool, found bool) {
	passes := []struct {
		candidates map[string]managedDatabaseHostListenerConfig
		verified   bool
	}{{resolved, true}, {unverified, false}}
	for _, pass := range passes {
		bindingIDs := make([]string, 0, len(pass.candidates))
		for bindingID := range pass.candidates {
			bindingIDs = append(bindingIDs, bindingID)
		}
		sort.Strings(bindingIDs)
		for _, bindingID := range bindingIDs {
			if _, exists := m.listeners[bindingID]; exists {
				continue
			}
			candidate := pass.candidates[bindingID]
			if !pass.verified {
				candidate.networkID = previous.networkID
			}
			if previous.sameSocket(candidate) {
				return candidate, pass.verified, true
			}
		}
	}
	return managedDatabaseHostListenerConfig{}, false, false
}

func (m *managedDatabaseHostListenerManager) desired(bundle *pb.SyncRelayGrantsCommand) (map[string]managedDatabaseHostListenerConfig, map[string]managedDatabaseHostListenerStatus) {
	desired := map[string]managedDatabaseHostListenerConfig{}
	statuses := map[string]managedDatabaseHostListenerStatus{}
	if bundle == nil {
		return desired, statuses
	}
	for _, assignment := range bundle.GetGrants() {
		if assignment == nil || assignment.GetManagedDatabaseListener() == nil {
			continue
		}
		bindingID := assignment.GetOwnerId()
		config, err := managedDatabaseHostListenerConfigFromAssignment(assignment)
		if err != nil {
			statuses[bindingID] = managedDatabaseHostListenerStatus{State: "error", Error: err.Error()}
			continue
		}
		if _, exists := desired[config.bindingID]; exists {
			statuses[config.bindingID] = listenerStatus(config, "error", errors.New("duplicate managed database listener binding"))
			delete(desired, config.bindingID)
			continue
		}
		desired[config.bindingID] = config
	}
	return desired, statuses
}

func managedDatabaseHostListenerConfigFromAssignment(assignment *pb.RelayGrantAssignment) (managedDatabaseHostListenerConfig, error) {
	listener := assignment.GetManagedDatabaseListener()
	if assignment.GetRole() != "connect" || assignment.GetOwnerKind() != "managed_database_binding" {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener requires a connect binding assignment")
	}
	if !managedDatabaseIDPattern.MatchString(assignment.GetOwnerId()) {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener binding id is invalid")
	}
	if listener == nil || !isDatabaseLinkNetworkName(listener.GetNetworkName()) {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener network is invalid")
	}
	address, err := netip.ParseAddr(listener.GetListenAddress())
	if err != nil || !address.Is4() {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener address must be IPv4")
	}
	if listener.GetListenPort() == 0 || listener.GetListenPort() > 65535 {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener port is invalid")
	}
	if listener.GetRouteGeneration() == 0 {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener route generation is required")
	}
	if assignment.GetGrant() == nil && len(relaybridge.PoolCandidates(assignment, false)) == 0 {
		return managedDatabaseHostListenerConfig{}, errors.New("managed database listener relay grant is unavailable")
	}
	allowed, err := normalizedManagedDatabaseAllowedSources(listener.GetAllowedSources())
	if err != nil {
		return managedDatabaseHostListenerConfig{}, err
	}
	return managedDatabaseHostListenerConfig{
		bindingID: assignment.GetOwnerId(), networkName: listener.GetNetworkName(), listenAddress: address,
		listenPort: uint16(listener.GetListenPort()), allowedSources: allowed, routeGeneration: listener.GetRouteGeneration(),
		maxConnections: int(relayGrantSessionLimit(assignment, managedLinkDefaultSessions)),
	}, nil
}

// relayGrantSessionLimit reads the session limit Opfield signed into an assignment's grants, or fallback when they name
// none. The relay verifies the grant and enforces the limit per route; the daemon holds the whole link at it.
func relayGrantSessionLimit(assignment *pb.RelayGrantAssignment, fallback uint32) uint32 {
	grants := []*pb.RelaySignedGrant{assignment.GetGrant()}
	for _, candidate := range assignment.GetCandidates() {
		grants = append(grants, candidate.GetGrant())
	}
	limit := uint32(0)
	for _, grant := range grants {
		if len(grant.GetPayload()) == 0 {
			continue
		}
		var claims struct {
			MaxConcurrentSessions uint32 `json:"maxConcurrentSessions"`
		}
		if json.Unmarshal(grant.GetPayload(), &claims) == nil && claims.MaxConcurrentSessions > limit {
			limit = claims.MaxConcurrentSessions
		}
	}
	if limit == 0 {
		return fallback
	}
	return limit
}

func normalizedManagedDatabaseAllowedSources(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > 32 {
		return nil, errors.New("managed database listener allowed sources are invalid")
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !validManagedDatabaseSource(value) {
			return nil, errors.New("managed database listener source selector is invalid")
		}
		if _, exists := seen[value]; exists {
			return nil, errors.New("managed database listener source selectors must be unique")
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func validManagedDatabaseSource(value string) bool {
	kind, identity, found := strings.Cut(value, ":")
	if !found || identity == "" {
		return false
	}
	switch kind {
	case "container":
		return managedDatabaseHostContainerName.MatchString(identity)
	case "deployment":
		return managedDatabaseIDPattern.MatchString(identity)
	case "compose":
		project, service, present := strings.Cut(identity, ":")
		return present && managedDatabaseHostContainerName.MatchString(project) && managedDatabaseHostContainerName.MatchString(service)
	default:
		return false
	}
}

// resolve checks a listener's network through dockerd and returns the config with its network id, and the inspect.
func (m *managedDatabaseHostListenerManager) resolve(ctx context.Context, config managedDatabaseHostListenerConfig) (managedDatabaseHostListenerConfig, network.Inspect, error) {
	inspectCtx, cancel := context.WithTimeout(ctx, managedDatabaseHostListenerInspectTimeout)
	defer cancel()
	inspected, err := m.inspectNetwork(inspectCtx, config.networkName)
	if isNotFoundErr(err) {
		return config, inspected, fmt.Errorf("managed database listener network %s does not exist: %w", config.networkName, err)
	}
	if err != nil {
		return config, inspected, fmt.Errorf("%w: %w", errManagedDatabaseListenerUnverified, err)
	}
	if inspected.Name != config.networkName || inspected.ID == "" || inspected.Driver != "bridge" || inspected.Ingress || inspected.ConfigOnly {
		return config, inspected, errors.New("managed database listener network is not a dedicated bridge network")
	}
	gateway, err := managedDatabaseNetworkGatewayAddress(inspected)
	if err != nil {
		return config, inspected, err
	}
	if gateway != config.listenAddress {
		return config, inspected, errors.New("managed database listener address is not the network gateway")
	}
	config.networkID = inspected.ID
	return config, inspected, nil
}

func managedDatabaseNetworkGatewayAddress(inspected network.Inspect) (netip.Addr, error) {
	for _, config := range inspected.IPAM.Config {
		if config.Gateway.IsValid() && config.Gateway.Is4() {
			return config.Gateway, nil
		}
	}
	return netip.Addr{}, errors.New("managed database network has no IPv4 gateway")
}

func duplicateListenerAddresses(configs map[string]managedDatabaseHostListenerConfig) map[string][]string {
	byAddress := map[string][]string{}
	for bindingID, config := range configs {
		address := net.JoinHostPort(config.listenAddress.String(), fmt.Sprintf("%d", config.listenPort))
		byAddress[address] = append(byAddress[address], bindingID)
	}
	duplicates := map[string][]string{}
	for address, bindingIDs := range byAddress {
		if len(bindingIDs) > 1 {
			duplicates[address] = bindingIDs
		}
	}
	return duplicates
}

// listen opens the host listener for config: the socket a previous process or the boot step handed over for its
// address when there is one, else a new one. Callers hold m.mu.
func (m *managedDatabaseHostListenerManager) listen(config managedDatabaseHostListenerConfig) (*managedDatabaseHostListener, error) {
	name := hostListenerKeepName(config.listenAddress, config.listenPort)
	listener := m.takeAdoptedLocked(name, config)
	if listener == nil {
		var err error
		if listener, err = bindHostListener(name, config); err != nil {
			return nil, fmt.Errorf("listen on managed database gateway: %w", err)
		}
	}
	managedListener := &managedDatabaseHostListener{config: config, listener: listener, connections: map[net.Conn]struct{}{},
		sources:  map[net.Conn]listenerPeer{},
		keptName: keepListener(listener, name)}
	go m.accept(managedListener)
	return managedListener, nil
}

// accept serves the listener until it is closed. A transient accept error (out of file descriptors) backs off and
// retries instead of leaving the socket open but never accepting again (B-22).
func (m *managedDatabaseHostListenerManager) accept(listener *managedDatabaseHostListener) {
	var backoff netaccept.Backoff
	for {
		connection, err := listener.listener.AcceptTCP()
		if err != nil {
			if backoff.Retry(err, nil) {
				continue
			}
			return
		}
		backoff.Reset()
		if !m.acquire(listener, connection) {
			_ = connection.Close()
			continue
		}
		go m.handle(listener, connection)
	}
}

func (m *managedDatabaseHostListenerManager) acquire(listener *managedDatabaseHostListener, connection net.Conn) bool {
	select {
	case m.global <- struct{}{}:
	default:
		m.rejections.rejected(m.logger, linkKindManagedDatabaseBinding, listener.currentConfig().bindingID, linkRejectedNodeLimit,
			"limit", cap(m.global))
		return false
	}
	listener.mu.Lock()
	if listener.closed {
		listener.mu.Unlock()
		<-m.global
		return false
	}
	if limit := listener.config.maxConnections; len(listener.connections) >= limit {
		bindingID := listener.config.bindingID
		listener.mu.Unlock()
		<-m.global
		m.rejections.rejected(m.logger, linkKindManagedDatabaseBinding, bindingID, linkRejectedLinkLimit, "limit", limit)
		return false
	}
	listener.connections[connection] = struct{}{}
	listener.mu.Unlock()
	return true
}

func (m *managedDatabaseHostListenerManager) handle(listener *managedDatabaseHostListener, connection net.Conn) {
	defer func() {
		listener.mu.Lock()
		delete(listener.connections, connection)
		delete(listener.sources, connection)
		listener.mu.Unlock()
		<-m.global
		_ = connection.Close()
	}()
	if !listener.awaitBinding() {
		return
	}
	config := listener.currentConfig()
	reject := func(reason string, attrs ...any) {
		m.rejections.rejected(m.logger, linkKindManagedDatabaseBinding, config.bindingID, reason, attrs...)
	}
	remote, ok := connection.RemoteAddr().(*net.TCPAddr)
	if !ok {
		return
	}
	remoteAddress, ok := netip.AddrFromSlice(remote.IP)
	if !ok || !remoteAddress.Unmap().Is4() {
		reject(linkRejectedUnknownPeer, "peer", remote.IP.String())
		return
	}
	address := remoteAddress.Unmap()
	peer, known := m.peers.lookup(config.networkID, address)
	if !known {
		var reason string
		var attrs []any
		if peer, reason, attrs = m.verifyPeer(config, address); reason != "" {
			reject(reason, attrs...)
			return
		}
	}
	if !managedDatabaseListenerSourceAllowed(peer, config.allowedSources) {
		reject(linkRejectedSourceNotAllowed, "container", peer.name)
		return
	}
	// A re-key while the peer was checked moved the listener to another binding with the same network and sources:
	// the connection belongs to the binding the listener serves now. A source list narrowed meanwhile applies.
	listener.mu.Lock()
	active, current := !listener.closed, listener.config
	allowed := managedDatabaseListenerSourceAllowed(peer, current.allowedSources)
	if active && allowed {
		listener.sources[connection] = peer
	}
	listener.mu.Unlock()
	if active && !allowed {
		reject(linkRejectedSourceNotAllowed, "container", peer.name)
		return
	}
	if active {
		m.openBinding(connection, current.bindingID, current.routeGeneration, peer, true)
	}
}

// verifyPeer asks dockerd which container has address on the listener's network, and remembers the answer (see
// listenerPeers). A non-empty reason is the rejection.
func (m *managedDatabaseHostListenerManager) verifyPeer(config managedDatabaseHostListenerConfig, address netip.Addr) (listenerPeer, string, []any) {
	generation := m.peers.begin()
	inspectCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseHostListenerInspectTimeout)
	defer cancel()
	inspected, err := m.inspectNetwork(inspectCtx, config.networkName)
	if err != nil {
		return listenerPeer{}, linkRejectedNetworkUnverified, []any{"error", err.Error()}
	}
	if inspected.Name != config.networkName || inspected.ID != config.networkID {
		return listenerPeer{}, linkRejectedNetworkChanged, nil
	}
	if gateway, gatewayErr := managedDatabaseNetworkGatewayAddress(inspected); gatewayErr != nil || gateway != config.listenAddress {
		return listenerPeer{}, linkRejectedNetworkChanged, nil
	}
	containerID := managedDatabaseListenerPeerContainerID(inspected, address)
	if containerID == "" {
		return listenerPeer{}, linkRejectedUnknownPeer, []any{"peer", address.String()}
	}
	containerInspect, err := m.inspectContainer(inspectCtx, containerID)
	if err != nil {
		return listenerPeer{}, linkRejectedNetworkUnverified, []any{"error", err.Error()}
	}
	peer := listenerPeerFromInspect(containerID, containerInspect)
	m.peers.store(config.networkID, address, peer, generation)
	return peer, "", nil
}

// activeConnections returns the connections each binding's listener holds, by binding id.
func (m *managedDatabaseHostListenerManager) activeConnections() map[string]int {
	m.mu.Lock()
	listeners := make(map[string]*managedDatabaseHostListener, len(m.listeners))
	for bindingID, listener := range m.listeners {
		listeners[bindingID] = listener
	}
	m.mu.Unlock()
	result := make(map[string]int, len(listeners))
	for bindingID, listener := range listeners {
		listener.mu.Lock()
		result[bindingID] = len(listener.connections)
		listener.mu.Unlock()
	}
	return result
}

func managedDatabaseListenerPeerContainerID(inspected network.Inspect, remote netip.Addr) string {
	for containerID, endpoint := range inspected.Containers {
		if !endpoint.IPv4Address.IsValid() {
			continue
		}
		if endpoint.IPv4Address.Addr().Unmap() == remote {
			return containerID
		}
	}
	return ""
}

func managedDatabaseListenerSourceAllowed(peer listenerPeer, allowed []string) bool {
	name, labels := peer.name, peer.labels
	for _, selector := range allowed {
		kind, identity, _ := strings.Cut(selector, ":")
		switch kind {
		case "container":
			if name == identity {
				return true
			}
		case "deployment":
			if labels[deploymentManagedLabel] == "true" && labels[deploymentIDLabel] == identity {
				return true
			}
		case "compose":
			project, service, _ := strings.Cut(identity, ":")
			if labels["com.docker.compose.project"] == project && labels["com.docker.compose.service"] == service {
				return true
			}
		}
	}
	return false
}

// awaitBinding waits, while the listener's binding left the grant bundle, for the binding that takes it over, and
// reports whether the listener still serves.
func (listener *managedDatabaseHostListener) awaitBinding() bool {
	listener.mu.Lock()
	successor := listener.successor
	listener.mu.Unlock()
	if successor != nil {
		<-successor
	}
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return !listener.closed
}

func (listener *managedDatabaseHostListener) currentConfig() managedDatabaseHostListenerConfig {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	return listener.config
}

// update applies a config of the same socket (sameSocket) in place. A new route generation (the route moved to
// another source, target or listener) closes the connections opened on the previous one; otherwise only those whose
// source the new source list no longer allows close. New connections are never refused meanwhile.
func (listener *managedDatabaseHostListener) update(config managedDatabaseHostListenerConfig) {
	listener.mu.Lock()
	newRoute := listener.config.routeGeneration != config.routeGeneration
	listener.config = config
	var refused []net.Conn
	if newRoute {
		for connection := range listener.connections {
			refused = append(refused, connection)
		}
	} else {
		for connection, peer := range listener.sources {
			if !managedDatabaseListenerSourceAllowed(peer, config.allowedSources) {
				refused = append(refused, connection)
			}
		}
	}
	listener.mu.Unlock()
	for _, connection := range refused {
		_ = connection.Close()
	}
}

func (listener *managedDatabaseHostListener) close() {
	listener.mu.Lock()
	if listener.closed {
		listener.mu.Unlock()
		return
	}
	listener.closed = true
	if listener.successor != nil {
		close(listener.successor)
		listener.successor = nil
	}
	connections := make([]net.Conn, 0, len(listener.connections))
	for connection := range listener.connections {
		connections = append(connections, connection)
	}
	keptName := listener.keptName
	listener.keptName = ""
	listener.mu.Unlock()
	_ = listener.listener.Close()
	if keptName != "" {
		_ = listenerkeep.Drop(keptName)
	}
	for _, connection := range connections {
		_ = connection.Close()
	}
}

// sameSocket reports a config the running listening socket serves: the same network, address and port. The binding,
// route generation, source list and limit change on the running listener (update), so a route change never closes
// the socket and refuses the connections made meanwhile.
func (config managedDatabaseHostListenerConfig) sameSocket(other managedDatabaseHostListenerConfig) bool {
	return config.networkName == other.networkName && config.networkID == other.networkID &&
		config.listenAddress == other.listenAddress && config.listenPort == other.listenPort
}

func listenerStatus(config managedDatabaseHostListenerConfig, state string, err error) managedDatabaseHostListenerStatus {
	status := managedDatabaseHostListenerStatus{Address: config.listenAddress.String(), Port: config.listenPort, State: state}
	if err != nil {
		status.Error = err.Error()
	}
	return status
}
