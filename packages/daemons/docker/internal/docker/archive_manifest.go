package docker

import (
	"context"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// ofcaContainerManifest is intentionally an Opfield-owned whitelist. It must
// not grow into a serialized Docker inspect response: every field here has a
// matching Opfield create/recreate setting and an explicit import policy.
type ofcaContainerManifest struct {
	SchemaVersion  int               `json:"schemaVersion"`
	Name           string            `json:"name"`
	Platform       string            `json:"platform,omitempty"`
	ImageReference string            `json:"imageReference,omitempty"`
	Entrypoint     []string          `json:"entrypoint,omitempty"`
	Command        []string          `json:"command,omitempty"`
	WorkingDir     string            `json:"workingDir,omitempty"`
	User           string            `json:"user,omitempty"`
	Hostname       string            `json:"hostname,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	Environment    map[string]string `json:"environment,omitempty"`
	Secrets        map[string]string `json:"secrets,omitempty"`
	Ports          []ofcaPortMapping `json:"ports,omitempty"`
	Mounts         []ofcaMount       `json:"mounts,omitempty"`
	Networks       []ofcaNetwork     `json:"networks,omitempty"`
	RestartPolicy  string            `json:"restartPolicy,omitempty"`
	MaxRetries     int               `json:"maxRetries,omitempty"`
	StopTimeout    *int              `json:"stopTimeout,omitempty"`
	Resources      ofcaResources     `json:"resources,omitempty"`
	Warnings       []string          `json:"warnings,omitempty"`
}

type ofcaPortMapping struct {
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort"`
	Protocol      string `json:"protocol"`
}

type ofcaMount struct {
	Type            string            `json:"type"`
	Source          string            `json:"source"`
	Target          string            `json:"target"`
	ReadOnly        bool              `json:"readOnly"`
	Driver          string            `json:"driver,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
	CreateNew       bool              `json:"createNew,omitempty"`
	RequiresMapping bool              `json:"requiresMapping,omitempty"`
}

type ofcaNetwork struct {
	Name            string `json:"name"`
	Driver          string `json:"driver,omitempty"`
	Subnet          string `json:"subnet,omitempty"`
	Gateway         string `json:"gateway,omitempty"`
	Createable      bool   `json:"createable"`
	CreateNew       bool   `json:"createNew,omitempty"`
	RequiresMapping bool   `json:"requiresMapping,omitempty"`
}

type ofcaResources struct {
	MemoryLimit int64 `json:"memoryLimit,omitempty"`
	MemorySwap  int64 `json:"memorySwap,omitempty"`
	NanoCPUs    int64 `json:"nanoCPUs,omitempty"`
	CPUShares   int64 `json:"cpuShares,omitempty"`
	PidsLimit   int64 `json:"pidsLimit,omitempty"`
}

func sanitizeOfcaLabels(labels map[string]string) map[string]string {
	result := cloneStringMap(labels)
	for key := range result {
		managed := key
		if next := opfieldLabelKey(key); next != "" {
			// legacy-name: legacycompat.LabelPrefix* labels of an archive from a pre-Opfield node — remove once every node reports none
			managed = next
		}
		if strings.HasPrefix(key, "com.docker.compose.") ||
			strings.HasPrefix(managed, "net.opfield.archive.") ||
			strings.HasPrefix(managed, "net.opfield.deployment.") ||
			strings.HasPrefix(managed, "net.opfield.migration.") {
			delete(result, key)
		}
	}
	return result
}

// validateOfcaNetworks applies the container create network rules to the
// networks an archive manifest names, which are user input: no host
// networking, no other container's namespace, none only as the one network,
// and none of the networks Opfield owns on the node (Secure Links, managed
// database and storage links), existing or to be created under that name.
func validateOfcaNetworks(networks []ofcaNetwork) error {
	named, isolated := 0, false
	for _, entry := range networks {
		if entry.Name == "" {
			continue
		}
		named++
		isolated = isolated || entry.Name == "none"
		if err := validateUserWorkloadNetworkMode(entry.Name); err != nil {
			return fmt.Errorf("archive network: %w", err)
		}
		if isReservedOpfieldNetworkName(entry.Name) {
			return fmt.Errorf("archive network %q is managed by Opfield and cannot be attached to imported containers", entry.Name)
		}
	}
	if isolated && named > 1 {
		return fmt.Errorf("archive network none cannot be combined with other networks")
	}
	return nil
}

func buildOfcaContainerManifest(
	ctx context.Context,
	p *DockerPlugin,
	containerID string,
	environment map[string]string,
	secrets map[string]string,
) (ofcaContainerManifest, error) {
	result, err := p.client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{Size: true})
	if err != nil {
		return ofcaContainerManifest{}, fmt.Errorf("inspect archive source container: %w", err)
	}
	ctr := result.Container
	if ctr.Config == nil || ctr.HostConfig == nil {
		return ofcaContainerManifest{}, fmt.Errorf("source inspect is missing create configuration")
	}
	if ctr.Config.Labels[deploymentManagedLabel] == "true" {
		return ofcaContainerManifest{}, fmt.Errorf("blue/green deployment containers must be managed through their deployment")
	}
	if err := validateOfcaExportSupport(ctr.Config, ctr.HostConfig, ctr.Mounts); err != nil {
		return ofcaContainerManifest{}, err
	}
	for key := range secrets {
		if _, duplicate := environment[key]; duplicate {
			return ofcaContainerManifest{}, fmt.Errorf("environment and secrets contain duplicate key %q", key)
		}
	}

	labels := sanitizeOfcaLabels(ctr.Config.Labels)
	manifest := ofcaContainerManifest{
		SchemaVersion:  1,
		Name:           strings.TrimPrefix(ctr.Name, "/"),
		Platform:       ctr.Platform,
		ImageReference: configuredArchiveImageReference(ctr.Config.Image, ctr.Config.Labels),
		Entrypoint:     append([]string(nil), ctr.Config.Entrypoint...),
		Command:        append([]string(nil), ctr.Config.Cmd...),
		WorkingDir:     ctr.Config.WorkingDir,
		User:           ctr.Config.User,
		Hostname:       ctr.Config.Hostname,
		Labels:         labels,
		Environment:    cloneStringMap(environment),
		Secrets:        cloneStringMap(secrets),
		RestartPolicy:  string(ctr.HostConfig.RestartPolicy.Name),
		MaxRetries:     ctr.HostConfig.RestartPolicy.MaximumRetryCount,
		StopTimeout:    ctr.Config.StopTimeout,
		Resources: ofcaResources{
			MemoryLimit: ctr.HostConfig.Memory,
			MemorySwap:  ctr.HostConfig.MemorySwap,
			NanoCPUs:    ctr.HostConfig.NanoCPUs,
			CPUShares:   ctr.HostConfig.CPUShares,
			PidsLimit:   valueOrZero(ctr.HostConfig.PidsLimit),
		},
	}

	for exposed, bindings := range ctr.HostConfig.PortBindings {
		port := int(exposed.Num())
		if port < 1 || port > 65535 {
			return ofcaContainerManifest{}, fmt.Errorf("archive source has invalid exposed port %q", exposed)
		}
		protocol := string(exposed.Proto())
		if protocol != "tcp" && protocol != "udp" {
			return ofcaContainerManifest{}, fmt.Errorf("archive source uses unsupported port protocol %q", protocol)
		}
		for _, binding := range bindings {
			if binding.HostIP.IsValid() && !binding.HostIP.IsUnspecified() {
				return ofcaContainerManifest{}, fmt.Errorf("archive source binds %s to a specific host address", exposed)
			}
			hostPort, err := strconv.Atoi(binding.HostPort)
			if err != nil || hostPort < 0 || hostPort > 65535 {
				return ofcaContainerManifest{}, fmt.Errorf("archive source has invalid host port %q", binding.HostPort)
			}
			manifest.Ports = append(manifest.Ports, ofcaPortMapping{ContainerPort: port, HostPort: hostPort, Protocol: protocol})
		}
	}
	sort.Slice(manifest.Ports, func(i, j int) bool {
		if manifest.Ports[i].ContainerPort != manifest.Ports[j].ContainerPort {
			return manifest.Ports[i].ContainerPort < manifest.Ports[j].ContainerPort
		}
		return manifest.Ports[i].Protocol < manifest.Ports[j].Protocol
	})

	for _, mount := range ctr.Mounts {
		entry := ofcaMount{Target: mount.Destination, ReadOnly: !mount.RW}
		switch string(mount.Type) {
		case "bind":
			return ofcaContainerManifest{}, fmt.Errorf("archive source contains a host bind mount")
		case "volume":
			if mount.Name == "" {
				return ofcaContainerManifest{}, fmt.Errorf("archive source contains an anonymous volume")
			}
			volumeResult, inspectErr := p.client.cli.VolumeInspect(ctx, mount.Name, mobyclient.VolumeInspectOptions{})
			if inspectErr != nil {
				return ofcaContainerManifest{}, fmt.Errorf("inspect archive volume %q: %w", mount.Name, inspectErr)
			}
			entry.Type = "volume"
			entry.Source = mount.Name
			entry.Driver = volumeResult.Volume.Driver
			entry.Labels = cloneStringMap(volumeResult.Volume.Labels)
			entry.CreateNew = volumeResult.Volume.Driver == "local" && len(volumeResult.Volume.Options) == 0
			entry.RequiresMapping = !entry.CreateNew
		default:
			return ofcaContainerManifest{}, fmt.Errorf("archive source uses unsupported mount type %q", mount.Type)
		}
		manifest.Mounts = append(manifest.Mounts, entry)
	}

	if ctr.NetworkSettings != nil {
		for name := range ctr.NetworkSettings.Networks {
			entry := ofcaNetwork{Name: name}
			networkResult, inspectErr := p.client.cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{})
			if inspectErr == nil {
				net := networkResult.Network
				entry.Driver = net.Driver
				if len(net.IPAM.Config) > 0 {
					entry.Subnet = net.IPAM.Config[0].Subnet.String()
					entry.Gateway = net.IPAM.Config[0].Gateway.String()
				}
				entry.Createable = net.Scope == "local" && !net.Internal && !net.Ingress && !net.ConfigOnly && len(net.Options) == 0
				entry.RequiresMapping = !entry.Createable && name != "bridge"
			}
			manifest.Networks = append(manifest.Networks, entry)
		}
		sort.Slice(manifest.Networks, func(i, j int) bool { return manifest.Networks[i].Name < manifest.Networks[j].Name })
	}
	if ctr.SizeRw != nil && *ctr.SizeRw > 0 {
		manifest.Warnings = append(manifest.Warnings, fmt.Sprintf("Writable layer contains %d bytes and is excluded unless explicitly captured", *ctr.SizeRw))
	}
	return manifest, nil
}

func validateOfcaExportSupport(config *container.Config, host *container.HostConfig, mounts []container.MountPoint) error {
	var unsupported []string
	if config.Healthcheck != nil {
		unsupported = append(unsupported, "healthcheck")
	}
	if config.Tty || config.OpenStdin || config.StdinOnce {
		unsupported = append(unsupported, "interactive TTY/stdin settings")
	}
	if host.Privileged || len(host.CapAdd) > 0 || len(host.CapDrop) > 0 {
		unsupported = append(unsupported, "privileged/capability settings")
	}
	if len(host.Devices) > 0 || len(host.DeviceRequests) > 0 {
		unsupported = append(unsupported, "host devices or GPUs")
	}
	for _, attached := range mounts {
		if string(attached.Type) == "bind" {
			unsupported = append(unsupported, "host bind mounts")
			break
		}
	}
	unsupportedSecurityOpt := false
	for _, option := range host.SecurityOpt {
		if option != "no-new-privileges" && option != "no-new-privileges:true" {
			unsupportedSecurityOpt = true
			break
		}
	}
	if unsupportedSecurityOpt || len(host.Sysctls) > 0 || host.CgroupParent != "" {
		unsupported = append(unsupported, "security, sysctl, or cgroup settings")
	}
	if len(host.VolumesFrom) > 0 || len(host.Links) > 0 || host.ContainerIDFile != "" {
		unsupported = append(unsupported, "container dependencies or ID files")
	}
	if hostNamespaceMode(string(host.NetworkMode)) || hostNamespaceMode(string(host.IpcMode)) ||
		hostNamespaceMode(string(host.PidMode)) || hostNamespaceMode(string(host.UTSMode)) ||
		hostNamespaceMode(string(host.UsernsMode)) || hostNamespaceMode(string(host.CgroupnsMode)) {
		unsupported = append(unsupported, "host/container namespace sharing")
	}
	if !isOpfieldDefaultLogConfig(host.LogConfig) &&
		(len(host.LogConfig.Config) > 0 || (host.LogConfig.Type != "" && host.LogConfig.Type != "json-file")) {
		unsupported = append(unsupported, "custom log driver configuration")
	}
	if len(host.DNS) > 0 || len(host.DNSOptions) > 0 || len(host.DNSSearch) > 0 || len(host.ExtraHosts) > 0 || len(host.GroupAdd) > 0 {
		unsupported = append(unsupported, "custom DNS, hosts, or group settings")
	}
	const dockerDefaultShmSize = 64 * 1024 * 1024
	customRuntime := host.Runtime != "" && host.Runtime != "runc"
	customShmSize := host.ShmSize != 0 && host.ShmSize != dockerDefaultShmSize
	if host.AutoRemove || host.PublishAllPorts || host.ReadonlyRootfs || len(host.Tmpfs) > 0 || customRuntime || customShmSize {
		unsupported = append(unsupported, "unsupported runtime settings")
	}
	if host.MemoryReservation != 0 || host.MemorySwappiness != nil || (host.OomKillDisable != nil && *host.OomKillDisable) || len(host.Ulimits) > 0 ||
		host.BlkioWeight != 0 || len(host.BlkioWeightDevice) > 0 || len(host.BlkioDeviceReadBps) > 0 ||
		len(host.BlkioDeviceWriteBps) > 0 || len(host.BlkioDeviceReadIOps) > 0 || len(host.BlkioDeviceWriteIOps) > 0 ||
		host.CPUPeriod != 0 || host.CPUQuota != 0 || host.CPURealtimePeriod != 0 || host.CPURealtimeRuntime != 0 ||
		host.CpusetCpus != "" || host.CpusetMems != "" {
		unsupported = append(unsupported, "unsupported resource controls")
	}
	if len(unsupported) > 0 {
		sort.Strings(unsupported)
		return fmt.Errorf("container cannot be exported as a portable Opfield archive: %s", strings.Join(unsupported, "; "))
	}
	return nil
}

func valueOrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func ofcaManifestToMigration(manifest ofcaContainerManifest, imageID, imageReference, name, migrationID string) (createStoppedContainerRequest, error) {
	if manifest.SchemaVersion != 1 {
		return createStoppedContainerRequest{}, fmt.Errorf("unsupported archive container manifest")
	}
	if err := validateOfcaNetworks(manifest.Networks); err != nil {
		return createStoppedContainerRequest{}, err
	}
	if strings.TrimSpace(name) == "" {
		return createStoppedContainerRequest{}, fmt.Errorf("container name is required")
	}
	mergedEnv := make(map[string]string, len(manifest.Environment)+len(manifest.Secrets))
	for key, value := range manifest.Environment {
		if key == "" || strings.Contains(key, "=") {
			return createStoppedContainerRequest{}, fmt.Errorf("invalid environment key %q", key)
		}
		mergedEnv[key] = value
	}
	for key, value := range manifest.Secrets {
		if _, duplicate := mergedEnv[key]; duplicate {
			return createStoppedContainerRequest{}, fmt.Errorf("environment and secrets contain duplicate key %q", key)
		}
		mergedEnv[key] = value
	}
	envKeys := make([]string, 0, len(mergedEnv))
	env := make([]string, 0, len(mergedEnv))
	for key := range mergedEnv {
		envKeys = append(envKeys, key)
	}
	sort.Strings(envKeys)
	for _, key := range envKeys {
		env = append(env, key+"="+mergedEnv[key])
	}

	config := &container.Config{
		Image:        imageReference,
		Entrypoint:   append([]string(nil), manifest.Entrypoint...),
		Cmd:          append([]string(nil), manifest.Command...),
		WorkingDir:   manifest.WorkingDir,
		User:         manifest.User,
		Hostname:     manifest.Hostname,
		Labels:       sanitizeOfcaLabels(manifest.Labels),
		StopTimeout:  manifest.StopTimeout,
		ExposedPorts: make(network.PortSet),
	}
	host := &container.HostConfig{
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyMode(manifest.RestartPolicy), MaximumRetryCount: manifest.MaxRetries},
		PortBindings:  make(network.PortMap),
		Privileged:    false,
		SecurityOpt:   []string{"no-new-privileges:true"},
	}
	host.Memory = manifest.Resources.MemoryLimit
	host.MemorySwap = manifest.Resources.MemorySwap
	host.NanoCPUs = manifest.Resources.NanoCPUs
	host.CPUShares = manifest.Resources.CPUShares
	if manifest.Resources.PidsLimit != 0 {
		value := manifest.Resources.PidsLimit
		host.PidsLimit = &value
	}
	for _, port := range manifest.Ports {
		if port.ContainerPort < 1 || port.ContainerPort > 65535 || port.HostPort < 0 || port.HostPort > 65535 ||
			(port.Protocol != "tcp" && port.Protocol != "udp") {
			return createStoppedContainerRequest{}, fmt.Errorf("archive contains invalid port mapping")
		}
		parsed, err := network.ParsePort(fmt.Sprintf("%d/%s", port.ContainerPort, port.Protocol))
		if err != nil {
			return createStoppedContainerRequest{}, fmt.Errorf("parse archive port: %w", err)
		}
		config.ExposedPorts[parsed] = struct{}{}
		host.PortBindings[parsed] = append(host.PortBindings[parsed], network.PortBinding{
			HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: strconv.Itoa(port.HostPort),
		})
	}
	for _, mount := range manifest.Mounts {
		if mount.Source == "" || mount.Target == "" || mount.Type != "volume" {
			return createStoppedContainerRequest{}, fmt.Errorf("archive contains invalid mount")
		}
		bind := mount.Source + ":" + mount.Target
		if mount.ReadOnly {
			bind += ":ro"
		}
		host.Binds = append(host.Binds, bind)
	}
	endpoints := make(map[string]*network.EndpointSettings, len(manifest.Networks))
	for _, attached := range manifest.Networks {
		if attached.Name != "" {
			endpoints[attached.Name] = &network.EndpointSettings{}
		}
	}
	networking := &network.NetworkingConfig{EndpointsConfig: endpoints}
	if len(manifest.Networks) > 0 {
		host.NetworkMode = container.NetworkMode(manifest.Networks[0].Name)
	}
	migrationManifest := dockerMigrationManifest{
		SchemaVersion:    1,
		Name:             name,
		ImageID:          imageID,
		ImageReference:   imageReference,
		Platform:         manifest.Platform,
		Config:           config,
		HostConfig:       host,
		NetworkingConfig: networking,
		EnvKeys:          envKeys,
	}
	return createStoppedContainerRequest{MigrationID: migrationID, Manifest: migrationManifest, Env: env}, nil
}
