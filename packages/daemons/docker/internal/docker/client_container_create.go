package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/gpu"
)

type ContainerCreateConfig struct {
	InternalWorkload string            `json:"internal_workload,omitempty"`
	Name             string            `json:"name"`
	Image            string            `json:"image"`
	Cmd              []string          `json:"cmd,omitempty"`
	Entrypoint       []string          `json:"entrypoint,omitempty"`
	Env              []string          `json:"env,omitempty"`
	Labels           map[string]string `json:"labels,omitempty"`
	WorkingDir       string            `json:"working_dir,omitempty"`
	User             string            `json:"user,omitempty"`
	Hostname         string            `json:"hostname,omitempty"`
	StopTimeout      *int              `json:"stopTimeout,omitempty"`
	Tty              bool              `json:"tty,omitempty"`
	OpenStdin        bool              `json:"open_stdin,omitempty"`

	// Host config
	Binds        []string               `json:"binds,omitempty"`
	PortBindings map[string]string      `json:"port_bindings,omitempty"` // "80/tcp": "8080"
	Ports        []containerPortMapping `json:"ports,omitempty"`
	NetworkMode  string                 `json:"network_mode,omitempty"`
	// NetworkAliases are scoped to NetworkMode.
	NetworkAliases []string `json:"network_aliases,omitempty"`
	RestartPolicy  string   `json:"restartPolicy,omitempty"` // "no", "always", "unless-stopped", "on-failure"
	// Backward-compatible alias for older daemon-local config payloads.
	RestartPolicyLegacy string     `json:"restart_policy,omitempty"`
	Privileged          bool       `json:"privileged,omitempty"`
	CapAdd              []string   `json:"cap_add,omitempty"`
	CapDrop             []string   `json:"cap_drop,omitempty"`
	ExtraHosts          []string   `json:"extra_hosts,omitempty"`
	GPU                 *GPUConfig `json:"gpu,omitempty"`
	RuntimeProfile      string     `json:"runtimeProfile,omitempty"`
}

type containerPortMapping struct {
	HostIP        string `json:"hostIp,omitempty"`
	HostPort      uint16 `json:"hostPort"`
	ContainerPort uint16 `json:"containerPort"`
	Protocol      string `json:"protocol"`
}

func dockerPortMappings(mappings []containerPortMapping) (network.PortSet, network.PortMap, error) {
	exposedPorts := make(network.PortSet)
	portBindings := make(network.PortMap)
	for _, mapping := range mappings {
		protocol := strings.ToLower(strings.TrimSpace(mapping.Protocol))
		if protocol == "" {
			protocol = "tcp"
		}
		if protocol != "tcp" && protocol != "udp" {
			return nil, nil, fmt.Errorf("unsupported port protocol %q", mapping.Protocol)
		}
		if mapping.ContainerPort == 0 {
			return nil, nil, fmt.Errorf("container port must be greater than zero")
		}
		containerPort, err := network.ParsePort(fmt.Sprintf("%d/%s", mapping.ContainerPort, protocol))
		if err != nil {
			return nil, nil, fmt.Errorf("parse port %d/%s: %w", mapping.ContainerPort, protocol, err)
		}
		hostIP := strings.TrimSpace(mapping.HostIP)
		if hostIP == "" {
			hostIP = "0.0.0.0"
		}
		parsedHostIP, err := netip.ParseAddr(hostIP)
		if err != nil {
			return nil, nil, fmt.Errorf("parse host IP %q: %w", hostIP, err)
		}
		exposedPorts[containerPort] = struct{}{}
		portBindings[containerPort] = append(portBindings[containerPort], network.PortBinding{
			HostIP: parsedHostIP, HostPort: fmt.Sprintf("%d", mapping.HostPort),
		})
	}
	return exposedPorts, portBindings, nil
}

// GPUConfig is a node-scoped, Gateway-owned selection. Empty deviceIds is an
// explicit detach request during recreate; an omitted GPU field preserves the
// existing HostConfig mapping.
type GPUConfig struct {
	DeviceIDs []string `json:"deviceIds"`
}

func (cfg ContainerCreateConfig) effectiveRestartPolicy() string {
	if cfg.RestartPolicy != "" {
		return cfg.RestartPolicy
	}
	return cfg.RestartPolicyLegacy
}

// GPUDevices returns the daemon-authoritative inventory with Docker-specific
// NVIDIA runtime readiness applied. Monitoring-only daemons intentionally do
// not make this additional Docker check.
func (c *Client) GPUDevices(ctx context.Context) []gpu.Device {
	if c.gpuInventory == nil {
		return nil
	}
	devices := c.gpuInventory.Collect(ctx)
	return gpu.ApplyNVIDIAContainerRuntimeReadiness(devices, c.nvidiaRuntimeAvailable(ctx))
}

func (c *Client) nvidiaRuntimeAvailable(ctx context.Context) bool {
	if c.cli == nil {
		return false
	}
	info, err := c.cli.Info(ctx, client.InfoOptions{})
	if err != nil {
		return false
	}
	_, available := info.Info.Runtimes["nvidia"]
	return available
}

type gpuSelection struct {
	devices []gpu.Device
}

func (c *Client) resolveGPUConfig(ctx context.Context, config *GPUConfig) (*gpuSelection, error) {
	if config == nil {
		return nil, nil
	}
	if c.gpuInventory == nil {
		return nil, fmt.Errorf("GPU discovery is unavailable on this Docker daemon")
	}
	devices, err := c.gpuInventory.Resolve(ctx, config.DeviceIDs)
	if err != nil {
		return nil, err
	}
	for _, device := range devices {
		if device.Vendor == gpu.VendorNVIDIA && !c.nvidiaRuntimeAvailable(ctx) {
			return nil, fmt.Errorf("GPU device %q is unavailable: NVIDIA Container Toolkit is not configured in Docker", device.ID)
		}
	}
	return &gpuSelection{devices: devices}, nil
}

func (c *Client) applyGPUConfig(ctx context.Context, containerCfg *container.Config, hostCfg *container.HostConfig, config *GPUConfig) error {
	selection, err := c.resolveGPUConfig(ctx, config)
	if err != nil {
		return err
	}
	c.applyResolvedGPUSelection(containerCfg, hostCfg, selection)
	return nil
}

func (c *Client) applyResolvedGPUSelection(containerCfg *container.Config, hostCfg *container.HostConfig, selection *gpuSelection) {
	if selection == nil {
		return
	}
	previousManagedGroupIDs := managedGPUGroupIDs(containerCfg)
	nextManagedGroupIDs := applyGPUSelection(hostCfg, selection.devices, previousManagedGroupIDs)
	setManagedGPUGroupIDs(containerCfg, nextManagedGroupIDs)
}

// applyGPUSelection only changes Gateway-managed GPU entries. It deliberately
// leaves unrelated HostConfig devices intact so a GPU edit cannot become a
// generic host-device rewrite.
func applyGPUSelection(hostCfg *container.HostConfig, devices []gpu.Device, previousManagedGroupIDs []string) []string {
	if hostCfg == nil {
		return nil
	}
	filteredRequests := hostCfg.DeviceRequests[:0]
	for _, request := range hostCfg.DeviceRequests {
		if isGatewayNVIDIARequest(request) {
			continue
		}
		filteredRequests = append(filteredRequests, request)
	}
	hostCfg.DeviceRequests = filteredRequests

	filteredMappings := hostCfg.Devices[:0]
	for _, mapping := range hostCfg.Devices {
		if isGatewayDirectGPUPath(mapping.PathOnHost) {
			continue
		}
		filteredMappings = append(filteredMappings, mapping)
	}
	hostCfg.Devices = filteredMappings
	if hostCfg.Runtime == "nvidia" {
		hostCfg.Runtime = ""
	}

	nvidiaIDs := make([]string, 0, len(devices))
	groupIDs := withoutStrings(hostCfg.GroupAdd, previousManagedGroupIDs)
	currentGroupIDs := make(map[string]struct{}, len(groupIDs))
	for _, groupID := range groupIDs {
		currentGroupIDs[groupID] = struct{}{}
	}
	previousManagedSet := make(map[string]struct{}, len(previousManagedGroupIDs))
	for _, groupID := range previousManagedGroupIDs {
		previousManagedSet[groupID] = struct{}{}
	}
	nextManagedGroupIDs := []string{}
	mappedPaths := make(map[string]struct{}, len(hostCfg.Devices))
	for _, mapping := range hostCfg.Devices {
		mappedPaths[mapping.PathOnHost] = struct{}{}
	}
	for _, device := range devices {
		switch device.Vendor {
		case gpu.VendorNVIDIA:
			if device.RuntimeID != "" {
				nvidiaIDs = append(nvidiaIDs, device.RuntimeID)
			}
		case gpu.VendorAMD, gpu.VendorIntel:
			for _, path := range device.DevicePaths {
				if _, exists := mappedPaths[path]; exists {
					continue
				}
				mappedPaths[path] = struct{}{}
				hostCfg.Devices = append(hostCfg.Devices, container.DeviceMapping{
					PathOnHost:        path,
					PathInContainer:   path,
					CgroupPermissions: "rwm",
				})
			}
			for _, groupID := range device.GroupIDs {
				if groupID == "" {
					continue
				}
				_, alreadyPresent := currentGroupIDs[groupID]
				_, wasGatewayManaged := previousManagedSet[groupID]
				if !alreadyPresent {
					groupIDs = append(groupIDs, groupID)
					currentGroupIDs[groupID] = struct{}{}
				}
				if wasGatewayManaged || !alreadyPresent {
					nextManagedGroupIDs = appendUniqueStrings(nextManagedGroupIDs, groupID)
				}
			}
		}
	}
	if len(nvidiaIDs) > 0 {
		hostCfg.DeviceRequests = append(hostCfg.DeviceRequests, container.DeviceRequest{
			Driver:       "nvidia",
			DeviceIDs:    nvidiaIDs,
			Capabilities: [][]string{{"gpu"}},
		})
	}
	hostCfg.GroupAdd = groupIDs
	return nextManagedGroupIDs
}

func managedGPUGroupIDs(containerCfg *container.Config) []string {
	if containerCfg == nil || containerCfg.Labels == nil || containerCfg.Labels[gatewayGPUGroupIDsVersionLabel] != gatewayGPUGroupIDsVersion {
		return nil
	}
	return parseGPUGroupIDs(containerCfg.Labels[gatewayGPUGroupIDsLabel])
}

func preserveGatewayManagedContainerLabels(existing map[string]string, replacement map[string]string) {
	if replacement == nil {
		return
	}
	if existing != nil {
		if value, exists := existing[archiveImageReferenceLabel]; exists {
			replacement[archiveImageReferenceLabel] = value
		}
	}
	// GPU group provenance is daemon-owned metadata. Never admit values from a
	// caller: an untracked label must not turn a pre-existing group into one we
	// are allowed to remove on a later detach.
	for _, label := range []string{gatewayGPUGroupIDsLabel, gatewayGPUGroupIDsVersionLabel} {
		if existing == nil {
			delete(replacement, label)
			continue
		}
		if value, exists := existing[label]; exists {
			replacement[label] = value
		} else {
			delete(replacement, label)
		}
	}
}

func setManagedGPUGroupIDs(containerCfg *container.Config, groupIDs []string) {
	if containerCfg == nil {
		return
	}
	if len(groupIDs) == 0 {
		if containerCfg.Labels != nil {
			delete(containerCfg.Labels, gatewayGPUGroupIDsLabel)
			delete(containerCfg.Labels, gatewayGPUGroupIDsVersionLabel)
		}
		return
	}
	sort.Strings(groupIDs)
	if containerCfg.Labels == nil {
		containerCfg.Labels = map[string]string{}
	}
	containerCfg.Labels[gatewayGPUGroupIDsLabel] = strings.Join(groupIDs, ",")
	containerCfg.Labels[gatewayGPUGroupIDsVersionLabel] = gatewayGPUGroupIDsVersion
}

func parseGPUGroupIDs(value string) []string {
	return appendUniqueStrings(nil, strings.Split(value, ",")...)
}

func withoutStrings(values []string, remove []string) []string {
	if len(remove) == 0 {
		return append([]string(nil), values...)
	}
	removed := make(map[string]struct{}, len(remove))
	for _, value := range remove {
		if value != "" {
			removed[value] = struct{}{}
		}
	}
	filtered := make([]string, 0, len(values))
	for _, value := range values {
		if _, shouldRemove := removed[value]; !shouldRemove {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func isGatewayNVIDIARequest(request container.DeviceRequest) bool {
	driver := strings.TrimSpace(request.Driver)
	if driver != "" && !strings.EqualFold(driver, "nvidia") {
		return false
	}
	if len(request.DeviceIDs) == 0 || len(request.Capabilities) != 1 || len(request.Capabilities[0]) != 1 || !strings.EqualFold(request.Capabilities[0][0], "gpu") {
		return false
	}
	return len(request.Options) == 0 && request.Count == 0
}

func isGatewayDirectGPUPath(path string) bool {
	return path == "/dev/kfd" || strings.HasPrefix(path, "/dev/dri/renderD")
}

func appendUniqueStrings(values []string, additions ...string) []string {
	seen := make(map[string]struct{}, len(values)+len(additions))
	for _, value := range values {
		seen[value] = struct{}{}
	}
	for _, value := range additions {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

// CreateContainer parses configJSON into a container config and creates the container.
// Returns the container ID and name.
func (c *Client) CreateContainer(ctx context.Context, configJSON string) (string, string, error) {
	var cfg ContainerCreateConfig
	decoder := json.NewDecoder(strings.NewReader(configJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return "", "", fmt.Errorf("parse container config: %w", err)
	}

	if cfg.InternalWorkload != "" {
		return "", "", fmt.Errorf("internal workloads require the daemon-owned create path")
	}
	if cfg.Image == "" {
		return "", "", fmt.Errorf("image is required")
	}
	if cfg.Privileged || len(cfg.CapAdd) > 0 {
		return "", "", fmt.Errorf("privileged mode and added capabilities are not allowed for user workloads")
	}
	if hasHostBind(cfg.Binds) {
		return "", "", fmt.Errorf("host bind mounts are not allowed for new user workloads")
	}
	if err := validateUserWorkloadNetworkMode(cfg.NetworkMode); err != nil {
		return "", "", err
	}
	containerCfg := &container.Config{
		Image:       cfg.Image,
		Cmd:         cfg.Cmd,
		Entrypoint:  cfg.Entrypoint,
		Env:         cfg.Env,
		Labels:      cfg.Labels,
		WorkingDir:  cfg.WorkingDir,
		User:        cfg.User,
		Hostname:    cfg.Hostname,
		StopTimeout: cfg.StopTimeout,
		Tty:         cfg.Tty,
		OpenStdin:   cfg.OpenStdin,
	}

	hostCfg := &container.HostConfig{
		Binds:       cfg.Binds,
		NetworkMode: container.NetworkMode(cfg.NetworkMode),
		Privileged:  cfg.Privileged,
		CapAdd:      cfg.CapAdd,
		CapDrop:     cfg.CapDrop,
		ExtraHosts:  cfg.ExtraHosts,
	}
	applyUserWorkloadBaseline(hostCfg)
	applyDefaultWorkloadLogConfig(hostCfg, c.defaultWorkloadLogDriver())
	if err := c.applyRuntimeProfile(hostCfg, cfg.RuntimeProfile, cfg.GPU); err != nil {
		return "", "", err
	}
	if cfg.GPU != nil {
		if err := c.applyGPUConfig(ctx, containerCfg, hostCfg, cfg.GPU); err != nil {
			return "", "", err
		}
	}

	if cfg.Ports != nil {
		exposedPorts, portMap, err := dockerPortMappings(cfg.Ports)
		if err != nil {
			return "", "", err
		}
		containerCfg.ExposedPorts = exposedPorts
		hostCfg.PortBindings = portMap
	} else if len(cfg.PortBindings) > 0 {
		// Backward-compatible daemon-local create format: "80/tcp" -> "8080".
		portMap := make(network.PortMap)
		for containerPort, hostPort := range cfg.PortBindings {
			port, err := network.ParsePort(containerPort)
			if err != nil {
				return "", "", fmt.Errorf("parse port %q: %w", containerPort, err)
			}
			portMap[port] = []network.PortBinding{
				{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: hostPort},
			}
		}
		hostCfg.PortBindings = portMap
	}

	// Parse restart policy
	restartPolicy := cfg.effectiveRestartPolicy()
	if restartPolicy != "" {
		hostCfg.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(restartPolicy)}
	}

	networkingConfig, err := c.networkingConfigForCreate(cfg)
	if err != nil {
		return "", "", err
	}

	result, err := c.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:           containerCfg,
		HostConfig:       hostCfg,
		NetworkingConfig: networkingConfig,
		Name:             cfg.Name,
	})
	if err != nil {
		return "", "", fmt.Errorf("create container: %w", err)
	}

	return result.ID, cfg.Name, nil
}

// validateUserWorkloadNetworkMode rejects network modes that would share
// another namespace or join the Secure Links management network.
//
// Managed database networks (gateway-db-*) are allowed: the HA adapter creates
// placement and adoption containers of database-bound workloads directly on
// them, and released control planes depend on that. The control plane rejects
// managed networks on user create requests before they reach the daemon.
func validateUserWorkloadNetworkMode(mode string) error {
	mode = strings.TrimSpace(mode)
	switch {
	case mode == "host":
		return errors.New("host networking is not allowed for user workloads")
	case strings.Contains(mode, ":"):
		return fmt.Errorf("network mode %q is not allowed for user workloads", mode)
	case mode == secureLinkManagementNetwork:
		return fmt.Errorf("Opfield-managed network %q cannot be attached to user workloads", mode)
	}
	return nil
}

func (c *Client) networkingConfigForCreate(cfg ContainerCreateConfig) (*network.NetworkingConfig, error) {
	if len(cfg.NetworkAliases) == 0 {
		return nil, nil
	}
	if cfg.NetworkMode == "" {
		return nil, errors.New("network mode is required for endpoint configuration")
	}
	endpoint := &network.EndpointSettings{Aliases: cfg.NetworkAliases}
	return &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
		cfg.NetworkMode: endpoint,
	}}, nil
}

func applyUserWorkloadBaseline(hostCfg *container.HostConfig) {
	hostCfg.Privileged = false
	hostCfg.CapAdd = nil
	hostCfg.SecurityOpt = appendUniqueStrings(hostCfg.SecurityOpt, "no-new-privileges:true")
}

// Log rotation applied to user workloads that have no log configuration of
// their own, so a busy container cannot fill the disk with json-file logs.
const (
	jsonFileLogDriver      = "json-file"
	workloadLogMaxSize     = "50m"
	workloadLogMaxFile     = "3"
	logDriverDetectTimeout = 10 * time.Second
	// hostConfiguredLogDefaults marks a host whose daemon.json sets default
	// log-opts; containers then inherit the operator's options unchanged.
	hostConfiguredLogDefaults = "host-configured"
	defaultDockerDaemonConfig = "/etc/docker/daemon.json"
)

// dockerDaemonConfigPath is the Docker daemon configuration read for the
// operator's default log options (GATEWAY_DOCKER_DAEMON_CONFIG overrides it).
func dockerDaemonConfigPath() string {
	if value := strings.TrimSpace(os.Getenv("GATEWAY_DOCKER_DAEMON_CONFIG")); value != "" {
		return value
	}
	return defaultDockerDaemonConfig
}

// hostDefaultLogOptions reports whether the Docker daemon configuration at
// path sets default log-opts. A missing file means no; a file that cannot be
// read or parsed is treated as yes, so the operator's choice is never
// overridden by guesswork.
func hostDefaultLogOptions(path string) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	var config struct {
		LogOpts map[string]any `json:"log-opts"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return true, err
	}
	return len(config.LogOpts) > 0, nil
}

// DetectDefaultLoggingDriver asks the Docker daemon for its default logging
// driver once and caches it for workload creation. When the query fails the
// driver is assumed to be json-file, Docker's built-in default. When the
// host's daemon.json sets default log-opts, workloads keep them.
func (c *Client) DetectDefaultLoggingDriver(ctx context.Context) string {
	driver := jsonFileLogDriver
	if c.cli != nil {
		infoCtx, cancel := context.WithTimeout(ctx, logDriverDetectTimeout)
		info, err := c.cli.Info(infoCtx, client.InfoOptions{})
		cancel()
		switch {
		case err != nil:
			if c.logger != nil {
				c.logger.Warn("docker default logging driver unknown, assuming json-file", "error", err)
			}
		case strings.TrimSpace(info.Info.LoggingDriver) != "":
			driver = strings.TrimSpace(info.Info.LoggingDriver)
		}
	}
	if driver == jsonFileLogDriver {
		configured, err := hostDefaultLogOptions(dockerDaemonConfigPath())
		if err != nil && c.logger != nil {
			c.logger.Warn("cannot read the Docker daemon log options; keeping the host defaults for workloads", "error", err)
		}
		if configured {
			driver = hostConfiguredLogDefaults
		}
	}
	c.defaultLogDriver.Store(&driver)
	return driver
}

// defaultWorkloadLogDriver returns the cached default logging driver, or
// json-file when it was never detected.
func (c *Client) defaultWorkloadLogDriver() string {
	if driver := c.defaultLogDriver.Load(); driver != nil {
		return *driver
	}
	return jsonFileLogDriver
}

// applyDefaultWorkloadLogConfig gives a user workload without its own log
// configuration json-file rotation (50m x 3). It only does so when the
// Docker daemon's default driver is json-file: a host that configured
// another default driver (local, journald, ...) keeps its policy. A
// configuration with options or another driver is never changed.
func applyDefaultWorkloadLogConfig(hostCfg *container.HostConfig, defaultDriver string) {
	if hostCfg == nil || !isUnsetWorkloadLogConfig(hostCfg.LogConfig) {
		return
	}
	if driver := strings.TrimSpace(defaultDriver); driver != "" && driver != jsonFileLogDriver {
		return
	}
	hostCfg.LogConfig = container.LogConfig{
		Type:   jsonFileLogDriver,
		Config: map[string]string{"max-size": workloadLogMaxSize, "max-file": workloadLogMaxFile},
	}
}

// isUnsetWorkloadLogConfig reports whether cfg carries no user choice: no
// options and either no driver or json-file, which Docker records on inspect
// for containers created without a log configuration.
func isUnsetWorkloadLogConfig(cfg container.LogConfig) bool {
	return (cfg.Type == "" || cfg.Type == jsonFileLogDriver) && len(cfg.Config) == 0
}

// isGatewayDefaultLogConfig reports whether cfg holds only json-file rotation
// options (max-size, max-file), such as the Gateway workload default. These
// are portable and carry no secrets, unlike other log driver options.
func isGatewayDefaultLogConfig(cfg container.LogConfig) bool {
	if (cfg.Type != "" && cfg.Type != jsonFileLogDriver) || len(cfg.Config) == 0 {
		return false
	}
	for key := range cfg.Config {
		if key != "max-size" && key != "max-file" {
			return false
		}
	}
	return true
}

func (c *Client) applyRuntimeProfile(hostCfg *container.HostConfig, profile string, gpuConfig *GPUConfig) error {
	switch profile {
	case "", "default":
		hostCfg.Runtime = ""
		return nil
	case "secure":
		if !c.runscHealthy.Load() {
			return fmt.Errorf("Secure Runtime is not healthy on this node")
		}
		networkMode := strings.TrimSpace(string(hostCfg.NetworkMode))
		if networkMode == "host" || strings.HasPrefix(networkMode, "container:") {
			return fmt.Errorf("Secure Runtime requires an isolated Docker network namespace")
		}
		if gpuConfig != nil && len(gpuConfig.DeviceIDs) > 0 {
			return fmt.Errorf("Secure Runtime does not support GPU attachments")
		}
		if len(hostCfg.Devices) > 0 || len(hostCfg.DeviceRequests) > 0 {
			return fmt.Errorf("Secure Runtime does not support device attachments")
		}
		if hasHostBind(hostCfg.Binds) {
			return fmt.Errorf("Secure Runtime does not support host bind mounts")
		}
		hostCfg.Runtime = "runsc"
		applyUserWorkloadBaseline(hostCfg)
		return nil
	default:
		return fmt.Errorf("unsupported runtime profile %q", profile)
	}
}

func hasHostBind(binds []string) bool {
	for _, bind := range binds {
		source := strings.SplitN(bind, ":", 2)[0]
		if filepath.IsAbs(source) {
			return true
		}
	}
	return false
}

func (c *Client) HTTPProbe(ctx context.Context, configJSON string) (HTTPProbeResult, error) {
	var cfg HTTPProbeConfig
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		return HTTPProbeResult{}, fmt.Errorf("parse http probe config: %w", err)
	}
	if cfg.Scheme == "" {
		cfg.Scheme = "http"
	}
	if cfg.Path == "" {
		cfg.Path = "/"
	}
	if !strings.HasPrefix(cfg.Path, "/") {
		cfg.Path = "/" + cfg.Path
	}
	if cfg.StatusMin == 0 {
		cfg.StatusMin = 200
	}
	if cfg.StatusMax == 0 {
		cfg.StatusMax = 399
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 5
	}

	url := fmt.Sprintf("%s://127.0.0.1:%d%s", cfg.Scheme, cfg.HostPort, cfg.Path)
	probeCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.TimeoutSeconds)*time.Second)
	defer cancel()

	start := time.Now()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, url, nil)
	if err != nil {
		return HTTPProbeResult{}, err
	}
	probeClient := &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := probeClient.Do(req)
	responseMs := time.Since(start).Milliseconds()
	if err != nil {
		return HTTPProbeResult{OK: false, Status: "offline", ResponseMs: responseMs, Error: err.Error()}, nil
	}
	defer resp.Body.Close()

	passed := resp.StatusCode >= cfg.StatusMin && resp.StatusCode <= cfg.StatusMax
	if passed && cfg.ExpectedBody != "" {
		bodyBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
		if readErr != nil {
			return HTTPProbeResult{
				OK:         false,
				Status:     "offline",
				HTTPStatus: resp.StatusCode,
				ResponseMs: responseMs,
				Error:      readErr.Error(),
			}, nil
		}
		passed = httpProbeBodyMatches(string(bodyBytes), cfg.ExpectedBody, cfg.BodyMatchMode)
	}

	status := "offline"
	if passed {
		status = "online"
		if cfg.SlowThreshold > 0 && responseMs >= cfg.SlowThreshold {
			status = "degraded"
		}
	}
	return HTTPProbeResult{
		OK:         passed,
		Status:     status,
		HTTPStatus: resp.StatusCode,
		ResponseMs: responseMs,
	}, nil
}

func httpProbeBodyMatches(body string, expected string, mode string) bool {
	switch mode {
	case "exact":
		return body == expected
	case "starts_with":
		return strings.HasPrefix(body, expected)
	case "ends_with":
		return strings.HasSuffix(body, expected)
	default:
		return strings.Contains(body, expected)
	}
}

// reservedDockerLabelPrefixes are the label namespaces Gateway and Docker Compose read to place, group, hide
// or admit a container (the backend's docker-reserved-labels.ts holds the same set). A user workload carrying
// them would join another Compose project (and its root-level folder), disappear behind a Gateway
// implementation marker or pass for a Gateway deployment, so duplicates never copy them and Compose
// services may not set them.
var reservedDockerLabelPrefixes = []string{
	"com.docker.compose.",
	"wiolett.gateway.",
	"net.wiolett.gateway.",
	"com.wiolett.gateway.",
}

func isReservedDockerLabel(key string) bool {
	if key == "gateway.sandbox" {
		return true
	}
	for _, prefix := range reservedDockerLabelPrefixes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

// duplicateContainerLabels copies the source labels a duplicate may keep. Daemon-owned data that describes the
// copied configuration itself (the archive image reference and the GPU group provenance of the copied host
// config) is kept.
func duplicateContainerLabels(source map[string]string) map[string]string {
	if source == nil {
		return nil
	}
	labels := make(map[string]string, len(source))
	for key, value := range source {
		switch key {
		case archiveImageReferenceLabel, gatewayGPUGroupIDsLabel, gatewayGPUGroupIDsVersionLabel:
			labels[key] = value
			continue
		}
		if !isReservedDockerLabel(key) {
			labels[key] = value
		}
	}
	return labels
}

// DuplicateContainer inspects a source container and creates a new one with the same config and a different name.
// A copy is not linked: it leaves out removeEnv (the source's database and storage link variables, which carry the
// links' credentials) and the source's link networks with their host aliases.
func (c *Client) DuplicateContainer(ctx context.Context, id string, newName string, removeEnv []string) (string, error) {
	inspResult, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect source container: %w", err)
	}
	insp := inspResult.Container

	// Clone config, clear runtime fields.
	cfg := *insp.Config
	cfg.Hostname = ""
	// A copy is a new user workload: it never inherits the labels that place, group or hide a container.
	cfg.Labels = duplicateContainerLabels(insp.Config.Labels)
	cfg.Env = applyEnvChanges(insp.Config.Env, nil, removeEnv)
	applyDefaultWorkloadLogConfig(insp.HostConfig, c.defaultWorkloadLogDriver())
	netNames := withoutLinkNetworks(inspectNetworkNames(&insp))
	hostCfg := duplicateHostConfig(insp.HostConfig, netNames)
	result, err := c.cli.ContainerCreate(ctx, client.ContainerCreateOptions{
		Config:           &cfg,
		HostConfig:       hostCfg,
		NetworkingConfig: networkingConfigForInspectNetwork(&insp, netNames),
		Name:             newName,
	})
	if err != nil {
		return "", fmt.Errorf("create duplicate container: %w", err)
	}

	if err := c.connectContainerToAdditionalNetworks(ctx, result.ID, &insp, netNames); err != nil {
		_, _ = c.cli.ContainerRemove(ctx, result.ID, client.ContainerRemoveOptions{Force: true})
		return "", fmt.Errorf("connect duplicate container networks: %w", err)
	}

	return result.ID, nil
}

// isLinkNetwork reports a managed database binding, storage link or container link network.
func isLinkNetwork(name string) bool {
	return strings.HasPrefix(name, "gateway-db-") || storageBindingNetworkNamePattern.MatchString(name) ||
		containerLinkNetworkPattern.MatchString(name)
}

func withoutLinkNetworks(netNames []string) []string {
	kept := make([]string, 0, len(netNames))
	for _, name := range netNames {
		if !isLinkNetwork(name) {
			kept = append(kept, name)
		}
	}
	return kept
}

// duplicateHostConfig is the source's host config for a copy on netNames: without the link aliases, and on the
// first remaining network when the source's own network mode is a link network (no network when none remains, so
// the copy never reaches more than the source did).
func duplicateHostConfig(source *container.HostConfig, netNames []string) *container.HostConfig {
	if source == nil {
		return nil
	}
	hostCfg := *source
	if len(source.ExtraHosts) > 0 {
		hostCfg.ExtraHosts = mergeManagedDatabaseExtraHosts(source.ExtraHosts, nil)
	}
	if isLinkNetwork(string(hostCfg.NetworkMode)) {
		hostCfg.NetworkMode = container.NetworkMode("none")
		if len(netNames) > 0 {
			hostCfg.NetworkMode = container.NetworkMode(netNames[0])
		}
	}
	return &hostCfg
}

// UpdateContainer performs an update of the container configuration.
// If newTag is set, it pulls that image first, then recreates the container.
// For env-only/config-preserving updates, it recreates directly without talking
// to the registry. envOverrides are merged on top; envRemovals are stripped.
