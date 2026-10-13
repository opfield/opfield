package docker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/docker-daemon/internal/chha"
)

// Keeper witness containers on a docker node (decision 8, second half): a
// ClickHouse set whose witness is a docker node outside the member hosts runs
// its witness Keeper there as a digest-pinned clickhouse-keeper container.
// Opfield sends the desired set with ApplyWitnesses (as to relays); the node
// keeps it on disk and runs it without Opfield. The witness serves its raft
// port through a set witness endpoint of this daemon (owner kind
// managed_availability_witness), and reaches the members' Keeper ports
// through its routes (owner kind managed_witness_peer, `<witness>><member>`):
// the daemon binds each member's loopback endpoint in the witness container's
// network namespace and carries the connections over those routes.
const (
	nodeKeeperWitnessCapability = "node_keeper_witness_v1"
	setWitnessEndpointKind      = "managed_availability_witness"
	keeperWitnessLabel          = "net.opfield.keeper-witness.id"
	keeperWitnessTick           = 5 * time.Second
	keeperWitnessMaxWitnesses   = 20
	keeperWitnessMemory         = 512 << 20
)

// keeperWitnessImages are the pinned Keeper images (config/third-party-images.json)
// by Keeper version; the newest is used for a version this daemon does not know.
var keeperWitnessImages = map[string]string{
	"25.8.28.1": "docker.io/clickhouse/clickhouse-keeper@sha256:79767b4b69aa0425057128c8f741dd31d8052ad5edab2f2839ebfa9c6d3ad3e6",
}

const defaultKeeperWitnessVersion = "25.8.28.1"

var keeperWitnessIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type nodeKeeperWitnesses struct {
	p      *DockerPlugin
	dir    string
	logger *slog.Logger

	mu         sync.Mutex
	revision   uint64
	desired    map[string]*pb.WitnessSpec
	forwarders map[string]*chha.Forwarders
	containers map[string]string
	wake       chan struct{}
}

// startNodeKeeperWitnesses restores the last applied set and runs it.
func (p *DockerPlugin) startNodeKeeperWitnesses() {
	w := &nodeKeeperWitnesses{p: p, dir: filepath.Join(p.cfg.StateDir, "keeper-witnesses"), logger: p.logger,
		desired: map[string]*pb.WitnessSpec{}, forwarders: map[string]*chha.Forwarders{}, containers: map[string]string{},
		wake: make(chan struct{}, 1)}
	if err := w.load(); err != nil && p.logger != nil {
		p.logger.Warn("Keeper witness state could not be restored", "error", err)
	}
	p.keeperWitnesses = w
	go w.loop()
}

func (w *nodeKeeperWitnesses) desiredPath() string { return filepath.Join(w.dir, "desired.json") }

func (w *nodeKeeperWitnesses) load() error {
	data, err := os.ReadFile(w.desiredPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	command := &pb.ApplyWitnessesCommand{}
	if err := protojson.Unmarshal(data, command); err != nil {
		return err
	}
	if err := validateNodeKeeperWitnesses(command.GetWitnesses()); err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.setDesiredLocked(command)
	return nil
}

func (w *nodeKeeperWitnesses) setDesiredLocked(command *pb.ApplyWitnessesCommand) {
	w.revision = command.GetRevision()
	w.desired = map[string]*pb.WitnessSpec{}
	for _, spec := range command.GetWitnesses() {
		w.desired[spec.GetId()] = proto.Clone(spec).(*pb.WitnessSpec)
	}
}

// validateNodeKeeperWitnesses refuses a desired set the daemon would not run.
func validateNodeKeeperWitnesses(specs []*pb.WitnessSpec) error {
	if len(specs) > keeperWitnessMaxWitnesses {
		return fmt.Errorf("at most %d Keeper witnesses per node", keeperWitnessMaxWitnesses)
	}
	ports := map[uint32]string{}
	for _, spec := range specs {
		id := spec.GetId()
		if !keeperWitnessIDPattern.MatchString(id) || spec.GetKind() != "clickhouse_keeper" {
			return fmt.Errorf("witness %q is not a ClickHouse Keeper witness", id)
		}
		if spec.GetServerId() == 0 {
			return fmt.Errorf("witness %s has no server id", id)
		}
		for _, port := range []uint32{spec.GetClientPort(), spec.GetRaftPort()} {
			if port < chha.MeshPortMin || port > chha.MeshPortMax {
				return fmt.Errorf("witness %s: port %d is outside %d-%d", id, port, chha.MeshPortMin, chha.MeshPortMax)
			}
		}
		if other, taken := ports[spec.GetRaftPort()]; taken {
			return fmt.Errorf("witnesses %s and %s use the same raft port", other, id)
		}
		ports[spec.GetRaftPort()] = id
		host, err := netip.ParseAddr(spec.GetRaftHost())
		if err != nil || !host.Is4() || !host.IsLoopback() {
			return fmt.Errorf("witness %s: raft host %q is not a loopback address", id, spec.GetRaftHost())
		}
		for _, peer := range spec.GetPeers() {
			if peer.GetServerId() == 0 || peer.GetHost() != spec.GetRaftHost() || peer.GetRouteId() == "" ||
				peer.GetPort() < chha.MeshPortMin || peer.GetPort() > chha.MeshPortMax {
				return fmt.Errorf("witness %s: peer %d is invalid", id, peer.GetServerId())
			}
		}
	}
	return nil
}

// handleApplyKeeperWitnesses applies Opfield's desired set (a newer revision only).
func (p *DockerPlugin) handleApplyKeeperWitnesses(command *pb.ApplyWitnessesCommand, result *pb.CommandResult) {
	w := p.keeperWitnesses
	if w == nil {
		result.Success, result.Error = false, "this daemon runs no Keeper witnesses"
		return
	}
	if err := validateNodeKeeperWitnesses(command.GetWitnesses()); err != nil {
		result.Success, result.Error = false, err.Error()
		return
	}
	w.mu.Lock()
	current := w.revision
	w.mu.Unlock()
	if command.GetRevision() <= current && current != 0 {
		result.Success, result.Detail = true, fmt.Sprintf("Keeper witness revision %d already applied", current)
		return
	}
	encoded, err := protojson.MarshalOptions{Multiline: true}.Marshal(command)
	if err == nil {
		err = os.MkdirAll(w.dir, 0o700)
	}
	if err == nil {
		err = atomicfile.WriteFile(w.desiredPath(), encoded, 0o600)
	}
	if err != nil {
		result.Success, result.Error = false, "persist the Keeper witness set: "+err.Error()
		return
	}
	w.mu.Lock()
	w.setDesiredLocked(command)
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
	result.Success, result.Detail = true, fmt.Sprintf("Keeper witness revision %d applied: %d witnesses", command.GetRevision(), len(command.GetWitnesses()))
}

func (w *nodeKeeperWitnesses) loop() {
	ticker := time.NewTicker(keeperWitnessTick)
	defer ticker.Stop()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		w.reconcile(ctx)
		cancel()
		select {
		case <-ticker.C:
		case <-w.wake:
		}
	}
}

func keeperWitnessName(id string) string { return "gwkw-" + id }

// reconcile runs every desired witness and removes the others.
func (w *nodeKeeperWitnesses) reconcile(ctx context.Context) {
	w.mu.Lock()
	desired := make(map[string]*pb.WitnessSpec, len(w.desired))
	for id, spec := range w.desired {
		desired[id] = spec
	}
	w.mu.Unlock()
	ids := make([]string, 0, len(desired))
	for id := range desired {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if err := w.ensure(ctx, desired[id]); err != nil && w.logger != nil {
			w.logger.Warn("Keeper witness container could not be run", "witness", id, "error", err)
		}
	}
	running, err := w.p.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true,
		Filters: mobyclient.Filters{}.Add("label", keeperWitnessLabel)})
	if err != nil {
		return
	}
	for _, item := range running.Items {
		id := item.Labels[keeperWitnessLabel]
		if _, keep := desired[id]; keep || id == "" {
			continue
		}
		w.remove(ctx, id, item.ID)
	}
}

// keeperWitnessConfig is the witness's Keeper configuration (chha).
func keeperWitnessConfig(spec *pb.WitnessSpec) ([]byte, error) {
	peers := make([]chha.WitnessPeerEndpoint, 0, len(spec.GetPeers()))
	for _, peer := range spec.GetPeers() {
		peers = append(peers, chha.WitnessPeerEndpoint{ID: peer.GetServerId(), Host: peer.GetHost(), Port: peer.GetPort()})
	}
	return chha.RenderWitnessKeeperConfig(spec.GetServerId(), spec.GetClientPort(), spec.GetRaftPort(), spec.GetRaftHost(), peers)
}

// ensure runs one witness container with its current configuration and its
// forwarders.
func (w *nodeKeeperWitnesses) ensure(ctx context.Context, spec *pb.WitnessSpec) error {
	id := spec.GetId()
	dir := filepath.Join(w.dir, id)
	data := filepath.Join(dir, "data")
	if err := os.MkdirAll(data, 0o750); err != nil {
		return err
	}
	if err := os.Chown(data, clickHouseUID, clickHouseUID); err != nil && !errors.Is(err, os.ErrPermission) {
		return err
	}
	config, err := keeperWitnessConfig(spec)
	if err != nil {
		return err
	}
	configPath := filepath.Join(dir, "keeper.xml")
	changed := true
	if current, err := os.ReadFile(configPath); err == nil && string(current) == string(config) {
		changed = false
	}
	if changed {
		if err := writeClickHouseConfig(configPath, string(config)); err != nil {
			return err
		}
	}
	name := keeperWitnessName(id)
	inspect, err := w.p.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
	exists := err == nil
	if err != nil && !isNotFoundErr(err) {
		return err
	}
	if exists && changed {
		// A changed raft list or port: start again on the new configuration.
		_ = w.p.client.RemoveContainer(ctx, inspect.Container.ID, true)
		exists = false
	}
	if !exists {
		if err := w.create(ctx, spec, name, configPath, data); err != nil {
			return err
		}
		inspect, err = w.p.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
		if err != nil {
			return err
		}
	}
	state := inspect.Container.State
	if state == nil || !state.Running {
		if err := w.p.client.StartContainer(ctx, inspect.Container.ID); err != nil {
			return err
		}
		inspect, err = w.p.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
		if err != nil {
			return err
		}
		state = inspect.Container.State
	}
	if state == nil || !state.Running {
		return errors.New("the Keeper witness container is not running")
	}
	w.mu.Lock()
	fw := w.forwarders[id]
	if fw == nil {
		fw = chha.NewForwarders(chha.ListenInNetns, w.bridge, w.logger)
		w.forwarders[id] = fw
	}
	w.containers[id] = inspect.Container.ID
	w.mu.Unlock()
	desired := map[string]string{}
	for _, peer := range spec.GetPeers() {
		desired[net.JoinHostPort(peer.GetHost(), strconv.FormatUint(uint64(peer.GetPort()), 10))] = peer.GetRouteId()
	}
	if failed := fw.Ensure(inspect.Container.ID, state.Pid, desired); len(failed) > 0 {
		return fmt.Errorf("forwarders failed: %v", failed)
	}
	return nil
}

func (w *nodeKeeperWitnesses) create(ctx context.Context, spec *pb.WitnessSpec, name, configPath, data string) error {
	version := spec.GetArtifact().GetVersion()
	reference, ok := keeperWitnessImages[version]
	if !ok {
		reference = keeperWitnessImages[defaultKeeperWitnessVersion]
	}
	image, err := w.p.client.EnsureThirdPartyImage(ctx, reference)
	if err != nil {
		return err
	}
	netName := name + "-net"
	if _, err := w.p.client.cli.NetworkInspect(ctx, netName, mobyclient.NetworkInspectOptions{}); err != nil {
		if _, err := w.p.client.cli.NetworkCreate(ctx, netName, mobyclient.NetworkCreateOptions{Driver: "bridge",
			Labels: map[string]string{keeperWitnessLabel: spec.GetId()}}); err != nil {
			return fmt.Errorf("create the Keeper witness network: %w", err)
		}
	}
	memory := int64(keeperWitnessMemory)
	_, err = w.p.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Name: name,
		Config: &container.Config{
			Image: image, User: fmt.Sprintf("%d:%d", clickHouseUID, clickHouseUID),
			Entrypoint: []string{chha.WitnessKeeperEntrypoint, "--config-file=" + chha.WitnessKeeperConfigPath},
			Labels:     map[string]string{keeperWitnessLabel: spec.GetId()},
		},
		HostConfig: &container.HostConfig{
			Binds:         []string{data + ":" + chha.WitnessKeeperDataPath, configPath + ":" + chha.WitnessKeeperConfigPath + ":ro"},
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			Resources:     container.Resources{Memory: memory, MemorySwap: memory},
			LogConfig:     container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}},
		},
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{netName: {}}},
	})
	if err != nil {
		return fmt.Errorf("create the Keeper witness container: %w", err)
	}
	return nil
}

// remove stops a witness that left the desired set and drops its data.
func (w *nodeKeeperWitnesses) remove(ctx context.Context, id, containerID string) {
	w.mu.Lock()
	fw := w.forwarders[id]
	delete(w.forwarders, id)
	delete(w.containers, id)
	w.mu.Unlock()
	if fw != nil {
		fw.Close()
	}
	_ = w.p.client.RemoveContainer(ctx, containerID, true)
	_ = w.p.client.RemoveNetwork(ctx, keeperWitnessName(id)+"-net")
	if keeperWitnessIDPattern.MatchString(id) {
		_ = os.RemoveAll(filepath.Join(w.dir, id))
	}
}

// bridge carries a witness's connection to a member over its route (the
// forwarders' key is the route id Opfield named for that peer).
func (w *nodeKeeperWitnesses) bridge(connection net.Conn, routeID string) error {
	p := w.p
	setup := p.handover.Setup()
	defer setup()
	tunnel, err := p.openSetRoutes(func() []*pb.RelayGrantAssignment {
		return p.relayGrants.filter(func(a *pb.RelayGrantAssignment) bool {
			return a.GetRole() == "connect" && a.GetRouteId() == routeID && a.GetOwnerKind() == setWitnessRouteKind
		})
	})
	if err != nil {
		_ = connection.Close()
		return err
	}
	tunnel.started = setup
	tunnel.bridge(connection)
	return nil
}

// witnessServing reports whether the witness behind a witness endpoint runs.
func (p *DockerPlugin) witnessEndpointState(assignment *pb.RelayGrantAssignment) relayv1.EndpointServingState {
	if p.keeperWitnesses == nil {
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	}
	id := assignment.GetLeaseTarget().GetWitnessId()
	if id == "" {
		id = assignment.GetOwnerId()
	}
	if _, _, err := p.keeperWitnesses.target(id); err != nil {
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	}
	return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
}

// target is the witness container's raft address.
func (w *nodeKeeperWitnesses) target(id string) (string, uint32, error) {
	w.mu.Lock()
	spec := w.desired[id]
	containerID := w.containers[id]
	w.mu.Unlock()
	if spec == nil || containerID == "" {
		return "", 0, errors.New("no such Keeper witness on this node")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	inspect, err := w.p.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running || inspect.Container.NetworkSettings == nil {
		return "", 0, errors.New("the Keeper witness container is not running")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[keeperWitnessName(id)+"-net"]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return "", 0, errors.New("the Keeper witness has no address")
	}
	return endpoint.IPAddress.String(), spec.GetRaftPort(), nil
}

// dialWitness connects an incoming tunnel of a witness endpoint to its raft port.
func (p *DockerPlugin) dialWitness(ctx context.Context, assignment *pb.RelayGrantAssignment) (net.Conn, error) {
	if p.keeperWitnesses == nil {
		return nil, errEndpointNotServed
	}
	id := assignment.GetLeaseTarget().GetWitnessId()
	if id == "" {
		id = assignment.GetOwnerId()
	}
	address, port, err := p.keeperWitnesses.target(id)
	if err != nil {
		return nil, err
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, "tcp", net.JoinHostPort(address, strconv.FormatUint(uint64(port), 10)))
}
