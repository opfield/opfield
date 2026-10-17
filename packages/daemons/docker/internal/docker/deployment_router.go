package docker

import (
	"context"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

const (
	defaultDeploymentRouterImage = "nginx:alpine"
	deploymentRouterConfigPath   = "/etc/nginx/conf.d/default.conf"
	// deploymentRouterConfigMarker records that the router config was written
	// at least once. The start command writes the creation-time config only
	// while the marker is missing, so a restarted router (Stop→Start, Docker or
	// node restart) keeps the last config written by writeRouterConfig instead
	// of reverting to the slot that was active when the router was created.
	deploymentRouterConfigMarker  = legacycompat.DeploymentRouterMarker
	deploymentRouterRestartPolicy = container.RestartPolicyUnlessStopped
	// deploymentRouterResolver is Docker's embedded DNS server, reachable from
	// every container attached to a user-defined network.
	deploymentRouterResolver = "127.0.0.11"
	// Reloading while nginx is still starting fails because the pid file does
	// not exist yet; such a reload is retried for a short while.
	deploymentRouterReloadAttempts = 10
	deploymentRouterReloadBackoff  = 300 * time.Millisecond
	deploymentRouterOutputLimit    = 1024 * 1024
)

// A router config names the active slot's address whenever the daemon knows
// it, and then asks no DNS at all. Only a config rendered without the address
// resolves the slot: its lines only nginx 1.27.3+ understands (upstream
// servers with "resolve") end with deploymentRouterResolveTag; the
// per-request resolution lines older nginx needs instead are commented out
// with deploymentRouterFallbackTag. A router whose nginx rejects the config
// gets the fallback: those lines are swapped by deploymentRouterFallbackSed.
const (
	deploymentRouterResolveTag  = legacycompat.DeploymentRouterTagPrefix + "resolve"
	deploymentRouterFallbackTag = legacycompat.DeploymentRouterTagPrefix + "fallback "
	// deploymentRouterConfigVersion heads every config this daemon renders; a
	// router serving a config without it is rewritten (repairDeploymentRouter).
	// v3: a known slot address is proxied to on every nginx version (B-26).
	// v4: no access log on the container's stdout (B-26).
	deploymentRouterConfigVersion = legacycompat.DeploymentRouterVersion
	// deploymentRouterSlotAddressPrefix heads the line naming the active slot's
	// address a config was rendered with.
	deploymentRouterSlotAddressPrefix = legacycompat.DeploymentRouterTagPrefix + "slot-address "
	deploymentRouterFallbackSed       = "sed -e '/" + deploymentRouterResolveTag + "$/d' -e 's/^\\([[:space:]]*\\)" + deploymentRouterFallbackTag + "/\\1/'"
)

// deploymentRouterCommand is the router's start command: it writes config only
// on the very first start (the fallback when nginx rejects it), then execs
// nginx in the foreground.
func deploymentRouterCommand(config string) []string {
	script := "if [ ! -f " + deploymentRouterConfigMarker + " ]; then\n" +
		"cat > " + deploymentRouterConfigPath + " <<'EOF'\n" + config + "\nEOF\n" +
		"if grep -q '" + deploymentRouterResolveTag + "$' " + deploymentRouterConfigPath + " && ! nginx -t >/dev/null 2>&1; then\n" +
		"  " + deploymentRouterFallbackSed + " " + deploymentRouterConfigPath + " > " + deploymentRouterConfigPath + ".fallback && mv " + deploymentRouterConfigPath + ".fallback " + deploymentRouterConfigPath + "\n" +
		"fi\n" +
		"touch " + deploymentRouterConfigMarker + "\n" +
		"fi\n" +
		"exec nginx -g 'daemon off;'"
	return []string{"sh", "-c", script}
}

// deploymentRouterWriteScript replaces the router config and reloads nginx. A
// config that nginx rejects is retried as its fallback, then rolled back, so
// the file on disk (which is what a restarted router serves) always matches
// the config nginx is running.
func deploymentRouterWriteScript(config string) string {
	return "conf=" + deploymentRouterConfigPath + "\n" +
		"cat > \"$conf.next\" <<'EOF' || exit 1\n" + config + "\nEOF\n" +
		"if [ -f \"$conf\" ]; then cp \"$conf\" \"$conf.prev\" || exit 1; fi\n" +
		"mv \"$conf.next\" \"$conf\" || exit 1\n" +
		"nginx -s reload\n" +
		"status=$?\n" +
		"if [ \"$status\" -ne 0 ] && grep -q '" + deploymentRouterResolveTag + "$' \"$conf\"; then\n" +
		"  " + deploymentRouterFallbackSed + " \"$conf\" > \"$conf.next\" && mv \"$conf.next\" \"$conf\" && nginx -s reload\n" +
		"  status=$?\n" +
		"fi\n" +
		"if [ \"$status\" -ne 0 ]; then\n" +
		"  rm -f \"$conf.next\"\n" +
		"  if [ -f \"$conf.prev\" ]; then mv \"$conf.prev\" \"$conf\"; fi\n" +
		"  exit \"$status\"\n" +
		"fi\n" +
		"rm -f \"$conf.prev\"\n" +
		"touch " + deploymentRouterConfigMarker + " || :\n"
}

func deploymentRouterCreateOptions(payload deploymentCommandPayload, activeSlot string) (mobyclient.ContainerCreateOptions, error) {
	labels := map[string]string{
		deploymentManagedLabel: "true",
		deploymentIDLabel:      payload.DeploymentID,
		deploymentRoleLabel:    "router",
	}
	exposedPorts := make(network.PortSet)
	portBindings := make(network.PortMap)
	for _, route := range payload.Routes {
		port, err := network.ParsePort(fmt.Sprintf("%d/tcp", route.HostPort))
		if err != nil {
			return mobyclient.ContainerCreateOptions{}, fmt.Errorf("parse router port: %w", err)
		}
		exposedPorts[port] = struct{}{}
		hostIP := strings.TrimSpace(route.HostIP)
		if hostIP == "" {
			hostIP = "0.0.0.0"
		}
		parsedHostIP, err := netip.ParseAddr(hostIP)
		if err != nil {
			return mobyclient.ContainerCreateOptions{}, fmt.Errorf("parse router host IP: %w", err)
		}
		portBindings[port] = []network.PortBinding{{HostIP: parsedHostIP, HostPort: fmt.Sprintf("%d", route.HostPort)}}
	}
	image := payload.RouterImage
	if image == "" {
		image = defaultDeploymentRouterImage
	}
	return mobyclient.ContainerCreateOptions{
		Config: &container.Config{
			Image:        image,
			Cmd:          deploymentRouterCommand(renderDeploymentNginx(payload.Routes, activeSlot)),
			Labels:       labels,
			ExposedPorts: exposedPorts,
		},
		HostConfig: &container.HostConfig{
			NetworkMode:   container.NetworkMode(payload.NetworkName),
			PortBindings:  portBindings,
			RestartPolicy: container.RestartPolicy{Name: deploymentRouterRestartPolicy},
			SecurityOpt:   []string{"no-new-privileges:true"},
		},
		NetworkingConfig: &network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{payload.NetworkName: {}},
		},
		Name: payload.RouterName,
	}, nil
}

func (c *Client) createDeploymentRouter(ctx context.Context, payload deploymentCommandPayload, activeSlot string) (string, error) {
	options, err := deploymentRouterCreateOptions(payload, activeSlot)
	if err != nil {
		return "", err
	}
	// The first start writes this config: give it the slot's address when the
	// slot already runs, so no nginx version resolves it per request.
	slotContainer := payload.Slots[activeSlot]
	if slotContainer == "" {
		slotContainer = payload.Deployment.slotName(activeSlot)
	}
	if slotContainer != "" {
		options.Config.Cmd = deploymentRouterCommand(c.deploymentRouterConfigFor(ctx, payload.NetworkName, slotContainer, payload.Routes, activeSlot))
	}
	applyDefaultWorkloadLogConfig(options.HostConfig, c.defaultWorkloadLogDriver())
	resp, err := c.cli.ContainerCreate(ctx, options)
	if err != nil {
		return "", fmt.Errorf("create deployment router: %w", err)
	}
	if _, err := c.cli.ContainerStart(ctx, resp.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return "", fmt.Errorf("start deployment router: %w", err)
	}
	return resp.ID, nil
}

// ensureDeploymentRouterRunning makes sure the deployment router serves the
// snapshot's active slot and routes. A running router is kept (the caller
// rewrites its config). A stopped router is started only when it has the
// current shape and ports; a router created by an older daemon would restart
// with the slot baked into its command at creation time, so it is recreated
// from the snapshot instead.
func (c *Client) ensureDeploymentRouterRunning(ctx context.Context, dep deploymentSnapshot) (string, error) {
	if dep.RouterName == "" {
		return "", fmt.Errorf("router name is required")
	}
	inspect, err := c.cli.ContainerInspect(ctx, dep.RouterName, mobyclient.ContainerInspectOptions{})
	switch {
	case err == nil:
		current := inspect.Container
		if current.State != nil && current.State.Running {
			return current.ID, nil
		}
		if !deploymentRouterContainerNeedsRecreate(current, dep.Routes) {
			if _, err := c.cli.ContainerStart(ctx, dep.RouterName, mobyclient.ContainerStartOptions{}); err != nil {
				return "", fmt.Errorf("start deployment container %s: %w", dep.RouterName, err)
			}
			return current.ID, nil
		}
		var labels map[string]string
		if current.Config != nil {
			labels = current.Config.Labels
		}
		if !deploymentContainerLabelsOwned(labels, dep.ID) || labels[deploymentRoleLabel] != "router" {
			return "", fmt.Errorf("deployment router name %q is used by a container that is not owned by deployment %s", dep.RouterName, dep.ID)
		}
		if err := c.removeContainerByName(ctx, dep.RouterName, true); err != nil {
			return "", fmt.Errorf("remove stale deployment router: %w", err)
		}
	case isNotFoundErr(err):
	default:
		return "", fmt.Errorf("inspect deployment container %s: %w", dep.RouterName, err)
	}
	payload := deploymentCommandPayload{
		DeploymentID: dep.ID,
		RouterName:   dep.RouterName,
		RouterImage:  dep.RouterImage,
		NetworkName:  dep.NetworkName,
		Routes:       dep.Routes,
	}
	if payload.RouterImage == "" {
		payload.RouterImage = defaultDeploymentRouterImage
	}
	if err := c.pullImageIfNeeded(ctx, payload.RouterImage, ""); err != nil {
		return "", err
	}
	return c.createDeploymentRouter(ctx, payload, dep.ActiveSlot)
}

func (c *Client) deploymentRouterNeedsRecreate(ctx context.Context, routerName string, routes []deploymentRouteConfig) (bool, error) {
	if routerName == "" {
		return false, fmt.Errorf("router name is required")
	}
	inspect, err := c.cli.ContainerInspect(ctx, routerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return true, nil
		}
		return false, fmt.Errorf("inspect deployment router: %w", err)
	}
	return deploymentRouterContainerNeedsRecreate(inspect.Container, routes), nil
}

// deploymentRouterContainerNeedsRecreate reports whether an existing router
// must be replaced to serve routes: its published ports differ, or it was
// created by an older daemon. Only the command shape is compared, never the
// config it embeds, which legitimately goes stale after every slot switch.
func deploymentRouterContainerNeedsRecreate(current container.InspectResponse, routes []deploymentRouteConfig) bool {
	if !deploymentRouterHasCurrentShape(current) {
		return true
	}
	actual := map[string]string{}
	for port, bindings := range current.HostConfig.PortBindings {
		hostIP := "0.0.0.0"
		if len(bindings) > 0 && bindings[0].HostIP.IsValid() {
			hostIP = bindings[0].HostIP.String()
		}
		actual[port.String()] = hostIP
	}
	desired := map[string]string{}
	for _, route := range routes {
		hostIP := strings.TrimSpace(route.HostIP)
		if hostIP == "" {
			hostIP = "0.0.0.0"
		}
		desired[fmt.Sprintf("%d/tcp", route.HostPort)] = hostIP
	}
	if len(actual) != len(desired) {
		return true
	}
	for port, hostIP := range desired {
		if actual[port] != hostIP {
			return true
		}
	}
	return false
}

// deploymentRouterHasCurrentShape reports whether a router keeps its last
// written config across restarts and restarts with the Docker engine.
func deploymentRouterHasCurrentShape(current container.InspectResponse) bool {
	return deploymentRouterCommandCurrent(current) &&
		current.HostConfig.RestartPolicy.Name == deploymentRouterRestartPolicy
}

// deploymentRouterCommandCurrent reports whether a router's start command
// keeps the last written config instead of rewriting its creation-time one.
func deploymentRouterCommandCurrent(current container.InspectResponse) bool {
	if current.Config == nil || current.HostConfig == nil {
		return false
	}
	script := strings.Join(current.Config.Cmd, " ")
	return strings.Contains(script, "if [ ! -f "+deploymentRouterConfigMarker+" ]") &&
		strings.Contains(script, "exec nginx -g 'daemon off;'")
}

func deploymentContainerLabelsOwned(labels map[string]string, deploymentID string) bool {
	return deploymentID != "" && labels[deploymentManagedLabel] == "true" && labels[deploymentIDLabel] == deploymentID
}

var (
	// deploymentRouterUpstream matches the slot and container port a rendered
	// router config sends traffic to. Routers of older daemons used a static
	// proxy_pass instead.
	deploymentRouterUpstream       = regexp.MustCompile(`set \$deployment_upstream (blue|green):([0-9]+);`)
	legacyDeploymentRouterUpstream = regexp.MustCompile(`proxy_pass http://(blue|green):([0-9]+)`)
	// deploymentRouterListen matches the published port a router server
	// block listens on, in both formats.
	deploymentRouterListen = regexp.MustCompile(`listen ([0-9]+);`)
)

// deploymentRouterConfigSlot returns the one slot a router config serves, or ""
// when it names no slot or its routes disagree.
func deploymentRouterConfigSlot(config string) string {
	matches := deploymentRouterUpstream.FindAllStringSubmatch(config, -1)
	if len(matches) == 0 {
		matches = legacyDeploymentRouterUpstream.FindAllStringSubmatch(config, -1)
	}
	slot := ""
	for _, match := range matches {
		if slot != "" && slot != match[1] {
			return ""
		}
		slot = match[1]
	}
	return slot
}

// deploymentRouterInspect reports which slot a deployment router serves.
type deploymentRouterInspect struct {
	Name    string `json:"name,omitempty"`
	Found   bool   `json:"found"`
	Running bool   `json:"running"`
	// ServedSlot is the slot the router sends traffic to, or restarts serving.
	ServedSlot string `json:"servedSlot,omitempty"`
	// ConfigSource is "file" for the config on disk, "command" for the config
	// a router that never started writes on its first start.
	ConfigSource string `json:"configSource,omitempty"`
	Error        string `json:"error,omitempty"`
}

// inspectDeploymentRouter reads the slot from the router's config on disk,
// which is authoritative: a write replaces it only once nginx accepted it and a
// restarted router keeps it. A router that never started still holds the
// image's default config; its start command carries the config it will write.
// The creation command is never trusted otherwise, it goes stale on a switch.
func (c *Client) inspectDeploymentRouter(ctx context.Context, router ContainerInfo) deploymentRouterInspect {
	state := deploymentRouterInspect{Name: router.Name, Found: true, Running: router.State == "running"}
	content, err := c.readContainerFile(ctx, router.ID, deploymentRouterConfigPath, deploymentRouterOutputLimit)
	if err != nil && !isNotFoundErr(err) {
		state.Error = fmt.Sprintf("read router config: %v", err)
		return state
	}
	if err == nil {
		if slot := deploymentRouterConfigSlot(string(content)); slot != "" {
			state.ServedSlot, state.ConfigSource = slot, "file"
			return state
		}
	}
	inspect, err := c.cli.ContainerInspect(ctx, router.ID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		state.Error = fmt.Sprintf("inspect router: %v", err)
		return state
	}
	if inspect.Container.Config != nil {
		if slot := deploymentRouterConfigSlot(strings.Join(inspect.Container.Config.Cmd, " ")); slot != "" {
			state.ServedSlot, state.ConfigSource = slot, "command"
			return state
		}
	}
	state.Error = "router config does not name a deployment slot"
	return state
}

// readContainerFile reads one regular file from a running or stopped container.
func (c *Client) readContainerFile(ctx context.Context, containerID, path string, maxBytes int64) ([]byte, error) {
	archive, err := c.cli.CopyFromContainer(ctx, containerID, mobyclient.CopyFromContainerOptions{SourcePath: path})
	if err != nil {
		return nil, err
	}
	defer archive.Content.Close()
	return readSingleRegularFileFromTar(archive.Content, maxBytes)
}

func (c *Client) writeRouterConfig(ctx context.Context, routerName string, config string) error {
	script := deploymentRouterWriteScript(config)
	for attempt := 1; ; attempt++ {
		output, exitCode, err := c.runRouterScript(ctx, routerName, script)
		if err != nil {
			return err
		}
		if exitCode == 0 {
			return nil
		}
		if attempt < deploymentRouterReloadAttempts && routerReloadNotReady(output) {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(deploymentRouterReloadBackoff):
			}
			continue
		}
		if output == "" {
			output = fmt.Sprintf("exit code %d", exitCode)
		}
		return fmt.Errorf("reload router failed: %s", output)
	}
}

// runRouterScript runs script in the router and returns its output, with the
// Docker stream multiplexing removed, and its exit code.
func (c *Client) runRouterScript(ctx context.Context, routerName, script string) (string, int, error) {
	exec, err := c.cli.ExecCreate(ctx, routerName, mobyclient.ExecCreateOptions{
		AttachStdout: true,
		AttachStderr: true,
		Cmd:          []string{"sh", "-c", script},
	})
	if err != nil {
		return "", 0, fmt.Errorf("create router reload exec: %w", err)
	}
	attach, err := c.cli.ExecAttach(ctx, exec.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return "", 0, fmt.Errorf("reload router: %w", err)
	}
	raw, readErr := io.ReadAll(io.LimitReader(attach.Reader, deploymentRouterOutputLimit))
	attach.Close()
	if readErr != nil {
		return "", 0, fmt.Errorf("read router reload output: %w", readErr)
	}
	inspect, err := c.cli.ExecInspect(ctx, exec.ID, mobyclient.ExecInspectOptions{})
	if err != nil {
		return "", 0, fmt.Errorf("inspect router reload exec: %w", err)
	}
	stdout, stderr := splitDockerExecOutput(raw)
	var parts []string
	for _, part := range [][]byte{stderr, stdout} {
		if text := strings.TrimSpace(string(part)); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n"), inspect.ExitCode, nil
}

// routerReloadNotReady reports a reload that raced nginx startup: the master
// process has not written its pid file yet.
func routerReloadNotReady(output string) bool {
	return strings.Contains(output, ".pid\" failed")
}

// deploymentSlotCrashLoopRestarts is how often a slot may restart while it waits for readiness: one restart (a
// dependency not up yet) is allowed, the second means it crash-loops and readiness fails at once.
const deploymentSlotCrashLoopRestarts = 2

// deploymentSlotFailure tells why a slot will never become ready: it exited for good, or it restarted
// deploymentSlotCrashLoopRestarts times since readiness began (firstRestarts is its restart count then). Empty while
// it may still become ready.
func deploymentSlotFailure(inspect container.InspectResponse, firstRestarts int) string {
	state := inspect.State
	if state == nil {
		return ""
	}
	restarts := inspect.RestartCount - firstRestarts
	switch {
	case !state.Running && !state.Restarting && (state.Status == container.StateExited || state.Status == container.StateDead):
		return fmt.Sprintf("exited (exit code %d)", state.ExitCode)
	case restarts >= deploymentSlotCrashLoopRestarts:
		return fmt.Sprintf("is crash-looping (exit code %d, %d restarts)", state.ExitCode, restarts)
	}
	return ""
}

// deploymentContainerIP is the container's address on the network, or empty when it is not attached.
func deploymentContainerIP(inspect container.InspectResponse, networkName string) string {
	if inspect.NetworkSettings == nil {
		return ""
	}
	if endpoint := inspect.NetworkSettings.Networks[networkName]; endpoint != nil && endpoint.IPAddress.IsValid() {
		return endpoint.IPAddress.String()
	}
	return ""
}

// waitDeploymentReady probes the slot's primary route until it answers, and fails at once when the slot exits or
// crash-loops instead of waiting out the deploy timeout.
func (c *Client) waitDeploymentReady(ctx context.Context, networkName, containerName string, routes []deploymentRouteConfig, health deploymentHealthConfig) error {
	primary := routes[0]
	for _, route := range routes {
		if route.IsPrimary {
			primary = route
			break
		}
	}
	if health.Path == "" {
		health.Path = "/"
	}
	if health.StatusMin == 0 {
		health.StatusMin = 200
	}
	if health.StatusMax == 0 {
		health.StatusMax = 399
	}
	if health.TimeoutSeconds <= 0 {
		health.TimeoutSeconds = 5
	}
	if health.IntervalSeconds <= 0 {
		health.IntervalSeconds = 5
	}
	if health.SuccessThreshold <= 0 {
		health.SuccessThreshold = 1
	}
	if health.DeployTimeoutSeconds <= 0 {
		health.DeployTimeoutSeconds = 300
	}
	if health.StartupGraceSeconds > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(health.StartupGraceSeconds) * time.Second):
		}
	}
	deadline := time.Now().Add(time.Duration(health.DeployTimeoutSeconds) * time.Second)
	successes := 0
	client := http.Client{Timeout: time.Duration(health.TimeoutSeconds) * time.Second}
	firstRestarts := -1
	for time.Now().Before(deadline) {
		ip := ""
		if inspect, err := c.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{}); err == nil {
			if firstRestarts < 0 {
				firstRestarts = inspect.Container.RestartCount
			}
			if failure := deploymentSlotFailure(inspect.Container, firstRestarts); failure != "" {
				return fmt.Errorf("deployment slot %s %s", containerName, failure)
			}
			ip = deploymentContainerIP(inspect.Container, networkName)
		}
		if ip != "" {
			url := fmt.Sprintf("http://%s:%d%s", ip, primary.ContainerPort, health.Path)
			resp, reqErr := client.Get(url)
			if reqErr == nil {
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if resp.StatusCode >= health.StatusMin && resp.StatusCode <= health.StatusMax {
					successes++
					if successes >= health.SuccessThreshold {
						return nil
					}
				} else {
					successes = 0
				}
			} else {
				successes = 0
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(health.IntervalSeconds) * time.Second):
		}
	}
	return fmt.Errorf("deployment readiness timed out for %s", containerName)
}

func (c *Client) ensureDeploymentSlotRunning(ctx context.Context, containerName string) (string, error) {
	return c.ensureDeploymentContainerRunning(ctx, containerName)
}

func (c *Client) ensureDeploymentContainerRunning(ctx context.Context, containerName string) (string, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect deployment container %s: %w", containerName, err)
	}
	if insp.Container.State != nil && insp.Container.State.Running {
		return insp.Container.ID, nil
	}
	if _, err := c.cli.ContainerStart(ctx, containerName, mobyclient.ContainerStartOptions{}); err != nil {
		return "", fmt.Errorf("start deployment container %s: %w", containerName, err)
	}
	return insp.Container.ID, nil
}

func (c *Client) containerID(ctx context.Context, containerName string) (string, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", err
	}
	return insp.Container.ID, nil
}

func (c *Client) containerIP(ctx context.Context, containerName, networkName string) (string, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", err
	}
	if ip := deploymentContainerIP(insp.Container, networkName); ip != "" {
		return ip, nil
	}
	return "", fmt.Errorf("container %s is not attached to %s", containerName, networkName)
}

func (c *Client) pullImageIfNeeded(ctx context.Context, imageRef string, registryAuth string) error {
	if imageRef == "" {
		return nil
	}
	return c.EnsureImage(ctx, imageRef, registryAuth)
}

// removeContainerByName removes a deployment slot or router for good: a deploy or a router replacement creates a new
// one and never carries the old one's anonymous volumes over, so they go too.
func (c *Client) removeContainerByName(ctx context.Context, name string, force bool) error {
	if name == "" {
		return nil
	}
	err := c.RemoveContainerAndAnonymousVolumes(ctx, name, force)
	if err != nil && !isNotFoundErr(err) {
		return err
	}
	return nil
}

func (d deploymentSnapshot) slotName(slot string) string {
	for _, candidate := range d.Slots {
		if candidate.Slot == slot {
			return candidate.ContainerName
		}
	}
	return ""
}

func envMapToList(env map[string]string) []string {
	if len(env) == 0 {
		return nil
	}
	items := make([]string, 0, len(env))
	for k, v := range env {
		items = append(items, k+"="+v)
	}
	return items
}

func deploymentBinds(mounts []deploymentMount) []string {
	var binds []string
	for _, mount := range mounts {
		source := mount.HostPath
		if source == "" {
			source = mount.Name
		}
		if source == "" || mount.ContainerPath == "" {
			continue
		}
		bind := source + ":" + mount.ContainerPath
		if mount.ReadOnly {
			bind += ":ro"
		}
		binds = append(binds, bind)
	}
	return binds
}

// renderDeploymentNginx renders a router config that does not know the active
// slot's address yet; see renderDeploymentNginxAt.
func renderDeploymentNginx(routes []deploymentRouteConfig, activeSlot string) string {
	return renderDeploymentNginxAt(routes, activeSlot, "")
}

// renderDeploymentNginxAt renders the router config for the active slot.
// With the slot container's address known, every router proxies to that
// address and asks no DNS at all: Docker's embedded DNS is served by dockerd,
// and a frozen dockerd must not hold a single request of a running slot (B-8,
// D5, B-26). The daemon re-renders the config when the slot's address changes
// (reconcileDeploymentRouterAddresses). Only without the address (dockerd did
// not tell it yet) does the router resolve the slot: in the background on
// nginx 1.27.3+, per request before.
func renderDeploymentNginxAt(routes []deploymentRouteConfig, activeSlot, slotAddress string) string {
	if address, err := netip.ParseAddr(slotAddress); err != nil || !address.IsValid() || address.IsUnspecified() {
		slotAddress = ""
	} else {
		slotAddress = address.String()
	}
	var b strings.Builder
	b.WriteString(deploymentRouterConfigVersion + "\n")
	if slotAddress != "" {
		b.WriteString(deploymentRouterSlotAddressPrefix + slotAddress + "\n")
	}
	b.WriteString("map $http_upgrade $connection_upgrade {\n  default upgrade;\n  '' close;\n}\n")
	if slotAddress == "" {
		// The active slot is resolved through Docker's embedded DNS in the
		// background (upstream servers with "resolve"), never on the request
		// path. nginx keeps the last addresses while the resolver does not
		// answer, starts and reloads while the slot is stopped (it then has
		// no address and answers 502), and picks up a restarted slot's new
		// address within valid. nginx before 1.27.3 has no "resolve": it
		// resolves the slot per request.
		fmt.Fprintf(&b, "resolver %s valid=2s ipv6=off; %s\n", deploymentRouterResolver, deploymentRouterResolveTag)
		fmt.Fprintf(&b, "%sresolver %s valid=10s ipv6=off;\n", deploymentRouterFallbackTag, deploymentRouterResolver)
	}
	seen := map[string]bool{}
	for _, route := range routes {
		name := deploymentRouterUpstreamName(activeSlot, route.ContainerPort)
		if seen[name] {
			continue
		}
		seen[name] = true
		if slotAddress != "" {
			fmt.Fprintf(&b, "upstream %s { server %s; }\n", name,
				net.JoinHostPort(slotAddress, fmt.Sprintf("%d", route.ContainerPort)))
			continue
		}
		fmt.Fprintf(&b, "upstream %s { %s\n", name, deploymentRouterResolveTag)
		fmt.Fprintf(&b, "  zone %s 64k; %s\n", name, deploymentRouterResolveTag)
		fmt.Fprintf(&b, "  server %s:%d resolve; %s\n", activeSlot, route.ContainerPort, deploymentRouterResolveTag)
		fmt.Fprintf(&b, "} %s\n", deploymentRouterResolveTag)
	}
	for _, route := range routes {
		fmt.Fprintf(&b, "server {\n  listen %d;\n", route.HostPort)
		// Body size is the ingress route's decision; the router in front of
		// the slots must not add nginx's 1 MB default on top of it.
		b.WriteString("  client_max_body_size 0;\n")
		// No access log: the image writes it to the container's stdout, which
		// dockerd drains. While dockerd is frozen that pipe fills (about 50 s
		// at 30 requests/s) and every nginx worker then blocks writing a log
		// line, holding all requests through the router (B-26). The ingress
		// logs each request already.
		b.WriteString("  access_log off;\n")
		// A 502 or 504 the router generates itself (the slot is stopped,
		// starting or unreachable) is marked, so readiness probes and
		// operators tell it from an answer of the app (D6).
		b.WriteString("  error_page 502 504 = " + legacycompat.DeploymentRouterUnavailable + ";\n")
		b.WriteString("  location / {\n")
		// Names the slot for proxy_redirect (and the config's routes); it is
		// never resolved when the address is known.
		fmt.Fprintf(&b, "    set $deployment_upstream %s:%d;\n", activeSlot, route.ContainerPort)
		// Without a URI part, proxy_pass forwards the original request URI
		// unchanged, exactly as the static http://slot:port form did.
		if slotAddress != "" {
			fmt.Fprintf(&b, "    proxy_pass http://%s;\n", deploymentRouterUpstreamName(activeSlot, route.ContainerPort))
		} else {
			fmt.Fprintf(&b, "    proxy_pass http://%s; %s\n", deploymentRouterUpstreamName(activeSlot, route.ContainerPort), deploymentRouterResolveTag)
			fmt.Fprintf(&b, "    %sproxy_pass http://$deployment_upstream;\n", deploymentRouterFallbackTag)
		}
		// Upstream Location headers naming the slot are rewritten as before.
		b.WriteString("    proxy_redirect http://$deployment_upstream/ /;\n")
		// A crashed slot keeps its address until the daemon or the resolver
		// learns the new one; fail fast instead of holding requests for the
		// 60 s default.
		b.WriteString("    proxy_connect_timeout 5s;\n")
		b.WriteString("    proxy_http_version 1.1;\n")
		// Stream request bodies to the slot instead of spooling them to disk.
		b.WriteString("    proxy_request_buffering off;\n")
		b.WriteString("    proxy_set_header Host $host;\n")
		b.WriteString("    proxy_set_header X-Real-IP $remote_addr;\n")
		b.WriteString("    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n")
		b.WriteString("    proxy_set_header X-Forwarded-Proto $scheme;\n")
		b.WriteString("    proxy_set_header Upgrade $http_upgrade;\n")
		b.WriteString("    proxy_set_header Connection $connection_upgrade;\n")
		b.WriteString("  }\n")
		b.WriteString("  location " + legacycompat.DeploymentRouterUnavailable + " {\n")
		fmt.Fprintf(&b, "    add_header %s upstream-unavailable always;\n", deploymentRouterUnavailableHeader)
		b.WriteString("    return 502;\n")
		b.WriteString("  }\n}\n")
	}
	return b.String()
}

// deploymentRouterUpstreamName names the upstream of one slot port.
func deploymentRouterUpstreamName(slot string, containerPort uint16) string {
	return fmt.Sprintf(legacycompat.DeploymentRouterUpstreamPrefix+"%s_%d", slot, containerPort)
}

// deploymentRouterConfigCurrent reports whether a router config is one this
// daemon renders (either variant), not an older daemon's per-request config.
func deploymentRouterConfigCurrent(config string) bool {
	return strings.HasPrefix(strings.TrimLeft(config, "\n"), deploymentRouterConfigVersion)
}

var deploymentRouterSlotAddressLine = regexp.MustCompile(`(?m)^` + legacycompat.DeploymentRouterTagPrefix + `slot-address (\S+)$`)

// deploymentRouterConfigAddress is the slot address a rendered config names,
// or "" when it names none.
func deploymentRouterConfigAddress(config string) string {
	if match := deploymentRouterSlotAddressLine.FindStringSubmatch(config); match != nil {
		return match[1]
	}
	return ""
}

// deploymentRouterConfigFor renders the router config for the active slot
// with the slot container's current address on the deployment network, when
// dockerd tells it.
func (c *Client) deploymentRouterConfigFor(ctx context.Context, networkName, slotContainer string, routes []deploymentRouteConfig, activeSlot string) string {
	address := ""
	if networkName != "" && slotContainer != "" {
		lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		if ip, err := c.containerIP(lookupCtx, slotContainer, networkName); err == nil {
			address = ip
		}
		cancel()
	}
	return renderDeploymentNginxAt(routes, activeSlot, address)
}

func isNotFoundErr(err error) bool {
	if err == nil {
		return false
	}
	if cerrdefs.IsNotFound(err) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "no such container") ||
		strings.Contains(msg, "no such network") ||
		strings.Contains(msg, "no such image") ||
		strings.Contains(msg, "not found")
}
