package docker

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// The anchor holds the connector's network namespace: its endpoints on the management network and on every link
// and target network, with their addresses (base+2 on link networks of the pool) and aliases. The connector
// containers run in it (network_mode container:<anchor>), so a new connector image starts next to the serving one on
// the same addresses: it binds the egress listeners with SO_REUSEPORT, the previous one stops accepting and drains,
// and no address or alias ever moves (F3). The anchor runs the connector image in its pause mode; it is replaced only
// when it is missing or its own small shape changes, never for another connector image.
const (
	secureLinkAnchorName      = "gateway-secure-link-anchor"
	secureLinkRoleLabel       = "net.opfield.secure-link.role"
	secureLinkAnchorRole      = "anchor"
	secureLinkAnchorMemory    = 32 * 1024 * 1024
	secureLinkAnchorPidsLimit = int64(16)
)

var secureLinkAnchorCommand = []string{"pause"}

// secureLinkAnchorImageLabel marks a connector image that has the pause subcommand (its Dockerfile). The daemon is
// updated before Gateway, which then still sends the connector image of its own release: without the label the
// connector runs in its own network namespace as before, serving ingress, and the egress waits for Gateway's update.
const (
	secureLinkAnchorImageLabel   = "net.opfield.secure-link-connector.anchor"
	secureLinkAnchorImageVersion = "v1"
	connectorImageTooOld         = "the secure-link connector image is too old for links from this node; update Opfield"
)

// tcpMigrateReqSysctl moves the connections queued on a closing SO_REUSEPORT listener to another listener of the
// same address instead of resetting them: a draining connector's backlog goes to its replacement.
const tcpMigrateReqSysctl = "net.ipv4.tcp_migrate_req"

// hostSupportsTCPMigrateReq reports a kernel with tcp_migrate_req (5.14+); Docker refuses a sysctl the kernel lacks.
// A variable for tests.
var hostSupportsTCPMigrateReq = func() bool {
	_, err := os.Stat("/proc/sys/net/ipv4/tcp_migrate_req")
	return err == nil
}

// secureLinkAnchorSysctls are the anchor's sysctls on this host's kernel (nil when it lacks tcp_migrate_req).
func secureLinkAnchorSysctls() map[string]string {
	if !hostSupportsTCPMigrateReq() {
		return nil
	}
	return map[string]string{tcpMigrateReqSysctl: "1"}
}

// anchorSupported reports whether image can run the anchor, from the label of the (pulled) image.
func (m *dockerSecureLinkManager) anchorSupported(ctx context.Context, image string) (bool, error) {
	if supported, known := m.anchorImages[image]; known {
		return supported, nil
	}
	if image != developmentSecureLinkImage {
		if err := m.plugin.client.EnsureImage(ctx, image, ""); err != nil {
			return false, fmt.Errorf("ensure secure-link connector image: %w", err)
		}
	}
	inspected, err := m.plugin.client.cli.ImageInspect(ctx, image)
	if err != nil {
		return false, fmt.Errorf("inspect secure-link connector image: %w", err)
	}
	// An image built before Opfield carries the label under its pre-Opfield key.
	supported := inspected.Config != nil && labelValue(inspected.Config.Labels, secureLinkAnchorImageLabel) == secureLinkAnchorImageVersion
	if image != developmentSecureLinkImage {
		// A digest or release tag names one image for good; the development tag is rebuilt.
		if m.anchorImages == nil {
			m.anchorImages = map[string]bool{}
		}
		m.anchorImages[image] = supported
	}
	return supported, nil
}

// networkHolder is the container that holds the connector's network endpoints: the anchor, or the connector itself
// when its image cannot run one.
func (m *dockerSecureLinkManager) networkHolder() string {
	if m.anchorID != "" {
		return m.anchorID
	}
	return m.connectorID
}

// removeUnusedAnchor removes an anchor no connector runs in any more: the connector image went back to one without
// the anchor (a Gateway rollback), and the anchor's link aliases would answer for nothing.
func (m *dockerSecureLinkManager) removeUnusedAnchor(ctx context.Context) {
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, secureLinkAnchorName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return
	}
	for _, slot := range secureLinkConnectorSlots {
		connector, err := m.plugin.client.cli.ContainerInspect(ctx, slot.name, mobyclient.ContainerInspectOptions{})
		if err == nil && inSecureLinkAnchor(connector.Container, inspected.Container.ID) {
			return
		}
		if err != nil && !isNotFoundErr(err) {
			return
		}
	}
	if err := m.removeAnchor(ctx); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not remove the unused secure-link anchor", "error", err)
	}
}

// ensureAnchor returns the running anchor, created (with image) or started when needed.
func (m *dockerSecureLinkManager) ensureAnchor(ctx context.Context, image string) (*container.InspectResponse, error) {
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, secureLinkAnchorName, mobyclient.ContainerInspectOptions{})
	switch {
	case err == nil && validSecureLinkAnchor(inspected.Container):
		if inspected.Container.State != nil && inspected.Container.State.Running {
			m.anchorID = inspected.Container.ID
			return &inspected.Container, nil
		}
		if _, err := m.plugin.client.cli.ContainerStart(ctx, inspected.Container.ID, mobyclient.ContainerStartOptions{}); err != nil {
			return nil, fmt.Errorf("start secure-link anchor: %w", err)
		}
	case err == nil:
		if !ownedSecureLinkConnector(inspected.Container) {
			return nil, errors.New("refusing to replace a non-managed container using the secure-link anchor name")
		}
		if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspected.Container.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
			return nil, fmt.Errorf("replace outdated secure-link anchor: %w", err)
		}
		if err := m.createAnchor(ctx, image); err != nil {
			return nil, err
		}
	case isNotFoundErr(err):
		if err := m.createAnchor(ctx, image); err != nil {
			return nil, err
		}
	default:
		return nil, secureLinkConnectorUnchangedError{fmt.Errorf("inspect secure-link anchor: %w", err)}
	}
	inspected, err = m.plugin.client.cli.ContainerInspect(ctx, secureLinkAnchorName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect secure-link anchor: %w", err)
	}
	m.anchorID = inspected.Container.ID
	return &inspected.Container, nil
}

func (m *dockerSecureLinkManager) createAnchor(ctx context.Context, image string) error {
	if image != developmentSecureLinkImage {
		if err := m.plugin.client.EnsureImage(ctx, image, ""); err != nil {
			return fmt.Errorf("ensure secure-link connector image: %w", err)
		}
	}
	pids := secureLinkAnchorPidsLimit
	created, err := m.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image: image, User: "65532:65532", Cmd: secureLinkAnchorCommand,
			// The connector's label keeps it among Gateway's internal containers.
			Labels: map[string]string{"net.opfield.managed": "secure-link-connector", secureLinkRoleLabel: secureLinkAnchorRole},
		},
		HostConfig: &container.HostConfig{
			ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
			Resources:     container.Resources{Memory: secureLinkAnchorMemory, PidsLimit: &pids},
			// The anchor owns the network namespace the connectors' listeners live in.
			Sysctls: secureLinkAnchorSysctls(),
		},
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{secureLinkManagementNetwork: {}}},
		Name:             secureLinkAnchorName,
	})
	if err != nil {
		return fmt.Errorf("create secure-link anchor: %w", err)
	}
	if _, err := m.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start secure-link anchor: %w", err)
	}
	return nil
}

// validSecureLinkAnchor checks the anchor's own shape. The image is any allowed connector image: a connector image
// change leaves the anchor as it is.
func validSecureLinkAnchor(inspect container.InspectResponse) bool {
	config, host := inspect.Config, inspect.HostConfig
	if strings.TrimPrefix(inspect.Name, "/") != secureLinkAnchorName || config == nil || host == nil {
		return false
	}
	return allowedSecureLinkConnectorImage(config.Image) && config.User == "65532:65532" &&
		slices.Equal([]string(config.Cmd), secureLinkAnchorCommand) &&
		config.Labels["net.opfield.managed"] == "secure-link-connector" && config.Labels[secureLinkRoleLabel] == secureLinkAnchorRole &&
		len(config.ExposedPorts) == 0 && !host.Privileged && !host.PublishAllPorts && host.ReadonlyRootfs &&
		len(host.CapAdd) == 0 && containsFold(host.CapDrop, "ALL") && len(host.Binds) == 0 && len(host.Mounts) == 0 &&
		len(host.PortBindings) == 0 && string(host.NetworkMode) != "host" && host.RestartPolicy.Name == "unless-stopped" &&
		host.Resources.Memory == secureLinkAnchorMemory && host.Resources.PidsLimit != nil && *host.Resources.PidsLimit == secureLinkAnchorPidsLimit &&
		(containsFold(host.SecurityOpt, "no-new-privileges") || containsFold(host.SecurityOpt, "no-new-privileges:true")) &&
		maps.Equal(host.Sysctls, secureLinkAnchorSysctls())
}

// isSecureLinkAnchor reports the anchor among the containers named like the connector's.
func isSecureLinkAnchor(inspect container.InspectResponse) bool {
	return inspect.Config != nil && inspect.Config.Labels[secureLinkRoleLabel] == secureLinkAnchorRole
}

// inSecureLinkAnchor reports a connector running in the anchor's network namespace.
func inSecureLinkAnchor(inspect container.InspectResponse, anchorID string) bool {
	return anchorID != "" && inspect.HostConfig != nil && string(inspect.HostConfig.NetworkMode) == "container:"+anchorID
}

// inConnectorNamespace reports a connector in the namespace it must run in: the anchor's, or without an anchor
// (anchorID "") its own.
func inConnectorNamespace(inspect container.InspectResponse, anchorID string) bool {
	if anchorID != "" {
		return inSecureLinkAnchor(inspect, anchorID)
	}
	return inspect.HostConfig != nil && !strings.HasPrefix(string(inspect.HostConfig.NetworkMode), "container:")
}

// joinedBeforeAnchorStart reports a connector that started before the anchor's last start: it holds the network
// namespace of the anchor's previous run and must be restarted to join the current one.
func joinedBeforeAnchorStart(connector, anchor container.InspectResponse) bool {
	if connector.State == nil || anchor.State == nil {
		return false
	}
	connectorStarted, err1 := time.Parse(time.RFC3339Nano, connector.State.StartedAt)
	anchorStarted, err2 := time.Parse(time.RFC3339Nano, anchor.State.StartedAt)
	return err1 == nil && err2 == nil && connectorStarted.Before(anchorStarted)
}

// removeAnchor removes the anchor (teardown: no link remains).
func (m *dockerSecureLinkManager) removeAnchor(ctx context.Context) error {
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, secureLinkAnchorName, mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		m.anchorID = ""
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect secure-link anchor: %w", err)
	}
	if !ownedSecureLinkConnector(inspected.Container) {
		return errors.New("refusing to remove a non-managed container using the secure-link anchor name")
	}
	if _, err := m.plugin.client.cli.ContainerRemove(ctx, inspected.Container.ID, mobyclient.ContainerRemoveOptions{Force: true}); err != nil && !isNotFoundErr(err) {
		return fmt.Errorf("remove secure-link anchor: %w", err)
	}
	m.anchorID = ""
	return nil
}

// adoptConnectorLocked takes a running connector found by name as the serving one, with the addresses of the
// namespace it runs in (the anchor's, or its own), so a replacement can start next to it and drain it.
func (m *dockerSecureLinkManager) adoptConnectorLocked(ctx context.Context, inspect container.InspectResponse, slot int, controlDirectory string) error {
	holder := inspect.NetworkSettings
	if inspect.HostConfig != nil {
		if owner, inAnchor := strings.CutPrefix(string(inspect.HostConfig.NetworkMode), "container:"); inAnchor {
			anchor, err := m.plugin.client.cli.ContainerInspect(ctx, owner, mobyclient.ContainerInspectOptions{})
			if err != nil {
				return fmt.Errorf("inspect the namespace of the secure-link connector: %w", err)
			}
			holder = anchor.Container.NetworkSettings
		}
	}
	runtime, err := connectorRuntimeOf(inspect, holder, slot, controlDirectory)
	if err != nil {
		return err
	}
	runtime.socketPath = m.adoptedControlSocket(runtime.socketPath)
	m.useConnector(runtime)
	return nil
}

// adoptedControlSocket is the control socket of a connector found running: where it is, or in the control directory
// a switch of the daemon's user set aside with it (the connector's mount follows the directory), so it can be told to
// drain.
func (m *dockerSecureLinkManager) adoptedControlSocket(path string) string {
	if _, err := os.Stat(path); err == nil || m.plugin == nil || m.plugin.cfg == nil {
		return path
	}
	asides := setAsideDirectories(m.plugin.cfg.StateDir, "secure-link-connector")
	sort.Sort(sort.Reverse(sort.StringSlice(asides)))
	for _, directory := range asides {
		candidate := filepath.Join(directory, filepath.Base(path))
		if info, err := os.Stat(candidate); err == nil && info.Mode()&os.ModeSocket != 0 {
			return candidate
		}
	}
	return path
}

// controlDirectory is where this daemon's connectors have their control sockets. socketPath may be the socket of a
// connector adopted in a directory a switch of the daemon's user set aside (adoptedControlSocket).
func (m *dockerSecureLinkManager) controlDirectory() string {
	if m.controlDir != "" {
		return m.controlDir
	}
	return filepath.Dir(m.socketPath)
}

// slotSocketPath is the control socket of the connector in a slot.
func (m *dockerSecureLinkManager) slotSocketPath(slot int) string {
	return filepath.Join(m.controlDirectory(), secureLinkConnectorSlots[slot].socket)
}

// anchorNetworks returns the network endpoints of the container holding them.
func (m *dockerSecureLinkManager) anchorNetworks(ctx context.Context) (map[string]*network.EndpointSettings, error) {
	inspected, err := m.plugin.client.cli.ContainerInspect(ctx, m.networkHolder(), mobyclient.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect secure-link anchor: %w", err)
	}
	return connectorNetworksOf(inspected.Container.NetworkSettings), nil
}
