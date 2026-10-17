package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
)

// A node switches between a root and a non-root docker-daemon by re-running
// its installer. The connector socket directories and the connector containers
// of the previous mode do not fit the new one (owned by uid 65532, or shared
// through the previous user's group); the daemon brings both over by itself.

// claimConnectorDirectory gives a daemon without root its socket directory with
// mode. A directory a root daemon left behind belongs to uid 65532 and cannot be
// changed; its sockets are stale, so it is set aside and created anew.
func claimConnectorDirectory(path string, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil {
		if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != daemonEUID() {
			aside := fmt.Sprintf("%s%s%d", path, setAsideSuffix, time.Now().UnixNano())
			if err := os.Rename(path, aside); err != nil {
				return fmt.Errorf("set aside %s owned by uid %d: %w", path, stat.Uid, err)
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

const (
	setAsideSuffix = ".previous-owner-"
	// connectorCleanMount and connectorCleanEnv start a connector image in its
	// clean mode (secure-link-connector clean.go).
	connectorCleanMount = "/run/opfield-clean"
	connectorCleanEnv   = "OPFIELD_CONNECTOR_CLEAN_DIR"
	// legacy-name: legacycompat.EnvPrefixCONNECTOR_CLEAN_DIR read by connector images before Opfield — remove once every node reports none
	legacyConnectorCleanEnv = legacycompat.EnvPrefix + "CONNECTOR_CLEAN_DIR"
	connectorCleanLabel     = "connector-cleanup"
	connectorUID            = 65532
)

var setAsideCleanup sync.Mutex

// setAsideDirectories lists the directories claimConnectorDirectory set aside
// for one socket directory: exactly <kind>.previous-owner-<digits> in the state
// directory, real directories only.
func setAsideDirectories(stateDir, kind string) []string {
	pattern := regexp.MustCompile(`^` + regexp.QuoteMeta(kind+setAsideSuffix) + `[0-9]+$`)
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		return nil
	}
	var paths []string
	for _, entry := range entries {
		if !pattern.MatchString(entry.Name()) || entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		paths = append(paths, filepath.Join(stateDir, entry.Name()))
	}
	return paths
}

// removeSetAsideConnectorDirectories deletes the socket directories of kind
// that a mode switch set aside. It is called once the new connector of that
// kind is ready, with its image. A root daemon removes them itself; a daemon
// without root cannot touch what uid 65532 owns, so it runs the connector image
// once as that uid to empty each directory and then removes the empty one.
func (p *DockerPlugin) removeSetAsideConnectorDirectories(ctx context.Context, kind, image string) {
	if p == nil || p.cfg == nil {
		return
	}
	setAsideCleanup.Lock()
	defer setAsideCleanup.Unlock()
	for _, path := range setAsideDirectories(p.cfg.StateDir, kind) {
		var err error
		// A directory an installer already gave this daemon's user is removed directly as well.
		if !runsWithoutRoot() || ownedByDaemon(path) {
			err = os.RemoveAll(path)
		} else {
			err = p.emptyWithConnector(ctx, image, path)
			if err == nil {
				err = os.Remove(path)
			}
		}
		if err != nil {
			p.logger.Warn("could not remove a socket directory set aside by a mode switch; retrying on the next start", "path", path, "error", err)
			continue
		}
		p.logger.Info("removed a socket directory set aside by a mode switch", "path", path)
	}
}

func ownedByDaemon(path string) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == daemonEUID()
}

func (p *DockerPlugin) emptyWithConnector(ctx context.Context, image, path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != connectorUID {
		return fmt.Errorf("%s is not owned by the connector uid %d", path, connectorUID)
	}
	if image == "" || p.client == nil {
		return fmt.Errorf("no connector image is available yet")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	created, err := p.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image: image, User: fmt.Sprintf("%d:%d", connectorUID, connectorUID),
			Env:    []string{connectorCleanEnv + "=" + connectorCleanMount, legacyConnectorCleanEnv + "=" + connectorCleanMount},
			Labels: helperContainerLabels(helperKindConnectorCleanup, map[string]string{"net.opfield.managed": connectorCleanLabel}),
		},
		HostConfig: &container.HostConfig{
			LogConfig:   internalContainerLogConfig(),
			Binds:       []string{path + ":" + connectorCleanMount},
			NetworkMode: "none", ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"},
		},
	})
	if err != nil {
		return fmt.Errorf("create the cleanup container: %w", err)
	}
	defer func() { _ = p.client.RemoveContainer(context.Background(), created.ID, true) }()
	if _, err := p.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start the cleanup container: %w", err)
	}
	wait := p.client.cli.ContainerWait(ctx, created.ID, mobyclient.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case err := <-wait.Error:
		if err != nil {
			return fmt.Errorf("wait for the cleanup container: %w", err)
		}
	case result := <-wait.Result:
		if result.StatusCode != 0 {
			lines, _ := p.client.ContainerLogs(context.Background(), created.ID, 5, false, "", "")
			return fmt.Errorf("cleanup container exited %d: %s", result.StatusCode, strings.Join(lines, " "))
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

// reconcileStorageConnectorGroups recreates the managed storage connectors whose
// supplementary groups do not match this daemon's mode: one created by a root
// daemon cannot reach the socket of a daemon without root, and one created by a
// non-root daemon keeps that user's group. Each is recreated with the same
// name, image, environment, network and alias; Proxy Secure Link connectors are
// replaced the same way when their links are restored (validSecureLinkConnector).
func (p *DockerPlugin) reconcileStorageConnectorGroups(ctx context.Context) {
	if p.client == nil {
		return
	}
	listed, err := p.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedStorageConnectorLabel+"="+managedStorageConnectorWorkload),
	})
	if err != nil {
		p.logger.Warn("could not check storage connectors for the daemon's user", "error", err)
		return
	}
	ready, image := true, ""
	for _, candidate := range listed.Items {
		inspected, err := p.client.cli.ContainerInspect(ctx, candidate.ID, mobyclient.ContainerInspectOptions{})
		if err != nil || inspected.Container.HostConfig == nil {
			ready = false
			continue
		}
		if !sameConnectorGroups(inspected.Container.HostConfig.GroupAdd) {
			if err := p.recreateStorageConnector(ctx, inspected.Container); err != nil {
				p.logger.Error("could not recreate a storage connector for the daemon's user", "container", strings.TrimPrefix(inspected.Container.Name, "/"), "error", err)
				ready = false
				continue
			}
			p.logger.Info("recreated a storage connector for the daemon's user", "container", strings.TrimPrefix(inspected.Container.Name, "/"), "groups", connectorGroupAdd())
			if inspected, err = p.client.cli.ContainerInspect(ctx, strings.TrimPrefix(inspected.Container.Name, "/"), mobyclient.ContainerInspectOptions{}); err != nil {
				ready = false
				continue
			}
		}
		if inspected.Container.State != nil && inspected.Container.State.Running && inspected.Container.Config != nil {
			image = inspected.Container.Config.Image
		}
	}
	// Every connector of the previous mode is recreated: its relay socket is served no longer.
	if ready {
		p.storageConnectorPrevious.retire()
	}
	// The relay socket of this mode listens and every connector fits it: what the previous mode left can go.
	if ready && len(setAsideDirectories(p.cfg.StateDir, storageConnectorSocketDirectory)) > 0 {
		if image == "" {
			image = p.runningSecureLinkConnectorImage(ctx)
		}
		p.removeSetAsideConnectorDirectories(ctx, storageConnectorSocketDirectory, image)
	}
}

// runningSecureLinkConnectorImage is the image of a running Secure Link
// connector, for the cleanup of a node without storage connectors.
func (p *DockerPlugin) runningSecureLinkConnectorImage(ctx context.Context) string {
	for _, name := range secureLinkConnectorSlotNames(p.secureLinkNames(ctx)) {
		inspected, err := p.client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
		if err == nil && inspected.Container.State != nil && inspected.Container.State.Running && inspected.Container.Config != nil {
			return inspected.Container.Config.Image
		}
	}
	return ""
}

// storageConnectorConfigOf rebuilds the create request of an existing managed
// storage connector, so the recreated one passes the same validation.
func storageConnectorConfigOf(inspect container.InspectResponse) (ContainerCreateConfig, error) {
	if inspect.Config == nil || inspect.HostConfig == nil || inspect.NetworkSettings == nil || len(inspect.NetworkSettings.Networks) != 1 {
		return ContainerCreateConfig{}, fmt.Errorf("storage connector %s has an unexpected shape", inspect.Name)
	}
	config := ContainerCreateConfig{
		InternalWorkload: managedStorageConnectorWorkload,
		Name:             strings.TrimPrefix(inspect.Name, "/"),
		Image:            inspect.Config.Image,
		Env:              inspect.Config.Env,
		User:             inspect.Config.User,
		Labels:           inspect.Config.Labels,
		Binds:            inspect.HostConfig.Binds,
	}
	bindingID, _ := storageConnectorBindingID(config.Name)
	for name, endpoint := range inspect.NetworkSettings.Networks {
		config.NetworkMode = name
		if endpoint != nil {
			for _, alias := range endpoint.Aliases {
				if alias == storageBindingAlias(bindingID) {
					config.NetworkAliases = []string{alias}
				}
			}
		}
	}
	// The image may set variables of its own; only the connector's own pass validation.
	env := config.Env[:0:0]
	for _, value := range config.Env {
		if isConnectorEnv(value) {
			env = append(env, value)
		}
	}
	config.Env = env
	return config, nil
}

func (p *DockerPlugin) recreateStorageConnector(ctx context.Context, inspect container.InspectResponse) error {
	config, err := storageConnectorConfigOf(inspect)
	if err != nil {
		return err
	}
	// Refuse before removing anything: only a valid managed connector is recreated.
	if err := validateManagedStorageConnectorConfig(config, storageConnectorRelayDirectory(p.cfg.StateDir)); err != nil {
		return err
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	wasRunning := inspect.State != nil && inspect.State.Running
	if err := p.client.RemoveContainer(ctx, inspect.ID, true); err != nil && !isNotFoundErr(err) {
		return fmt.Errorf("remove storage connector: %w", err)
	}
	id, _, err := p.createManagedStorageConnector(ctx, string(raw))
	if err != nil {
		return err
	}
	if !wasRunning {
		if _, err := p.client.cli.ContainerStop(ctx, id, mobyclient.ContainerStopOptions{}); err != nil {
			return fmt.Errorf("keep the recreated storage connector stopped: %w", err)
		}
	}
	return nil
}
