package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/securelink"
	"google.golang.org/protobuf/proto"
)

const (
	proxySecureLinkOwnerKind    = "proxy_host_secure_link"
	secureLinkConnectorName     = "gateway-secure-link-connector"
	secureLinkManagementNetwork = "gateway-secure-links"
	developmentSecureLinkImage  = "gateway-secure-link-connector:dev"
	secureLinkConnectorPathEnv  = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	secureLinkRecoveryWindow    = time.Second
)

// secureLinkConnectorRetireLimit bounds how long a replaced connector keeps
// the tunnels that are busy (a request in flight, a WebSocket, a held
// container link session) and the workload sessions of its egress listeners:
// an hour from its replacement; a variable for tests.
var secureLinkConnectorRetireLimit = time.Hour

const secureLinkConnectorRetireTick = 100 * time.Millisecond

// secureLinkDrainSignal tells a connector to stop accepting when its control socket is out of reach (the
// connector's drain_signal.go).
const secureLinkDrainSignal = "SIGUSR1"

// secureLinkConnectorDrainPoll spaces the questions to a draining connector about its open sessions.
var secureLinkConnectorDrainPoll = time.Second

// secureLinkConnectorSlots are the connector containers that take turns: a new
// connector starts in a free slot while the serving one keeps forwarding, and
// the replaced one finishes its sessions in its own slot. Three, so that a
// replacement coming while an earlier one still retires (a second image
// change, a serving connector told to drain) starts next to both instead of
// cutting the sessions the retiring one carries; they also bound how many
// connectors run at once. All share the control directory, each with its own
// socket.
var secureLinkConnectorSlots = [3]struct{ name, socket string }{
	{name: secureLinkConnectorName, socket: "secure-link.sock"},
	{name: secureLinkConnectorName + "-next", socket: "secure-link-next.sock"},
	{name: secureLinkConnectorName + "-third", socket: "secure-link-third.sock"},
}

var immutableConnectorImagePattern = regexp.MustCompile(`^.+@sha256:[0-9a-f]{64}$`)
var officialConnectorReleaseTagPattern = regexp.MustCompile(`^ghcr\.io/(?:opfield/opfield|the-square-labs/gateway)/secure-link-connector:v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?-relay$`)
var proxySecureLinkIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var errSecureLinkTargetUnavailable = errors.New("target container is unavailable")

// secureLinkTargetUnknownError is a target check dockerd did not answer: the
// target may run or not. Every caller reads it as errSecureLinkTargetUnavailable
// (the same text, which Opfield parses); apply keeps a link bound to that same
// target instead (B-24).
type secureLinkTargetUnknownError struct{ cause error }

func (e secureLinkTargetUnknownError) Error() string { return errSecureLinkTargetUnavailable.Error() }
func (e secureLinkTargetUnknownError) Unwrap() error { return e.cause }
func (e secureLinkTargetUnknownError) Is(target error) bool {
	return target == errSecureLinkTargetUnavailable
}

// secureLinkConnectorUnchangedError is an ensureConnector failure before it
// changed anything (dockerd did not answer its first checks): the connector
// and its bindings are as they were, and apply leaves them serving (B-24).
type secureLinkConnectorUnchangedError struct{ err error }

func (e secureLinkConnectorUnchangedError) Error() string { return e.err.Error() }
func (e secureLinkConnectorUnchangedError) Unwrap() error { return e.err }

type dockerSecureLinkManager struct {
	mu         sync.Mutex
	plugin     *DockerPlugin
	socketPath string
	bindings   map[string]dockerSecureLinkBinding
	// unbound are committed links left out of the connector because their
	// target was unavailable (a dormant standby, or a stopped target on
	// restore); a later restore binds them once the target runs.
	unbound      map[string]struct{}
	attached     map[string]struct{}
	connectorID  string
	managementIP string
	// slot is the secureLinkConnectorSlots entry of connectorID.
	slot int
	// controlDir is the connectors' control socket directory (controlDirectory).
	controlDir string
	// retiring are the connectors being retired, recorded across daemon starts (secure_link_retiring.go).
	retiring retiringConnectors
	// abandoning is set while an egress sync goes on with a new connector after the serving one refused it because it
	// drains; guarded by mu.
	abandoning bool
	// resolveTargetForDial replaces resolveTarget in dial validation (tests).
	resolveTargetForDial func(ctx context.Context, containerName, networkName, expectedHost string, allowNetworkReselection bool) (string, string, error)

	recoveryMu sync.Mutex
	recovery   *dockerSecureLinkRecovery

	// dockerQuietUntil: dockerd did not answer a dial's target validation; until
	// then dials skip it (see validateDialTarget).
	dockerQuietMu    sync.Mutex
	dockerQuietUntil time.Time

	// validated and validating share a link's target check between the dials
	// of a moment (see validateDialTarget); guarded by validationMu.
	validationMu sync.Mutex
	validated    map[string]dialValidation
	validating   map[string]*dialValidation

	// view is what dials read: a copy of bindings, unbound and managementIP
	// published after every change. apply holds mu across dockerd calls, and a
	// dial must not wait for them (B-8, D5).
	viewMu sync.RWMutex
	view   *dockerSecureLinkView

	// probeRestoreAt is when a readiness probe last restored bindings (unix ns).
	probeRestoreAt atomic.Int64

	// egress is the connector's egress side (secure_link_egress.go): the links of this node's workloads to
	// targets elsewhere, from the relay grant bundle. Guarded by mu, apart from its published view.
	egress secureLinkEgress
	// egressRun applies the grant bundles' egress in the background of their ACKs (secure_link_egress_runner.go).
	egressRun egressRunner
	// anchorID is the container holding the connector's network namespace (secure_link_anchor.go); guarded by mu.
	anchorID string
	// anchorImages caches which connector images can run the anchor (anchorSupported); guarded by mu.
	anchorImages map[string]bool
	// pendingRetire is a replaced connector that keeps accepting until every egress listens on its replacement
	// (reconcileEgressLocked); guarded by mu.
	pendingRetire *connectorRuntime
	// pendingRetireSince is when pendingRetire was replaced, and pendingRetireLogged whether its wait was logged;
	// guarded by mu.
	pendingRetireSince  time.Time
	pendingRetireLogged bool
	// replaced records pendingRetire with the end of its retirement across daemon starts (secureLinkReplacedFile).
	replaced retiringConnectors
	// managementGateway is the management network's gateway, the daemon's address towards the connector: the only
	// peer the ingress listeners accept (guarded by mu).
	managementGateway string
}

type dockerSecureLinkView struct {
	bindings     map[string]dockerSecureLinkBinding
	unbound      map[string]struct{}
	managementIP string
	connectorID  string
}

// publishViewLocked publishes the binding state for dials. Callers hold mu.
// The maps are replaced, never changed in place, so the view may share them.
func (m *dockerSecureLinkManager) publishViewLocked() {
	m.viewMu.Lock()
	m.view = &dockerSecureLinkView{bindings: m.bindings, unbound: m.unbound, managementIP: m.managementIP, connectorID: m.connectorID}
	m.viewMu.Unlock()
}

func (m *dockerSecureLinkManager) currentView() *dockerSecureLinkView {
	m.viewMu.RLock()
	view := m.view
	m.viewMu.RUnlock()
	if view == nil {
		// Built without newDockerSecureLinkManager (tests): read the fields.
		m.mu.Lock()
		view = &dockerSecureLinkView{bindings: m.bindings, unbound: m.unbound, managementIP: m.managementIP, connectorID: m.connectorID}
		m.mu.Unlock()
	}
	return view
}

// dialState returns a link's binding for a dial without waiting for apply.
func (m *dockerSecureLinkManager) dialState(linkID string) (binding dockerSecureLinkBinding, bound, unbound bool, host string) {
	view := m.currentView()
	binding, bound = view.bindings[linkID]
	_, unbound = view.unbound[linkID]
	return binding, bound, unbound, view.managementIP
}

const (
	// secureLinkValidateWait bounds the dockerd call a new tunnel makes to
	// validate its target (B-8, D5): a dial waits at most this long before it
	// uses the target the link is bound to (B-26).
	secureLinkValidateWait = 300 * time.Millisecond
	// secureLinkDockerQuiet is how long dials skip that call after dockerd
	// did not answer it; the first dial after it tries again.
	secureLinkDockerQuiet = 2 * time.Second
	// secureLinkValidateTTL is how long a validated target is trusted by the
	// dials that follow (B-22): every relayed connection used to ask dockerd,
	// which under load queued the connections behind dockerd.
	secureLinkValidateTTL = 2 * time.Second
)

// dialValidation is a target check that ran or runs for one link.
type dialValidation struct {
	binding dockerSecureLinkBinding
	at      time.Time
	done    chan struct{}
	err     error
}

type dockerSecureLinkRecovery struct {
	done        chan struct{}
	err         error
	completedAt time.Time
}

type dockerSecureLinkBinding struct {
	generation      uint64
	port            uint16
	targetContainer string
	targetNetwork   string
	targetHost      string
}

type dockerSecureLinkStatus struct {
	LinkID        string `json:"linkId"`
	Generation    uint64 `json:"generation"`
	Port          uint16 `json:"port"`
	TargetNetwork string `json:"targetNetwork"`
}

type resolvedSecureLinkTarget struct {
	binding *pb.ProxySecureLinkBinding
	host    string
	network string
}

func newDockerSecureLinkManager(plugin *DockerPlugin) (*dockerSecureLinkManager, error) {
	directory := filepath.Join(plugin.cfg.StateDir, "secure-link-connector")
	if runsWithoutRoot() {
		// The connector creates its sockets here through the daemon's group (connectorGroupAdd); setgid gives them
		// that group, so the daemon can connect to them.
		if err := claimConnectorDirectory(directory, 0o770|os.ModeSetgid); err != nil {
			return nil, fmt.Errorf("secure-link control directory: %w", err)
		}
	} else {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return nil, err
		}
		if err := os.Chown(directory, 65532, 65532); err != nil {
			return nil, fmt.Errorf("secure-link control directory ownership: %w", err)
		}
		// A directory a non-root daemon left behind is group-writable for that daemon's user.
		if err := os.Chmod(directory, 0o750); err != nil {
			return nil, fmt.Errorf("secure-link control directory permissions: %w", err)
		}
	}
	// The connectors of the other mode keep their access through a switch of the daemon's user (connector_access_acl.go).
	if err := grantConnectorAccess(directory, 7); err != nil && plugin.logger != nil {
		plugin.logger.Warn("secure-link control directory keeps its connectors' access only by its mode", "error", err)
	}
	manager := &dockerSecureLinkManager{
		plugin: plugin, socketPath: filepath.Join(directory, "secure-link.sock"), controlDir: directory,
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.retiring.file = filepath.Join(plugin.cfg.StateDir, secureLinkRetiringFile)
	manager.replaced.file = filepath.Join(plugin.cfg.StateDir, secureLinkReplacedFile)
	manager.loadEgressAddresses(plugin.cfg.StateDir)
	manager.publishViewLocked()
	return manager, nil
}

// restore re-applies the committed bindings after a daemon or connector
// restart. Unlike an Opfield sync it works per binding: a link whose target
// cannot be resolved (a container that is stopped or gone) is left out and
// stays committed, and every other link on the node is bound. A later
// restore, on dial or before a lease holder serves, binds it once it runs.
func (m *dockerSecureLinkManager) restore(command *pb.SyncProxySecureLinksCommand) ([]dockerSecureLinkStatus, error) {
	return m.apply(command, nil, nil, true)
}

// syncWithPersistence applies an Opfield sync: the complete target set must
// resolve (dormant standbys aside) before anything is saved or changed.
func (m *dockerSecureLinkManager) syncWithPersistence(
	command *pb.SyncProxySecureLinksCommand,
	stage func(*pb.SyncProxySecureLinksCommand) error,
	commit func(*pb.SyncProxySecureLinksCommand) error,
) ([]dockerSecureLinkStatus, error) {
	return m.apply(command, stage, commit, false)
}

func (m *dockerSecureLinkManager) apply(
	command *pb.SyncProxySecureLinksCommand,
	stage func(*pb.SyncProxySecureLinksCommand) error,
	commit func(*pb.SyncProxySecureLinksCommand) error,
	perBinding bool,
) ([]dockerSecureLinkStatus, error) {
	if command == nil {
		return nil, errors.New("proxy secure-link bindings are required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	bindings := append([]*pb.ProxySecureLinkBinding(nil), command.Bindings...)
	sort.Slice(bindings, func(i, j int) bool { return bindings[i].LinkId < bindings[j].LinkId })
	if len(bindings) == 0 {
		candidate := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
		if stage != nil {
			if err := stage(candidate); err != nil {
				return nil, err
			}
		}
		// The connector stays while it serves egress (D5): only its ingress bindings go.
		if err := m.releaseIngressLocked(context.Background()); err != nil {
			m.failClosed(context.Background())
			return nil, err
		}
		if commit != nil {
			if err := commit(candidate); err != nil {
				return nil, err
			}
		}
		return []dockerSecureLinkStatus{}, nil
	}

	image := bindings[0].ConnectorImage
	if !allowedSecureLinkConnectorImage(image) {
		return nil, errors.New("secure-link connector image must use an immutable sha256 digest or an official Opfield Relay release tag")
	}
	seen := map[string]struct{}{}
	for _, binding := range bindings {
		if binding.Role != "target" || !proxySecureLinkIDPattern.MatchString(binding.LinkId) || binding.TargetPort == 0 || binding.TargetPort > 65535 || binding.TargetContainer == "" || binding.ConnectorImage != image {
			return nil, errors.New("invalid proxy secure-link target binding")
		}
		if _, duplicate := seen[binding.LinkId]; duplicate {
			return nil, fmt.Errorf("duplicate proxy secure-link binding %s", binding.LinkId)
		}
		seen[binding.LinkId] = struct{}{}
		if current, exists := m.bindings[binding.LinkId]; exists && binding.Generation < current.generation {
			return nil, fmt.Errorf("stale generation for proxy secure-link %s", binding.LinkId)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	kept := 0
	resolved, desiredNetworks, skipped, err := resolveSecureLinkTargets(bindings, func(binding *pb.ProxySecureLinkBinding) (string, string, error) {
		host, network, err := m.resolveTarget(ctx, binding.TargetContainer, binding.TargetNetwork, binding.TargetHost, binding.AllowNetworkReselection)
		var unknown secureLinkTargetUnknownError
		if err != nil && errors.As(err, &unknown) {
			if current, ok := m.boundTargetLocked(binding); ok {
				kept++
				return current.targetHost, current.targetNetwork, nil
			}
		}
		return host, network, err
	}, perBinding)
	if err != nil {
		return nil, err
	}
	if kept > 0 && m.plugin != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("dockerd did not answer secure-link target checks; bound links keep their targets", "links", kept)
	}
	unbound := make(map[string]struct{}, len(skipped))
	for _, skip := range skipped {
		unbound[skip.binding.LinkId] = struct{}{}
		// A lease-bound member's container runs only while this node holds the lease.
		if !leaseBoundTarget(skip.binding) && m.plugin != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("proxy secure-link left unbound until its target runs", "link_id", skip.binding.LinkId, "target_container", skip.binding.TargetContainer, "error", skip.err)
		}
	}
	// Resolve and validate the complete target set before the write-ahead save,
	// so an invalid command cannot poison restart recovery for existing links.
	candidate := normalizeResolvedTargetBindings(command, resolved)
	if stage != nil {
		if err := stage(candidate); err != nil {
			return nil, err
		}
	}
	replacement, err := m.ensureConnector(ctx, image, true)
	if err != nil {
		var unchanged secureLinkConnectorUnchangedError
		if !errors.As(err, &unchanged) {
			m.failClosed(context.Background())
		}
		return nil, err
	}
	// A failure from here on refuses new tunnels until a retry, unless a
	// replacement connector was being bound: then the previous connector
	// keeps serving its links as before.
	fail := func(err error) error {
		if replacement != nil {
			m.abortReplacement(replacement)
		} else {
			m.failClosed(context.Background())
		}
		return err
	}
	resolvedByID := make(map[string]resolvedSecureLinkTarget, len(resolved))
	for _, target := range resolved {
		resolvedByID[target.binding.LinkId] = target
	}
	bind := func() (*securelink.SyncResponse, error) {
		for networkName := range desiredNetworks {
			if _, attached := m.attached[networkName]; attached {
				continue
			}
			if _, err := m.plugin.client.cli.NetworkConnect(ctx, networkName, mobyclient.NetworkConnectOptions{Container: m.networkHolder()}); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
				return nil, fmt.Errorf("attach secure-link connector to %s: %w", networkName, err)
			}
			m.attached[networkName] = struct{}{}
		}
		configs := make([]securelink.BindingConfig, 0, len(resolved))
		for _, target := range resolved {
			binding := target.binding
			configs = append(configs, securelink.BindingConfig{
				ID: binding.LinkId, Generation: binding.Generation, ListenHost: m.managementIP,
				TargetHost: target.host, TargetPort: uint16(binding.TargetPort),
			})
		}
		return m.syncConnectorLocked(ctx, configs)
	}
	response, err := bind()
	if replacement == nil && securelink.IsShuttingDown(err) {
		// The connector was told to drain: it never serves again. The links go to a new one at once.
		m.abandonDrainingConnectorLocked()
		if replacement, err = m.ensureConnector(ctx, image, true); err == nil {
			response, err = bind()
		}
	}
	if err != nil {
		return nil, fail(err)
	}
	next := make(map[string]dockerSecureLinkBinding, len(response.Bindings))
	statuses := make([]dockerSecureLinkStatus, 0, len(response.Bindings))
	for _, status := range response.Bindings {
		target, ok := resolvedByID[status.ID]
		if !ok {
			return nil, fail(fmt.Errorf("secure-link connector returned unknown binding %s", status.ID))
		}
		next[status.ID] = dockerSecureLinkBinding{
			generation: status.Generation, port: status.Port,
			targetContainer: target.binding.TargetContainer,
			targetNetwork:   target.network, targetHost: target.host,
		}
		statuses = append(statuses, dockerSecureLinkStatus{LinkID: status.ID, Generation: status.Generation, Port: status.Port, TargetNetwork: target.network})
	}
	if len(next) != len(resolved) {
		return nil, fail(errors.New("secure-link connector returned an incomplete binding set"))
	}
	m.bindings = next
	m.unbound = unbound
	m.publishViewLocked()
	for networkName := range m.attached {
		if _, keep := desiredNetworks[networkName]; keep || m.egress.networkDesired(networkName) {
			continue
		}
		if _, err := m.plugin.client.cli.NetworkDisconnect(ctx, networkName, mobyclient.NetworkDisconnectOptions{Container: m.networkHolder(), Force: true}); err != nil && !isNotFoundErr(err) {
			return nil, fail(fmt.Errorf("detach secure-link connector from %s: %w", networkName, err))
		}
		delete(m.attached, networkName)
	}
	if commit != nil {
		if err := commit(candidate); err != nil {
			// The live apply cannot be treated as accepted when its committed
			// snapshot failed. Refuse new tunnels and best-effort remove the
			// connector bindings until control-plane reconciliation retries.
			return nil, fail(fmt.Errorf("commit proxy secure-link state: %w", err))
		}
	}
	m.egress.ingressNetworks = desiredNetworks
	if replacement != nil {
		if m.plugin.logger != nil {
			m.plugin.logger.Info("secure-link connector replaced; the previous one is retired once its tunnels are idle", "image", image)
		}
		m.setPendingRetireLocked(replacement.previous)
	}
	if m.egress.wanted() || len(m.egress.configs) > 0 {
		// The connector may be new (a replacement, a restore): its egress listeners follow its ingress bindings, on
		// the same addresses as the previous one's (SO_REUSEPORT). The previous one stops accepting only once every
		// egress listens here too; until then it keeps serving them, and a later reconcile retires it.
		m.reconcileEgressLocked(ctx)
	}
	if m.pendingRetire != nil && !m.egress.wanted() {
		// No egress: only its tunnels hold the previous connector.
		m.retirePendingLocked()
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].LinkID < statuses[j].LinkID })
	return statuses, nil
}

// boundTargetLocked returns the target a link is bound to when the command
// keeps it there: the same container, address and network. dockerd not
// answering a check is no evidence that the target stopped, and only dockerd
// can hand its address to another container (B-8, D5): a sync or restore that
// runs while dockerd is frozen or overloaded must not unbind a serving link
// (B-24). Callers hold mu.
func (m *dockerSecureLinkManager) boundTargetLocked(binding *pb.ProxySecureLinkBinding) (dockerSecureLinkBinding, bool) {
	current, ok := m.bindings[binding.LinkId]
	if !ok || current.targetHost == "" || current.targetContainer != binding.TargetContainer {
		return dockerSecureLinkBinding{}, false
	}
	if binding.TargetHost != "" && binding.TargetHost != current.targetHost {
		return dockerSecureLinkBinding{}, false
	}
	if binding.TargetNetwork != "" && binding.TargetNetwork != current.targetNetwork {
		return dockerSecureLinkBinding{}, false
	}
	return current, true
}

// skippedSecureLinkTarget is a binding left out of the connector.
type skippedSecureLinkTarget struct {
	binding *pb.ProxySecureLinkBinding
	err     error
}

// resolveSecureLinkTargets resolves every target binding. An availability
// member whose container is stopped is left out of the connector, stays in the
// committed state, and is bound by the restore that runs once this node serves
// the lease: a dormant member targets a created, stopped standby (D7), and a
// lease-gated member serves only while its node holds the lease (D8), which
// Opfield learns after the fact. perBinding (restore) leaves out every binding
// whose target does not resolve, so one missing target cannot take the other
// links of the node down with it.
func resolveSecureLinkTargets(
	bindings []*pb.ProxySecureLinkBinding,
	resolve func(*pb.ProxySecureLinkBinding) (string, string, error),
	perBinding bool,
) ([]resolvedSecureLinkTarget, map[string]struct{}, []skippedSecureLinkTarget, error) {
	networks := map[string]struct{}{}
	resolved := make([]resolvedSecureLinkTarget, 0, len(bindings))
	var skipped []skippedSecureLinkTarget
	for _, binding := range bindings {
		host, network, err := resolve(binding)
		if err != nil {
			if perBinding || (errors.Is(err, errSecureLinkTargetUnavailable) && leaseBoundTarget(binding)) {
				skipped = append(skipped, skippedSecureLinkTarget{binding: binding, err: err})
				continue
			}
			return nil, nil, nil, fmt.Errorf("resolve secure-link %s: %w", binding.LinkId, err)
		}
		networks[network] = struct{}{}
		resolved = append(resolved, resolvedSecureLinkTarget{binding: binding, host: host, network: network})
	}
	return resolved, networks, skipped, nil
}

// leaseBoundTarget reports whether a stopped target is expected: the member of
// a standby placement, or of a lease-mode policy, whose container runs only
// while its node holds the data-plane lease.
func leaseBoundTarget(binding *pb.ProxySecureLinkBinding) bool {
	return binding.GetDormant() || binding.GetAvailabilityPolicyId() != ""
}

func allowedSecureLinkConnectorImage(image string) bool {
	return image == developmentSecureLinkImage ||
		immutableConnectorImagePattern.MatchString(image) ||
		officialConnectorReleaseTagPattern.MatchString(image)
}

// failClosed prevents a partially applied connector state from accepting new
// relay streams. The committed snapshot remains available for a clean retry.
// Only the ingress bindings go: the egress listeners stand on their own (D5).
func (m *dockerSecureLinkManager) failClosed(ctx context.Context) {
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.unbound = nil
	m.publishViewLocked()
	cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, _ = m.syncConnectorLocked(cleanupCtx, nil)
}

// ensureConnector makes the connector run the image. A connector that serves
// links and runs another image (the connector image a Relay update promoted)
// is not replaced in place: that left every Secure Link route of the node
// without a connector until the new one was pulled, started and bound (seconds
// of failed requests on every route). The new connector starts
// in a free slot next to it instead; the returned replacement is switched
// to by apply once its links are bound, and the previous connector is retired
// after its tunnels drained. Without replace (a caller that would discard the
// replacement) the running connector stays as it is: a replacement may free its
// slot by cutting a retiring connector, which must not happen for nothing.
func (m *dockerSecureLinkManager) ensureConnector(ctx context.Context, image string, replace bool) (*connectorReplacement, error) {
	managementNetwork, err := m.plugin.client.cli.NetworkInspect(ctx, secureLinkManagementNetwork, mobyclient.NetworkInspectOptions{})
	if err == nil && !validSecureLinkManagementNetwork(managementNetwork.Network) {
		return nil, errors.New("refusing to use a non-managed or externally reachable secure-link management network")
	}
	if err != nil {
		if !isNotFoundErr(err) {
			return nil, secureLinkConnectorUnchangedError{fmt.Errorf("inspect secure-link management network: %w", err)}
		}
		if _, err := m.plugin.client.cli.NetworkCreate(ctx, secureLinkManagementNetwork, mobyclient.NetworkCreateOptions{
			Driver: "bridge", Internal: true, Labels: map[string]string{"net.opfield.managed": "secure-link"},
		}); err != nil {
			return nil, fmt.Errorf("create secure-link management network: %w", err)
		}
		if managementNetwork, err = m.plugin.client.cli.NetworkInspect(ctx, secureLinkManagementNetwork, mobyclient.NetworkInspectOptions{}); err != nil {
			return nil, fmt.Errorf("inspect secure-link management network: %w", err)
		}
	}
	// The daemon dials the ingress listeners from the management network's gateway: the only peer they accept.
	gateway, err := managedDatabaseNetworkGatewayAddress(managementNetwork.Network)
	if err != nil {
		return nil, fmt.Errorf("secure-link management network: %w", err)
	}
	m.managementGateway = gateway.String()
	supported, err := m.anchorSupported(ctx, image)
	if err != nil {
		return nil, secureLinkConnectorUnchangedError{err}
	}
	var anchor *container.InspectResponse
	if supported {
		if anchor, err = m.ensureAnchor(ctx, image); err != nil {
			return nil, err
		}
	} else {
		// An image of an earlier release: the connector runs in its own namespace, as that release ran it.
		m.anchorID = ""
	}

	slot, inspect, err := m.findConnector(ctx, image)
	if err != nil {
		return nil, secureLinkConnectorUnchangedError{err}
	}
	controlDirectory := m.controlDirectory()
	// A running connector of this node that no longer fits (another image, other limits, environment or labels, a
	// connector outside the anchor) may carry sessions: the new one starts next to it and it drains (F-C9). Only a
	// stopped one is replaced in place.
	if inspect != nil && inspect.State != nil && inspect.State.Running && ownedSecureLinkConnector(*inspect) &&
		!validSecureLinkConnector(*inspect, image, controlDirectory, m.anchorID) {
		if inspect.ID != m.connectorID {
			// Found at a daemon start: it becomes the serving connector the replacement drains.
			if err := m.adoptConnectorLocked(ctx, *inspect, slot, controlDirectory); err != nil && m.plugin.logger != nil {
				m.plugin.logger.Warn("could not take over the running secure-link connector; it is replaced in place", "error", err)
			}
		}
		if inspect.ID == m.connectorID {
			if !replace {
				m.publishViewLocked()
				return nil, nil
			}
			return m.startReplacement(ctx, image, slot)
		}
	}
	if inspect != nil && !validSecureLinkConnector(*inspect, image, controlDirectory, m.anchorID) {
		if !ownedSecureLinkConnector(*inspect) {
			return nil, errors.New("refusing to replace a non-managed container using the secure-link connector name")
		}
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspect.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil {
			return nil, fmt.Errorf("replace unsafe or outdated secure-link connector: %w", err)
		}
		inspect = nil
	}
	if inspect == nil {
		if inspect, err = m.createConnector(ctx, image, slot); err != nil {
			return nil, err
		}
	} else if inspect.State == nil || !inspect.State.Running || (anchor != nil && joinedBeforeAnchorStart(*inspect, *anchor)) {
		// Stopped, or running in the namespace of the anchor's previous run (the anchor restarted): start it again.
		if inspect.State != nil && inspect.State.Running {
			_, err = m.plugin.client.cli.ContainerRestart(ctx, inspect.ID, mobyclient.ContainerRestartOptions{})
		} else {
			_, err = m.plugin.client.cli.ContainerStart(ctx, inspect.ID, mobyclient.ContainerStartOptions{})
		}
		if err != nil {
			return nil, fmt.Errorf("start existing secure-link connector: %w", err)
		}
		started, err := m.plugin.client.cli.ContainerInspect(ctx, inspect.ID, mobyclient.ContainerInspectOptions{})
		if err != nil {
			return nil, err
		}
		inspect = &started.Container
	} else if err := m.updateConnectorMemory(ctx, *inspect); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("secure-link connector keeps its memory limit", "error", err)
	}
	holder := inspect
	if anchor != nil {
		holder = anchor
	}
	runtime, err := connectorRuntimeOf(*inspect, holder.NetworkSettings, slot, controlDirectory)
	if err != nil {
		return nil, err
	}
	m.useConnector(runtime)
	m.publishViewLocked()
	if err := waitForConnectorSocket(ctx, m.socketPath); err != nil {
		return nil, err
	}
	if anchor == nil {
		m.removeUnusedAnchor(ctx)
	}
	// The connector of this mode serves: the control directory a mode switch set aside can go.
	if m.plugin.cfg != nil && len(setAsideDirectories(m.plugin.cfg.StateDir, "secure-link-connector")) > 0 {
		go m.plugin.removeSetAsideConnectorDirectories(context.Background(), "secure-link-connector", image)
	}
	return nil, nil
}

// connectorRuntime is the connector container dials and syncs use.
type connectorRuntime struct {
	id, managementIP, socketPath string
	slot                         int
	attached                     map[string]struct{}
}

// connectorReplacement is a connector started next to the serving one. Until
// apply switches to it, dials keep using previous, whose links stay bound.
type connectorReplacement struct {
	previous         connectorRuntime
	previousBindings map[string]dockerSecureLinkBinding
	previousUnbound  map[string]struct{}
	// The ingress configs the previous connector holds, which an egress sync sends it again.
	previousIngress    []securelink.BindingConfig
	previousIngressFor string
}

func (m *dockerSecureLinkManager) useConnector(runtime connectorRuntime) {
	m.connectorID = runtime.id
	m.managementIP = runtime.managementIP
	m.socketPath = runtime.socketPath
	m.slot = runtime.slot
	m.attached = runtime.attached
}

// connectorRuntimeOf describes a connector running in the anchor, whose network settings (anchorNetwork) hold the
// addresses.
func connectorRuntimeOf(inspect container.InspectResponse, anchorNetwork *container.NetworkSettings, slot int, controlDirectory string) (connectorRuntime, error) {
	if anchorNetwork == nil {
		return connectorRuntime{}, errors.New("secure-link anchor network settings are unavailable")
	}
	endpoint := anchorNetwork.Networks[secureLinkManagementNetwork]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return connectorRuntime{}, errors.New("secure-link connector management address is unavailable")
	}
	attached := map[string]struct{}{}
	for name := range anchorNetwork.Networks {
		if name != secureLinkManagementNetwork {
			attached[name] = struct{}{}
		}
	}
	return connectorRuntime{
		id: inspect.ID, managementIP: endpoint.IPAddress.String(), slot: slot, attached: attached,
		socketPath: filepath.Join(controlDirectory, secureLinkConnectorSlots[slot].socket),
	}, nil
}

// findConnector returns the connector to keep using and its slot (nil when
// there is none: the slot to create it in). The serving connector stays; after
// a daemon start, the one already running the image wins, and any other is
// left from a replacement this process did not finish: it retires when it
// still carries sessions and goes otherwise. A connector being retired
// (secure_link_retiring.go) is never used again: it drains, so it would refuse
// every binding and connection. It finishes its sessions in its slot; only
// when every slot holds one and a new connector must start is the one whose
// retirement ends first cut.
func (m *dockerSecureLinkManager) findConnector(ctx context.Context, image string) (int, *container.InspectResponse, error) {
	found := [len(secureLinkConnectorSlots)]*container.InspectResponse{}
	retiringBefore := m.retiring.snapshot()
	for slot, candidate := range secureLinkConnectorSlots {
		if m.connectorID != "" && slot != m.slot {
			// Serving: the other slots hold at most connectors being retired.
			continue
		}
		inspect, err := m.plugin.client.cli.ContainerInspect(ctx, candidate.name, mobyclient.ContainerInspectOptions{})
		if err != nil {
			if isNotFoundErr(err) {
				continue
			}
			return 0, nil, fmt.Errorf("inspect secure-link connector: %w", err)
		}
		found[slot] = &inspect.Container
	}
	if m.connectorID != "" {
		return m.slot, found[m.slot], nil
	}
	// Every slot was inspected (a daemon start, or the serving connector given up): records of connectors that no
	// longer exist go.
	present := map[string]bool{}
	for _, inspect := range found {
		if inspect != nil {
			present[inspect.ID] = true
		}
	}
	if err := m.retiring.prune(present); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not drop the records of secure-link connectors that no longer exist", "error", err)
	}
	controlDirectory := m.controlDirectory()
	retiring := [len(secureLinkConnectorSlots)]bool{}
	for slot, inspect := range found {
		// The connector a replacement keeps accepting until every egress listens on its successor carries sessions too.
		retiring[slot] = inspect != nil && (retiringBefore[inspect.ID] || m.pendingRetire != nil && m.pendingRetire.id == inspect.ID)
	}
	chosen := -1
	for _, preferred := range []func(*container.InspectResponse) bool{
		func(inspect *container.InspectResponse) bool {
			return validSecureLinkConnector(*inspect, image, controlDirectory, m.anchorID)
		},
		func(inspect *container.InspectResponse) bool {
			return managedSecureLinkConnector(*inspect, controlDirectory)
		},
		func(*container.InspectResponse) bool { return true },
	} {
		for slot, inspect := range found {
			if chosen < 0 && inspect != nil && !retiring[slot] && preferred(inspect) {
				chosen = slot
			}
		}
	}
	for slot, inspect := range found {
		if slot == chosen || inspect == nil || retiring[slot] || !ownedSecureLinkConnector(*inspect) {
			continue
		}
		kept, err := m.settleLeftoverLocked(ctx, *inspect, slot)
		if err != nil {
			return 0, nil, fmt.Errorf("remove leftover secure-link connector: %w", err)
		}
		if kept {
			retiring[slot] = true
			continue
		}
		found[slot] = nil
	}
	if chosen < 0 && !slices.Contains(found[:], nil) {
		// Every slot holds a connector finishing its sessions, and none can serve (the serving one was told to drain
		// while the others retire): the one whose retirement ends first goes to make room for a new one.
		if oldest := m.oldestRetiringSlotLocked(found, retiring); oldest >= 0 {
			if err := m.cutOldestRetirementLocked(ctx, *found[oldest], oldest); err != nil {
				return 0, nil, fmt.Errorf("remove retiring secure-link connector: %w", err)
			}
			found[oldest] = nil
		}
	}
	for slot, inspect := range found {
		if inspect != nil && retiring[slot] && ownedSecureLinkConnector(*inspect) {
			m.resumeRetirementLocked(*inspect, slot)
		}
	}
	// A replaced connector the record names was settled above (it retires by its recorded deadline or is gone), serves,
	// or no longer exists: only the one this process still keeps accepting needs its record.
	m.forgetReplacedLocked()
	if chosen < 0 {
		// None to keep: a new one starts in a slot no retiring connector holds.
		for slot, inspect := range found {
			if inspect == nil {
				return slot, nil, nil
			}
		}
		return 0, nil, errors.New("no free secure-link connector slot")
	}
	return chosen, found[chosen], nil
}

// startReplacement starts the connector for the image in a free slot. Any
// failure leaves the serving connector and its links as they were. A
// replacement never waits for a slot: while every other slot holds a connector
// finishing its sessions, the one whose retirement ends first goes with them.
func (m *dockerSecureLinkManager) startReplacement(ctx context.Context, image string, slot int) (*connectorReplacement, error) {
	unchanged := func(err error) (*connectorReplacement, error) {
		return nil, secureLinkConnectorUnchangedError{err}
	}
	next, occupant, retiring, err := m.replacementSlotLocked(ctx, slot)
	if err != nil {
		return unchanged(err)
	}
	if image != developmentSecureLinkImage {
		// Pulled while the serving connector still forwards every link.
		if err := m.plugin.client.EnsureImage(ctx, image, ""); err != nil {
			return unchanged(fmt.Errorf("ensure secure-link connector image: %w", err))
		}
	}
	if occupant != nil {
		if retiring {
			err = m.cutOldestRetirementLocked(ctx, *occupant, next)
		} else {
			var sessions int
			if sessions, err = m.cutConnectorLocked(ctx, *occupant, next); err == nil && sessions > 0 && m.plugin.logger != nil {
				m.plugin.logger.Warn("a leftover secure-link connector was removed with the sessions it carried", "connector", occupant.ID, "sessions", sessions)
			}
		}
		if err != nil {
			return unchanged(fmt.Errorf("remove secure-link connector %s: %w", secureLinkConnectorSlots[next].name, err))
		}
	}
	inspect, err := m.createConnector(ctx, image, next)
	if err == nil {
		var runtime connectorRuntime
		holder := mobyclient.ContainerInspectResult{Container: *inspect}
		if m.anchorID != "" {
			holder, err = m.plugin.client.cli.ContainerInspect(ctx, m.anchorID, mobyclient.ContainerInspectOptions{})
		}
		if err == nil {
			runtime, err = connectorRuntimeOf(*inspect, holder.Container.NetworkSettings, next, m.controlDirectory())
		}
		if err == nil {
			err = waitForConnectorSocket(ctx, runtime.socketPath)
		}
		if err == nil {
			replacement := &connectorReplacement{
				previous: connectorRuntime{
					id: m.connectorID, managementIP: m.managementIP, socketPath: m.socketPath, slot: m.slot, attached: m.attached,
				},
				previousBindings: m.bindings, previousUnbound: m.unbound,
				previousIngress: m.egress.ingressConfigs, previousIngressFor: m.egress.ingressFor,
			}
			// Not published: dials go on to the previous connector until apply bound the links here.
			m.useConnector(runtime)
			return replacement, nil
		}
	}
	if removeErr := m.removeConnectorSlot(context.Background(), next); removeErr != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not remove the secure-link connector that failed to start", "error", removeErr)
	}
	return unchanged(fmt.Errorf("start replacement secure-link connector: %w", err))
}

// abortReplacement goes back to the connector that served before: its links
// are bound as they were, and the new connector is removed.
func (m *dockerSecureLinkManager) abortReplacement(replacement *connectorReplacement) {
	failed := m.slot
	m.useConnector(replacement.previous)
	m.bindings = replacement.previousBindings
	m.unbound = replacement.previousUnbound
	m.egress.ingressConfigs, m.egress.ingressFor = replacement.previousIngress, replacement.previousIngressFor
	m.publishViewLocked()
	if err := m.removeConnectorSlot(context.Background(), failed); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not remove the secure-link connector whose links failed to bind", "error", err)
	}
}

// retireConnector removes a replaced connector once the tunnels through it
// are done: each one closes as soon as it is idle between requests (nginx
// then reconnects through the new connector), and the ones still busy after
// the limit are cut with the container.
func (m *dockerSecureLinkManager) retireConnector(previous connectorRuntime) {
	m.retireConnectorUntil(previous, time.Now().Add(secureLinkConnectorRetireLimit))
}

// retireConnectorUntil retires a connector by deadline. It is recorded as retiring before it is told to drain, so a
// daemon that starts meanwhile never serves through it and goes on with its retirement (resumeRetirementLocked).
func (m *dockerSecureLinkManager) retireConnectorUntil(previous connectorRuntime, deadline time.Time) {
	handle, deadline, err := m.retiring.start(previous.id, previous.socketPath, deadline)
	if err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not record the secure-link connector being retired", "error", err)
	}
	if handle == nil {
		return
	}
	drain := func() (int, bool, error) {
		return handle.drain(func() (int, error) {
			drainCtx, cancelDrain := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancelDrain()
			return securelink.Drain(drainCtx, previous.socketPath)
		})
	}
	go func() {
		// Its sessions go to its replacement where both connectors can (secure_link_handover.go); it stops accepting
		// with that, and finishes what it could not pass on. A connector of an earlier release is told to drain: its
		// replacement listens on the same addresses, and the sessions it carries go on.
		var handing connectorHandover
		_, sent, stoppedAtOnce := m.handOverRetiring(handle, previous, &handing)
		var drainErr error
		if !sent && !stoppedAtOnce {
			_, sent, drainErr = drain()
		}
		if sent && drainErr != nil {
			// Its control socket is out of reach (a switch of the daemon's user): the drain signal stops it accepting
			// all the same. A connector image without the drain signal stops at it, which retires it at once.
			killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
			_, err := m.plugin.client.cli.ContainerKill(killCtx, previous.id, mobyclient.ContainerKillOptions{Signal: secureLinkDrainSignal})
			cancelKill()
			if m.plugin.logger != nil {
				m.plugin.logger.Info("the replaced secure-link connector was signalled to drain", "drain_error", drainErr, "signal_error", err)
			}
		}
		// The tunnels this daemon dialed through it: the idle ones close, the busy ones are waited for. A handover still
		// due (no replacement served yet, or sessions the last one left) is asked for meanwhile: it moves them.
		busy, closed := 0, 0
		for {
			wait := max(time.Until(deadline), 0)
			if handing.due() {
				wait = min(wait, connectorHandoverRetry)
			}
			stillBusy, closedNow := m.plugin.proxyTunnels.drainCounted(func(connection *drainConn) bool {
				return connectionConnector(connection) == previous.id
			}, wait, secureLinkConnectorRetireTick, true)
			busy, closed = stillBusy, closed+closedNow
			if busy == 0 || !time.Now().Before(deadline) || !handing.due() {
				break
			}
			if _, answered, stopped := m.handOverRetiring(handle, previous, &handing); answered || stopped {
				sent = sent || answered
			}
		}
		if m.plugin.logger != nil && (closed > 0 || busy > 0) {
			m.plugin.logger.Info("closed the idle tunnels of the replaced secure-link connector",
				"connector", previous.id, "closed", closed, "still_busy", busy)
		}
		// Workload sessions through its egress listeners end on their own: wait for them within the same limit. The
		// connector's last answer counts every session it still carries, its tunnels and its egress sessions alike.
		stopped, carried := !sent, 0
		for !stopped && drainErr == nil {
			active, stillRetiring, err := 0, true, error(nil)
			handed := false
			if handing.due() {
				var stoppedNow bool
				active, handed, stoppedNow = m.handOverRetiring(handle, previous, &handing)
				stillRetiring = !stoppedNow
			}
			if !handed && stillRetiring {
				active, stillRetiring, err = drain()
			}
			if stopped = !stillRetiring; stopped || err != nil {
				break
			}
			if carried = active; active == 0 || !time.Now().Before(deadline) {
				break
			}
			time.Sleep(secureLinkConnectorDrainPoll)
		}
		// Past the limit it goes with what it still carries: the log says how many sessions that cut, as the cut of the
		// oldest slot does. A retirement another path ended (stopped) is that path's to report.
		if cut := max(carried, busy); cut > 0 && !stopped && m.plugin.logger != nil {
			m.plugin.logger.Warn("a replaced secure-link connector reached its retirement limit and is removed with the sessions it still carries",
				"connector", previous.id, "sessions_cut", cut, "limit", secureLinkConnectorRetireLimit.String())
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err := m.removeConnectorContainer(ctx, previous.id)
		kept := err != nil
		if !kept && !stopped {
			m.plugin.recordConnectorCut(max(carried, busy))
		}
		if kept && m.plugin.logger != nil {
			// The next daemon start removes it.
			m.plugin.logger.Warn("could not remove the replaced secure-link connector", "error", err)
		}
		if err := m.retiring.done(previous.id, kept); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("could not record the end of a secure-link connector's retirement", "error", err)
		}
		// A connector of the daemon's previous mode used the egress socket of that mode: it is gone now.
		m.plugin.secureLinkEgressPrevious.retire()
	}()
}

func (m *dockerSecureLinkManager) createConnector(ctx context.Context, image string, slot int) (*container.InspectResponse, error) {
	if image != developmentSecureLinkImage {
		if err := m.plugin.client.EnsureImage(ctx, image, ""); err != nil {
			return nil, fmt.Errorf("ensure secure-link connector image: %w", err)
		}
	}
	controlDirectory := m.controlDirectory()
	// A retirement still running on the slot's socket must not tell the new connector to drain.
	m.retiring.stopSocket(m.slotSocketPath(slot))
	_ = os.Remove(filepath.Join(controlDirectory, secureLinkConnectorSlots[slot].socket))
	hostConfig := &container.HostConfig{
		Binds:          []string{controlDirectory + ":" + secureLinkConnectorMount},
		GroupAdd:       connectorGroupAdd(),
		ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
		RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		Resources:     secureLinkConnectorResources(),
	}
	var networking *network.NetworkingConfig
	if m.anchorID != "" {
		// The anchor holds the addresses and aliases (secure_link_anchor.go).
		hostConfig.NetworkMode = container.NetworkMode("container:" + m.anchorID)
	} else {
		// An image without the anchor: the connector's own namespace on the management network.
		networking = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{secureLinkManagementNetwork: {}}}
	}
	created, createErr := m.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image: image, User: "65532:65532",
			Env:    secureLinkConnectorEnv(slot),
			Labels: map[string]string{"net.opfield.managed": "secure-link-connector"},
		},
		HostConfig:       hostConfig,
		NetworkingConfig: networking,
		Name:             secureLinkConnectorSlots[slot].name,
	})
	if createErr != nil {
		return nil, fmt.Errorf("create secure-link connector: %w", createErr)
	}
	if _, startErr := m.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); startErr != nil {
		return nil, fmt.Errorf("start secure-link connector: %w", startErr)
	}
	inspect, err := m.plugin.client.cli.ContainerInspect(ctx, created.ID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect created secure-link connector: %w", err)
	}
	return &inspect.Container, nil
}

// removeConnectorSlot removes the managed connector in a slot, if any.
func (m *dockerSecureLinkManager) removeConnectorSlot(ctx context.Context, slot int) error {
	name := secureLinkConnectorSlots[slot].name
	inspect, err := m.plugin.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect secure-link connector %s: %w", name, err)
	}
	if !managedSecureLinkConnector(inspect.Container, m.controlDirectory()) {
		return fmt.Errorf("refusing to remove non-managed container %s", name)
	}
	// A connector still retiring there: its retirement must not tell the slot's next connector to drain.
	m.retiring.stop(inspect.Container.ID)
	if err := m.removeConnectorContainer(ctx, inspect.Container.ID); err != nil {
		return fmt.Errorf("remove secure-link connector %s: %w", name, err)
	}
	return nil
}

func waitForConnectorSocket(ctx context.Context, socketPath string) error {
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(socketPath); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("secure-link connector control socket did not become ready")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func validSecureLinkManagementNetwork(inspect network.Inspect) bool {
	return inspect.Driver == "bridge" && inspect.Internal && !inspect.Ingress && !inspect.ConfigOnly &&
		inspect.Labels["net.opfield.managed"] == "secure-link"
}

func validSecureLinkConnector(inspect container.InspectResponse, image, controlDirectory, anchorID string) bool {
	return inspect.Config != nil && inspect.Config.Image == image && managedSecureLinkConnector(inspect, controlDirectory) &&
		currentSecureLinkConnectorShape(inspect) && inConnectorNamespace(inspect, anchorID) &&
		inspect.HostConfig != nil && sameConnectorGroups(inspect.HostConfig.GroupAdd)
}

func ownedSecureLinkConnector(inspect container.InspectResponse) bool {
	return inspect.Config != nil && inspect.Config.Labels["net.opfield.managed"] == "secure-link-connector"
}

// connectorSlot reports the slot of a container named like a connector.
func connectorSlot(inspect container.InspectResponse) (int, bool) {
	name := strings.TrimPrefix(inspect.Name, "/")
	for slot, candidate := range secureLinkConnectorSlots {
		if candidate.name == name {
			return slot, true
		}
	}
	return 0, false
}

func managedSecureLinkConnector(inspect container.InspectResponse, controlDirectory string) bool {
	config := inspect.Config
	host := inspect.HostConfig
	_, named := connectorSlot(inspect)
	// The limits and environment of this release or of the earlier one: a connector of the earlier shape is still
	// this node's own, replaced next to the serving one (ensureConnector) and removed on teardown.
	if !named || config == nil || host == nil ||
		(config.Image != developmentSecureLinkImage &&
			!immutableConnectorImagePattern.MatchString(config.Image) &&
			!officialConnectorReleaseTagPattern.MatchString(config.Image)) ||
		config.User != "65532:65532" ||
		config.Labels["net.opfield.managed"] != "secure-link-connector" ||
		(!currentSecureLinkConnectorShape(inspect) && !legacySecureLinkConnectorShape(inspect)) ||
		len(config.ExposedPorts) != 0 || host.Privileged || host.PublishAllPorts || !host.ReadonlyRootfs ||
		len(host.CapAdd) != 0 || !containsFold(host.CapDrop, "ALL") || !allowedConnectorGroups(host.GroupAdd) ||
		(!containsFold(host.SecurityOpt, "no-new-privileges") && !containsFold(host.SecurityOpt, "no-new-privileges:true")) ||
		string(host.NetworkMode) == "host" || len(host.PortBindings) != 0 ||
		len(host.Binds) != 1 || connectorControlMount(host.Binds[0], controlDirectory) == "" ||
		host.RestartPolicy.Name != "unless-stopped" {
		return false
	}
	return inspect.NetworkSettings != nil && len(inspect.NetworkSettings.Ports) == 0
}

// The connector's control directory is mounted at /run/opfield and named by
// OPFIELD_SECURE_LINK_SOCKET. A connector image of an earlier release reads only
// GATEWAY_SECURE_LINK_SOCKET, so new connectors get both; a connector created
// before Opfield (mount /run/gateway, the old variable only) stays valid until it
// is replaced for its own reasons (an image update).
const (
	secureLinkConnectorMount     = "/run/opfield"
	secureLinkConnectorSocketVar = "OPFIELD_SECURE_LINK_SOCKET"
	// legacy-name: /run/gateway mount and GATEWAY_SECURE_LINK_SOCKET of connectors before Opfield — remove once every node reports none
	legacySecureLinkConnectorMount     = "/run/gateway"
	legacySecureLinkConnectorSocketVar = "GATEWAY_SECURE_LINK_SOCKET"
)

// connectorControlMount is the mount target of a connector's control
// directory bind, "" when the bind is not one.
func connectorControlMount(bind, controlDirectory string) string {
	for _, target := range []string{secureLinkConnectorMount, legacySecureLinkConnectorMount} {
		if bind == controlDirectory+":"+target {
			return target
		}
	}
	return ""
}

func containsFold(values []string, expected string) bool {
	for _, value := range values {
		if strings.EqualFold(value, expected) {
			return true
		}
	}
	return false
}

func (m *dockerSecureLinkManager) resolveTarget(
	ctx context.Context,
	containerName, networkName, expectedHost string,
	allowNetworkReselection bool,
) (string, string, error) {
	inspect, err := m.plugin.client.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil && !isNotFoundErr(err) {
		return "", "", secureLinkTargetUnknownError{cause: err}
	}
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running || inspect.Container.NetworkSettings == nil {
		return "", "", errSecureLinkTargetUnavailable
	}
	primary := ""
	if inspect.Container.HostConfig != nil {
		primary = string(inspect.Container.HostConfig.NetworkMode)
	}
	networkName, err = selectSecureLinkTargetNetwork(
		inspect.Container.NetworkSettings.Networks,
		primary,
		networkName,
		allowNetworkReselection,
	)
	if err != nil {
		return "", "", err
	}
	endpoint := inspect.Container.NetworkSettings.Networks[networkName]
	actual := endpoint.IPAddress.String()
	if expectedHost != "" && expectedHost != actual {
		return "", "", errors.New("target address changed during reconciliation")
	}
	return actual, networkName, nil
}

func selectSecureLinkTargetNetwork(
	networks map[string]*network.EndpointSettings,
	primary, requested string,
	allowReselection bool,
) (string, error) {
	valid := func(name string) bool {
		endpoint := networks[name]
		return name != "" && name != secureLinkManagementNetwork && endpoint != nil && endpoint.IPAddress.IsValid()
	}
	if valid(requested) {
		return requested, nil
	}
	if requested != "" && !allowReselection {
		return "", errors.New("target container is not attached to the selected network")
	}
	if valid(primary) {
		return primary, nil
	}
	names := make([]string, 0, len(networks))
	for name := range networks {
		if valid(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return "", errors.New("target container has no usable network")
	}
	return names[0], nil
}

func (m *dockerSecureLinkManager) dial(ctx context.Context, linkID string) (net.Conn, error) {
	return dialWithOneRestore(ctx, linkID, m.dialCurrent, func(firstErr error) error {
		return m.restoreBindingsCoalesced(!errors.Is(firstErr, errSecureLinkTargetUnavailable))
	})
}

func (m *dockerSecureLinkManager) restoreBindingsCoalesced(bypassCompleted bool) error {
	return m.restoreCoalesced(m.restoreBindings, bypassCompleted)
}

func (m *dockerSecureLinkManager) restoreCoalesced(restore func() error, bypassCompleted bool) error {
	m.recoveryMu.Lock()
	if current := m.recovery; current != nil {
		if !current.completedAt.IsZero() {
			if !bypassCompleted && time.Since(current.completedAt) < secureLinkRecoveryWindow {
				err := current.err
				m.recoveryMu.Unlock()
				return err
			}
			m.recovery = nil
		} else {
			m.recoveryMu.Unlock()
			<-current.done
			return current.err
		}
	}
	current := &dockerSecureLinkRecovery{done: make(chan struct{})}
	m.recovery = current
	m.recoveryMu.Unlock()

	err := restore()
	m.recoveryMu.Lock()
	current.err = err
	current.completedAt = time.Now()
	close(current.done)
	m.recoveryMu.Unlock()
	return err
}

func (m *dockerSecureLinkManager) restoreBindings() error {
	if m.plugin.secureLinkState == nil {
		return errors.New("proxy secure-link state is unavailable")
	}
	restored := m.plugin.secureLinkState.Get()
	if len(restored.Bindings) == 0 {
		return errors.New("proxy secure-link desired state is empty")
	}
	if _, err := m.restore(restored); err != nil {
		return fmt.Errorf("restore proxy secure-link bindings after connector restart: %w", err)
	}
	return nil
}

func dialWithOneRestore(
	ctx context.Context,
	linkID string,
	dial func(context.Context, string) (net.Conn, error),
	restore func(error) error,
) (net.Conn, error) {
	connection, firstErr := dial(ctx, linkID)
	if firstErr == nil {
		return connection, nil
	}
	if err := restore(firstErr); err != nil {
		return nil, fmt.Errorf("%v; recovery failed: %w", firstErr, err)
	}
	return dial(ctx, linkID)
}

func (m *dockerSecureLinkManager) dialCurrent(ctx context.Context, linkID string) (net.Conn, error) {
	view := m.currentView()
	binding, ok := view.bindings[linkID]
	_, unbound := view.unbound[linkID]
	host := view.managementIP
	if !ok && unbound && host != "" {
		// Its target was unavailable at the last restore: a new restore
		// right away would find the same, so the dial shares a recent one.
		return nil, fmt.Errorf("proxy secure-link %s: %w", linkID, errSecureLinkTargetUnavailable)
	}
	if !ok || host == "" || binding.port == 0 {
		return nil, errors.New("proxy secure-link binding is unavailable")
	}
	if err := m.validateDialTarget(ctx, linkID, binding, time.Now()); err != nil {
		return nil, fmt.Errorf("validate proxy secure-link target: %w", err)
	}
	connection, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(host, fmt.Sprintf("%d", binding.port)))
	if err != nil {
		return nil, err
	}
	return &connectorConn{Conn: connection, connectorID: view.connectorID}, nil
}

// connectorConn is a connection through one connector container: the tunnels
// of a replaced connector are drained before it is removed.
type connectorConn struct {
	net.Conn
	connectorID string
	// moved: a handover passed the connection's session to another connector (secure_link_handover.go).
	moved movedConnector
}

// CloseWrite passes a half-close on to the workload.
func (c *connectorConn) CloseWrite() error {
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

func connectionConnector(connection net.Conn) string {
	for {
		switch current := connection.(type) {
		case *connectorConn:
			return current.connector()
		case *drainConn:
			connection = current.Conn
		default:
			return ""
		}
	}
}

// validateDialTarget checks through dockerd that the link's target still is
// the container and address the connector forwards to. A hung dockerd must
// not hang traffic to running workloads (B-8, D5): the check waits at most
// secureLinkValidateWait, and when dockerd does not answer, the connector
// keeps forwarding to the target it was bound to. That binding was validated
// while dockerd answered, and only dockerd can hand its address to another
// container. Dials skip the check for secureLinkDockerQuiet after such a
// timeout, so a frozen dockerd costs one wait per period, not one per tunnel.
//
// A target validated less than secureLinkValidateTTL ago for the same binding
// is not checked again, and concurrent dials of one link share one check: a
// relayed connection costs no dockerd call of its own (B-22).
func (m *dockerSecureLinkManager) validateDialTarget(ctx context.Context, linkID string, binding dockerSecureLinkBinding, now time.Time) error {
	m.validationMu.Lock()
	if last, ok := m.validated[linkID]; ok && last.binding == binding && now.Sub(last.at) < secureLinkValidateTTL {
		m.validationMu.Unlock()
		return nil
	}
	if running := m.validating[linkID]; running != nil && running.binding == binding {
		m.validationMu.Unlock()
		select {
		case <-running.done:
			return running.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	call := &dialValidation{binding: binding, at: now, done: make(chan struct{})}
	if m.validating == nil {
		m.validating = map[string]*dialValidation{}
	}
	m.validating[linkID] = call
	m.validationMu.Unlock()
	call.err = m.validateDialTargetNow(ctx, linkID, binding, now)
	m.validationMu.Lock()
	if m.validating[linkID] == call {
		delete(m.validating, linkID)
	}
	if m.validated == nil {
		m.validated = map[string]dialValidation{}
	}
	if call.err == nil {
		m.validated[linkID] = dialValidation{binding: binding, at: now}
	} else {
		delete(m.validated, linkID)
	}
	m.validationMu.Unlock()
	close(call.done)
	return call.err
}

func (m *dockerSecureLinkManager) validateDialTargetNow(ctx context.Context, linkID string, binding dockerSecureLinkBinding, now time.Time) error {
	m.dockerQuietMu.Lock()
	quiet := now.Before(m.dockerQuietUntil)
	m.dockerQuietMu.Unlock()
	if quiet {
		return nil
	}
	validateCtx, cancel := context.WithTimeout(ctx, secureLinkValidateWait)
	defer cancel()
	resolve := m.resolveTargetForDial
	if resolve == nil {
		resolve = m.resolveTarget
	}
	actualHost, actualNetwork, err := resolve(validateCtx, binding.targetContainer, binding.targetNetwork, binding.targetHost, false)
	// No answer in time, or no answer at all (dockerd restarting, a transport
	// error): no evidence the target changed.
	var unanswered secureLinkTargetUnknownError
	if err != nil && ctx.Err() == nil && (errors.Is(validateCtx.Err(), context.DeadlineExceeded) || errors.As(err, &unanswered)) {
		m.dockerQuietMu.Lock()
		first := m.dockerQuietUntil.IsZero()
		m.dockerQuietUntil = now.Add(secureLinkDockerQuiet)
		m.dockerQuietMu.Unlock()
		if first {
			m.plugin.logger.Warn("dockerd did not answer a secure-link target check; links keep their validated targets until it answers",
				"link_id", linkID, "wait", secureLinkValidateWait.String())
		}
		return nil
	}
	m.dockerQuietMu.Lock()
	recovered := !m.dockerQuietUntil.IsZero()
	m.dockerQuietUntil = time.Time{}
	m.dockerQuietMu.Unlock()
	if recovered {
		m.plugin.logger.Info("dockerd answers secure-link target checks again")
	}
	if err != nil || actualHost != binding.targetHost || actualNetwork != binding.targetNetwork {
		if err == nil {
			err = errors.New("target identity changed")
		}
		return err
	}
	return nil
}

func (m *dockerSecureLinkManager) removeConnector(ctx context.Context) error {
	if m.connectorID != "" {
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, m.connectorID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove secure-link connector: %w", err)
		}
	}
	// Every slot: a replaced connector may still be retiring.
	for slot := range secureLinkConnectorSlots {
		if err := m.removeConnectorSlot(ctx, slot); err != nil {
			return err
		}
	}
	// The anchor goes with the last link: it holds the network endpoints.
	if err := m.removeAnchor(ctx); err != nil {
		return err
	}
	managementNetwork, err := m.plugin.client.cli.NetworkInspect(ctx, secureLinkManagementNetwork, mobyclient.NetworkInspectOptions{})
	if err == nil {
		if !validSecureLinkManagementNetwork(managementNetwork.Network) {
			return errors.New("refusing to remove a non-managed secure-link management network")
		}
		if _, err := m.plugin.client.cli.NetworkRemove(ctx, managementNetwork.Network.ID, mobyclient.NetworkRemoveOptions{}); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove secure-link management network: %w", err)
		}
	} else if !isNotFoundErr(err) {
		return fmt.Errorf("inspect secure-link management network for cleanup: %w", err)
	}
	for _, slot := range secureLinkConnectorSlots {
		_ = os.Remove(filepath.Join(m.controlDirectory(), slot.socket))
	}
	m.connectorID = ""
	m.managementIP = ""
	m.slot = 0
	m.socketPath = filepath.Join(m.controlDirectory(), secureLinkConnectorSlots[0].socket)
	m.bindings = map[string]dockerSecureLinkBinding{}
	m.unbound = nil
	m.publishViewLocked()
	m.attached = map[string]struct{}{}
	m.egress.configs, m.egress.configsFor = nil, ""
	m.egress.ingressConfigs, m.egress.ingressFor = nil, ""
	m.egress.networks = nil
	m.clearPendingRetireLocked()
	return nil
}

func (p *DockerPlugin) SyncProxySecureLinks(command *pb.SyncProxySecureLinksCommand) (string, error) {
	if p.cfg.Docker.Mode == "databases" || p.secureLinks == nil {
		return "", errors.New("proxy secure links require a general Docker daemon")
	}
	statuses, err := p.secureLinks.syncWithPersistence(command, p.secureLinkState.Stage, p.secureLinkState.Commit)
	if err != nil {
		return "", err
	}
	// New or changed availability members: probe their readiness now (D6).
	p.memberReadiness.signal()
	if p.lease != nil {
		// Lease-gated links may have appeared or changed policy.
		p.reconcileRelayRegistrations()
	}
	detail, err := json.Marshal(map[string]any{"bindings": statuses})
	return string(detail), err
}

func normalizeResolvedTargetBindings(
	command *pb.SyncProxySecureLinksCommand,
	resolved []resolvedSecureLinkTarget,
) *pb.SyncProxySecureLinksCommand {
	normalized := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	networks := make(map[string]string, len(resolved))
	for _, target := range resolved {
		networks[target.binding.LinkId] = target.network
	}
	for _, binding := range normalized.Bindings {
		if network, ok := networks[binding.LinkId]; ok {
			binding.TargetNetwork = network
		}
		binding.TargetHost = ""
	}
	return normalized
}

// normalizeTargetBindings persists a restore. A link the restore left
// unbound keeps its committed network: a deployment router link must not
// lose its managed network because the router was down at that moment.
func normalizeTargetBindings(command *pb.SyncProxySecureLinksCommand, statuses []dockerSecureLinkStatus) *pb.SyncProxySecureLinksCommand {
	normalized := proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	networks := make(map[string]string, len(statuses))
	for _, status := range statuses {
		networks[status.LinkID] = status.TargetNetwork
	}
	for _, binding := range normalized.Bindings {
		if network, bound := networks[binding.LinkId]; bound {
			binding.TargetNetwork = network
		}
		binding.TargetHost = ""
	}
	return normalized
}
