package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"

	"github.com/wiolett-industries/gateway/daemon-shared/netaccept"
)

// Member mesh aliases of availability sets (decision 3 of the plan): how an
// engine container of this node's member reaches "primary-<port>",
// "member-<member id>-<port>" or "witness-<witness id>-<port>".
//
// Every set gets its own internal bridge network (gateway-set-<16 hex of the set
// id>, a /26 of the link subnet pool). The daemon listens on that network's
// gateway address, one port per exposed alias, and the containers resolve each
// alias host to that address through an ExtraHosts entry (the pattern of the
// database host listener). Each accepted connection is carried to its alias
// through the set's peer routes (BridgeSetPeer). Ports are chosen by the
// engine, so the address an engine writes into its configuration stays valid
// across daemon restarts as long as the network exists.
//
// A primary alias reaches the lease holder. While this node's member is the
// primary, the engine's local dialer (SetLocalPrimary) takes the connection
// without a relay round trip. A connection to a primary alias carried through
// a relay is closed when the relays' gate views name another holder, so copies
// reconnect to the new primary at once instead of waiting for their stream to
// time out.

const (
	setMeshNetworkPrefix = "gateway-set-"
	setMeshNetworkLabel  = "availability-set"
	setMeshRetry         = 5 * time.Second
	setMeshInspectWait   = 5 * time.Second
)

// setMeshes holds the mesh of each plugin. A side table rather than a plugin
// field keeps this feature out of the plugin's constructor.
var setMeshes sync.Map // *DockerPlugin -> *setMesh

// setMeshLocalDial dials this node's member's engine port directly; ok is
// false when the member is not the primary now.
type setMeshLocalDial func(ctx context.Context, port string) (net.Conn, bool)

type setMeshExpose struct {
	host  string
	port  uint16
	alias string
}

type setMeshListener struct {
	spec     setMeshExpose
	address  netip.Addr
	listener net.Listener
}

type setMeshSet struct {
	network   string
	gateway   netip.Addr
	exposed   map[string]setMeshExpose // by host:port
	listeners map[string]*setMeshListener
	local     setMeshLocalDial
	conns     map[net.Conn]struct{}
}

type setMesh struct {
	plugin *DockerPlugin
	mu     sync.Mutex
	sets   map[string]*setMeshSet
	wake   chan struct{}
	once   sync.Once
	// inspect and listen are replaced by tests.
	inspect func(ctx context.Context, name string) (netip.Addr, bool, error)
	listen  func(address string) (net.Listener, error)
	bridge  func(conn net.Conn, setID, alias string) error
	// warned: routes (set id + alias) whose failed open was logged as a
	// warning; later failures of the same route log at info.
	warned map[string]struct{}
}

// setMesh is the plugin's member mesh.
func (p *DockerPlugin) setMesh() *setMesh {
	if existing, ok := setMeshes.Load(p); ok {
		return existing.(*setMesh)
	}
	mesh := &setMesh{plugin: p, sets: map[string]*setMeshSet{}, wake: make(chan struct{}, 1)}
	mesh.inspect = mesh.inspectNetwork
	mesh.listen = func(address string) (net.Listener, error) { return net.Listen("tcp", address) }
	mesh.bridge = p.BridgeSetPeer
	actual, _ := setMeshes.LoadOrStore(p, mesh)
	return actual.(*setMesh)
}

// setMeshNetworkName is the private network of a set's member on every node.
func setMeshNetworkName(setID string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(setID)))
	return setMeshNetworkPrefix + hex.EncodeToString(sum[:8])
}

func (s *setMesh) set(setID string) *setMeshSet {
	entry := s.sets[setID]
	if entry == nil {
		entry = &setMeshSet{network: setMeshNetworkName(setID), exposed: map[string]setMeshExpose{},
			listeners: map[string]*setMeshListener{}, conns: map[net.Conn]struct{}{}}
		s.sets[setID] = entry
	}
	return entry
}

// Ensure creates the set's network when it does not exist (idempotent) and
// returns its name.
func (s *setMesh) Ensure(ctx context.Context, setID string) (string, error) {
	if !uuidLike(setID) {
		return "", errors.New("availability set id must be a UUID")
	}
	name := setMeshNetworkName(setID)
	if s.plugin == nil || s.plugin.client == nil {
		return "", errors.New("docker is not available")
	}
	linkNetworkCreate.Lock()
	defer linkNetworkCreate.Unlock()
	cli := s.plugin.client.cli
	if existing, err := cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{}); err == nil {
		if existing.Network.Labels["wiolett.gateway.managed"] != setMeshNetworkLabel || !existing.Network.Internal {
			return "", fmt.Errorf("network %s exists and is not a Gateway availability set network", name)
		}
		s.kick()
		return name, nil
	} else if !isNotFoundErr(err) {
		return "", fmt.Errorf("inspect availability set network: %w", err)
	}
	pool, err := s.plugin.linkSubnetPool()
	if err != nil {
		return "", err
	}
	used, err := s.plugin.usedIPv4Prefixes(ctx)
	if err != nil {
		return "", err
	}
	for range linkNetworkCreateTries {
		subnet, err := allocateLinkSubnet(pool, used)
		if err != nil {
			return "", err
		}
		base := subnet.Addr().As4()
		base[3]++
		_, err = cli.NetworkCreate(ctx, name, mobyclient.NetworkCreateOptions{
			Driver: "bridge", Internal: true,
			Labels: map[string]string{"wiolett.gateway.managed": setMeshNetworkLabel, "wiolett.gateway.availability-set": setID},
			IPAM: &network.IPAM{Driver: "default", Config: []network.IPAMConfig{{
				Subnet: subnet, Gateway: netip.AddrFrom4(base),
			}}},
		})
		if err != nil && strings.Contains(strings.ToLower(err.Error()), "overlap") {
			used = append(used, subnet)
			continue
		}
		if err != nil {
			return "", fmt.Errorf("create availability set network: %w", err)
		}
		s.kick()
		return name, nil
	}
	return "", errors.New("no free subnet for the availability set network could be claimed; try again")
}

// Expose makes host:port on the set's network carry connections to alias. The
// listener binds once the network exists (a background pass retries).
func (s *setMesh) Expose(setID, host string, port uint16, alias string) {
	if _, ok := parseSetPeerAlias(alias); !ok || host == "" || port == 0 {
		return
	}
	s.mu.Lock()
	entry := s.set(setID)
	entry.exposed[host+":"+strconv.Itoa(int(port))] = setMeshExpose{host: host, port: port, alias: alias}
	s.mu.Unlock()
	s.kick()
}

// SetLocalPrimary installs the dialer that serves primary aliases while this
// node's member is the primary (nil removes it).
func (s *setMesh) SetLocalPrimary(setID string, dial setMeshLocalDial) {
	s.mu.Lock()
	s.set(setID).local = dial
	s.mu.Unlock()
}

// ExtraHosts are the hosts entries the set's containers need: every exposed
// host at the network's gateway. Empty until the network was inspected.
func (s *setMesh) ExtraHosts(setID string) []string {
	s.mu.Lock()
	entry := s.sets[setID]
	if entry == nil || !entry.gateway.IsValid() {
		s.mu.Unlock()
		if s.refresh(setID) {
			s.mu.Lock()
			entry = s.sets[setID]
		} else {
			return nil
		}
	}
	defer s.mu.Unlock()
	if entry == nil || !entry.gateway.IsValid() {
		return nil
	}
	hosts := map[string]bool{}
	for _, spec := range entry.exposed {
		hosts[spec.host] = true
	}
	out := make([]string, 0, len(hosts))
	for host := range hosts {
		out = append(out, host+":"+entry.gateway.String())
	}
	sort.Strings(out)
	return out
}

// Gateway is the address the set's containers reach the daemon at.
func (s *setMesh) Gateway(setID string) (netip.Addr, bool) {
	s.mu.Lock()
	entry := s.sets[setID]
	if entry != nil && entry.gateway.IsValid() {
		defer s.mu.Unlock()
		return entry.gateway, true
	}
	s.mu.Unlock()
	if !s.refresh(setID) {
		return netip.Addr{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sets[setID].gateway, true
}

// Release closes the set's listeners and connections and removes its network
// (best effort: containers still attached keep it).
func (s *setMesh) Release(ctx context.Context, setID string) {
	s.mu.Lock()
	entry := s.sets[setID]
	delete(s.sets, setID)
	s.mu.Unlock()
	if entry != nil {
		for _, l := range entry.listeners {
			_ = l.listener.Close()
		}
		for conn := range entry.conns {
			_ = conn.Close()
		}
	}
	if s.plugin != nil && s.plugin.client != nil {
		_, _ = s.plugin.client.cli.NetworkRemove(ctx, setMeshNetworkName(setID), mobyclient.NetworkRemoveOptions{})
	}
}

func (s *setMesh) kick() {
	s.once.Do(func() { go s.run() })
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *setMesh) run() {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
		case <-s.wake:
		}
		s.reconcile()
		timer.Reset(setMeshRetry)
	}
}

// refresh reads the gateway address of the set's network; false when the
// network does not exist (yet).
func (s *setMesh) refresh(setID string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), setMeshInspectWait)
	defer cancel()
	gateway, exists, err := s.inspect(ctx, setMeshNetworkName(setID))
	if err != nil || !exists {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.set(setID)
	if entry.gateway != gateway {
		for key, l := range entry.listeners {
			_ = l.listener.Close()
			delete(entry.listeners, key)
		}
	}
	entry.gateway = gateway
	return true
}

func (s *setMesh) inspectNetwork(ctx context.Context, name string) (netip.Addr, bool, error) {
	if s.plugin == nil || s.plugin.client == nil {
		return netip.Addr{}, false, errors.New("docker is not available")
	}
	inspected, err := s.plugin.client.cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{})
	if isNotFoundErr(err) {
		return netip.Addr{}, false, nil
	}
	if err != nil {
		return netip.Addr{}, false, err
	}
	gateway, err := managedDatabaseNetworkGatewayAddress(inspected.Network)
	if err != nil {
		return netip.Addr{}, false, err
	}
	return gateway, true, nil
}

// reconcile binds every exposed listener whose network exists.
func (s *setMesh) reconcile() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.sets))
	for id := range s.sets {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, setID := range ids {
		if !s.refresh(setID) {
			continue
		}
		s.mu.Lock()
		entry := s.sets[setID]
		var missing []setMeshExpose
		var gateway netip.Addr
		if entry != nil {
			gateway = entry.gateway
			for key, spec := range entry.exposed {
				if entry.listeners[key] == nil {
					missing = append(missing, spec)
				}
			}
		}
		s.mu.Unlock()
		for _, spec := range missing {
			address := net.JoinHostPort(gateway.String(), strconv.Itoa(int(spec.port)))
			listener, err := s.listen(address)
			if err != nil {
				if s.plugin != nil && s.plugin.logger != nil {
					s.plugin.logger.Warn("availability set mesh listener could not bind; retrying", "set_id", setID,
						"alias", spec.alias, "address", address, "error", err)
				}
				continue
			}
			key := spec.host + ":" + strconv.Itoa(int(spec.port))
			s.mu.Lock()
			current := s.sets[setID]
			if current == nil || current.gateway != gateway || current.listeners[key] != nil {
				s.mu.Unlock()
				_ = listener.Close()
				continue
			}
			current.listeners[key] = &setMeshListener{spec: spec, address: gateway, listener: listener}
			s.mu.Unlock()
			go netaccept.Serve(listener, nil, func(conn net.Conn) { s.serve(setID, spec, conn) })
		}
	}
}

func (s *setMesh) track(setID string, conn net.Conn, add bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.sets[setID]
	if entry == nil {
		return
	}
	if add {
		entry.conns[conn] = struct{}{}
	} else {
		delete(entry.conns, conn)
	}
}

// serve carries one container connection to its alias.
func (s *setMesh) serve(setID string, spec setMeshExpose, conn net.Conn) {
	s.track(setID, conn, true)
	defer s.track(setID, conn, false)
	parsed, _ := parseSetPeerAlias(spec.alias)
	if parsed.primary {
		s.mu.Lock()
		var local setMeshLocalDial
		if entry := s.sets[setID]; entry != nil {
			local = entry.local
		}
		s.mu.Unlock()
		if local != nil {
			ctx, cancel := context.WithTimeout(context.Background(), proxyDialTimeoutForMesh)
			upstream, ok := local(ctx, parsed.port)
			cancel()
			if ok && upstream != nil {
				pipeConns(conn, upstream)
				return
			}
		}
		stop := s.closeOnHolderChange(setID, spec.alias, conn)
		defer stop()
	}
	if err := s.bridge(conn, setID, spec.alias); err != nil {
		s.logBridgeFailure(setID, spec.alias, err)
	}
}

// logBridgeFailure reports a member connection the relays could not carry
// (no route to the peer, no relay lane): the first failure of a route as a
// warning, the next ones at info, so a member mesh that cannot open shows in
// the node logs without flooding them.
func (s *setMesh) logBridgeFailure(setID, alias string, err error) {
	if s.plugin == nil || s.plugin.logger == nil {
		return
	}
	key := setID + "/" + alias
	s.mu.Lock()
	if s.warned == nil {
		s.warned = map[string]struct{}{}
	}
	_, seen := s.warned[key]
	s.warned[key] = struct{}{}
	s.mu.Unlock()
	if seen {
		s.plugin.logger.Info("availability member connection could not open its relay route again", "set_id", setID, "alias", alias, "error", err)
		return
	}
	s.plugin.logger.Warn("availability member connection could not open its relay route", "set_id", setID, "alias", alias, "error", err)
}

const proxyDialTimeoutForMesh = 5 * time.Second

// closeOnHolderChange closes conn once the relays' gate views name a holder
// other than the one they named when it opened.
func (s *setMesh) closeOnHolderChange(setID, alias string, conn net.Conn) func() {
	if s.plugin == nil || s.plugin.relayGrants == nil {
		return func() {}
	}
	routes := s.plugin.setPeerRoutes(setID, alias)
	if len(routes) == 0 {
		return func() {}
	}
	policyID := routes[0].GetLeaseTarget().GetLeasePolicyId()
	if policyID == "" {
		return func() {}
	}
	tracker := s.plugin.setGates.tracker()
	opened := tracker.Holder(policyID, time.Now()).HolderID
	done := make(chan struct{})
	go func() {
		for {
			changed := tracker.Changed()
			select {
			case <-done:
				return
			case <-changed:
			}
			holder := tracker.Holder(policyID, time.Now()).HolderID
			if holder == "" {
				continue
			}
			if opened == "" {
				opened = holder
				continue
			}
			if holder != opened {
				_ = conn.Close()
				return
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

// pipeConns copies both ways until either side ends, then closes both.
func pipeConns(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
	<-done
	_ = a.Close()
	_ = b.Close()
}

func uuidLike(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, r := range value {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
				return false
			}
		}
	}
	return true
}
