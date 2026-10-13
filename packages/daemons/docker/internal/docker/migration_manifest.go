package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

type dockerMigrationManifest struct {
	SchemaVersion    int                       `json:"schemaVersion"`
	SourceID         string                    `json:"sourceId"`
	Name             string                    `json:"name"`
	ImageID          string                    `json:"imageId"`
	ImageReference   string                    `json:"imageReference"`
	Platform         string                    `json:"platform,omitempty"`
	Config           *container.Config         `json:"config"`
	HostConfig       *container.HostConfig     `json:"hostConfig"`
	NetworkingConfig *network.NetworkingConfig `json:"networkingConfig"`
	EnvKeys          []string                  `json:"envKeys"`
	VolumeNames      []string                  `json:"volumeNames"`
	Blockers         []string                  `json:"blockers"`
	Warnings         []string                  `json:"warnings"`
}

type createStoppedContainerRequest struct {
	MigrationID string                  `json:"migrationId"`
	Manifest    dockerMigrationManifest `json:"manifest"`
	Env         []string                `json:"env"`
}

const migrationOwnershipLabel = "net.opfield.migration.id"
const archiveImageReferenceLabel = "net.opfield.archive.image.reference"

// migrationManifestSchemaVersion 2: EnvKeys name the container's own
// environment, not the image defaults it runs unchanged (see
// migrationOwnEnvKeys). Opfield supplies the values of exactly these keys. A
// Opfield that still sends the whole runtime environment cannot start a
// migration with this daemon: the daemon advertises docker_migration_v2 only.
const migrationManifestSchemaVersion = 2

// migrationManifestLabels are the labels of a manifest in their Opfield keys
// only. The source and the target capture the same manifest and Opfield
// compares the two, but the target is created with Opfield keys (both families
// before its start is confirmed) while a container labelled before Opfield
// carries the old ones, so both sides write every key the same way.
func migrationManifestLabels(labels map[string]string) map[string]string {
	if labels == nil {
		return nil
	}
	out := make(map[string]string, len(labels))
	for key, value := range labels {
		if next := opfieldLabelKey(key); next != "" {
			// legacy-name: wiolett.gateway.* labels of a source container — remove once every node reports none
			if _, ok := labels[next]; !ok {
				out[next] = value
			}
			continue
		}
		out[key] = value
	}
	return out
}

func configuredArchiveImageReference(image string, labels map[string]string) string {
	if archivedReference := strings.TrimSpace(labelValue(labels, archiveImageReferenceLabel)); archivedReference != "" {
		return archivedReference
	}
	return strings.TrimSpace(image)
}

// migrationManifestValidation is the preflight answer for a container: the
// blockers its migration would stop at, with the same text.
type migrationManifestValidation struct {
	Blockers []string `json:"blockers"`
}

func (c *Client) CaptureMigrationManifest(ctx context.Context, id string) (dockerMigrationManifest, error) {
	return c.captureMigrationManifest(ctx, id, true)
}

// ValidateMigrationManifest runs the checks of the manifest capture for
// Opfield's migration preflight. It reads the container and its image only,
// and skips the writable layer size, which Docker computes by walking the
// layer and which only adds a warning.
func (c *Client) ValidateMigrationManifest(ctx context.Context, id string) (migrationManifestValidation, error) {
	manifest, err := c.captureMigrationManifest(ctx, id, false)
	if err != nil {
		return migrationManifestValidation{}, err
	}
	return migrationManifestValidation{Blockers: append([]string{}, manifest.Blockers...)}, nil
}

func (c *Client) captureMigrationManifest(ctx context.Context, id string, withSize bool) (dockerMigrationManifest, error) {
	inspected, err := c.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{Size: withSize})
	if err != nil {
		return dockerMigrationManifest{}, fmt.Errorf("inspect migration source container: %w", err)
	}
	ctr := inspected.Container
	if ctr.Config == nil || ctr.HostConfig == nil {
		return dockerMigrationManifest{}, fmt.Errorf("source inspect is missing create configuration")
	}
	sourceImage, err := c.cli.ImageInspect(ctx, ctr.Image)
	if err != nil {
		return dockerMigrationManifest{}, fmt.Errorf("inspect migration source image: %w", err)
	}
	var imageEnv []string
	if sourceImage.Config != nil {
		imageEnv = sourceImage.Config.Env
	}
	config := cloneContainerConfig(ctr.Config)
	config.Labels = migrationManifestLabels(config.Labels)
	delete(config.Labels, migrationOwnershipLabel)
	imageReference := configuredArchiveImageReference(ctr.Config.Image, config.Labels)
	delete(config.Labels, archiveImageReferenceLabel)
	hostConfig := cloneHostConfig(ctr.HostConfig)
	manifest := dockerMigrationManifest{
		SchemaVersion:  migrationManifestSchemaVersion,
		SourceID:       ctr.ID,
		Name:           strings.TrimPrefix(ctr.Name, "/"),
		ImageID:        ctr.Image,
		ImageReference: imageReference,
		Platform:       ctr.Platform,
		Config:         config,
		HostConfig:     hostConfig,
	}

	manifest.EnvKeys, manifest.Blockers = migrationOwnEnvKeys(config.Env, imageEnv, manifest.Blockers)
	config.Env = nil
	if len(hostConfig.LogConfig.Config) > 0 && !isOpfieldDefaultLogConfig(hostConfig.LogConfig) {
		manifest.Blockers = append(manifest.Blockers, "Docker log driver options may contain secrets and require explicit migration support")
		for key := range hostConfig.LogConfig.Config {
			hostConfig.LogConfig.Config[key] = ""
		}
	}

	if hasComposeLabels(config.Labels) {
		manifest.Blockers = append(manifest.Blockers, "host-managed Docker Compose resources are not migratable")
	}
	if len(hostConfig.VolumesFrom) > 0 {
		manifest.Blockers = append(manifest.Blockers, "volumes-from dependencies are host-bound")
	}
	if len(hostConfig.Links) > 0 {
		manifest.Blockers = append(manifest.Blockers, "legacy container links are host-bound")
	}
	if hostConfig.ContainerIDFile != "" {
		manifest.Blockers = append(manifest.Blockers, "container ID files are host-bound")
	}
	if hostConfig.Runtime == "runsc" {
		manifest.Blockers = append(manifest.Blockers, "Secure Runtime containers are not migratable between nodes")
	}
	if hostNamespaceMode(string(hostConfig.NetworkMode)) || hostNamespaceMode(string(hostConfig.IpcMode)) ||
		hostNamespaceMode(string(hostConfig.PidMode)) || hostNamespaceMode(string(hostConfig.UTSMode)) {
		manifest.Blockers = append(manifest.Blockers, "host or container namespace sharing is not portable")
	}
	manifest.VolumeNames, manifest.Blockers = classifyMigrationMounts(ctr.Mounts, manifest.Blockers)

	if ctr.NetworkSettings != nil {
		endpoints := make(map[string]*network.EndpointSettings, len(ctr.NetworkSettings.Networks))
		for name, source := range ctr.NetworkSettings.Networks {
			if source == nil {
				continue
			}
			endpoints[name] = &network.EndpointSettings{
				IPAMConfig: source.IPAMConfig,
				Links:      append([]string(nil), source.Links...),
				Aliases:    portableNetworkAliases(source.Aliases, ctr.ID),
				DriverOpts: cloneStringMap(source.DriverOpts),
				GwPriority: source.GwPriority,
			}
			if source.IPAddress.IsValid() || source.GlobalIPv6Address.IsValid() {
				manifest.Warnings = append(manifest.Warnings, fmt.Sprintf("dynamic address on network %q will be reassigned", name))
			}
			if source.MacAddress != nil {
				manifest.Warnings = append(manifest.Warnings, fmt.Sprintf("runtime MAC address on network %q will be reassigned", name))
			}
		}
		manifest.NetworkingConfig = &network.NetworkingConfig{EndpointsConfig: endpoints}
	}

	manifest.Blockers = append(manifest.Blockers,
		unsupportedCreateFields(inspected.Raw, reflect.TypeOf(container.Config{}), reflect.TypeOf(container.HostConfig{}))...)
	if ctr.SizeRw != nil && *ctr.SizeRw > 0 {
		manifest.Warnings = append(manifest.Warnings, fmt.Sprintf("writable layer contains %d bytes and is not migrated", *ctr.SizeRw))
	}
	sort.Strings(manifest.Blockers)
	manifest.Blockers = compactStrings(manifest.Blockers)
	return manifest, nil
}

// migrationOwnEnvKeys returns the keys of the container's own environment: its
// runtime environment without the entries the image sets to the same value.
// The target runs the same image, so Docker adds those entries again; a
// container that overrides an image variable keeps the key. An environment
// that cannot be rebuilt that way is a blocker: a duplicate key, an entry
// without a value, or an image variable the container unset.
func migrationOwnEnvKeys(containerEnv, imageEnv []string, blockers []string) ([]string, []string) {
	imageEntries := make(map[string]bool, len(imageEnv))
	for _, entry := range imageEnv {
		imageEntries[entry] = true
	}
	var keys []string
	seen := map[string]bool{}
	for _, entry := range containerEnv {
		key, _, hasValue := strings.Cut(entry, "=")
		if key == "" {
			continue
		}
		switch {
		case seen[key]:
			blockers = append(blockers, fmt.Sprintf("duplicate environment key %q", key))
		case !hasValue:
			blockers = append(blockers, fmt.Sprintf("environment variable %q has no value", key))
		case !imageEntries[entry]:
			keys = append(keys, key)
		}
		seen[key] = true
	}
	for _, entry := range imageEnv {
		if key, _, _ := strings.Cut(entry, "="); key != "" && !seen[key] {
			blockers = append(blockers, fmt.Sprintf("image environment variable %q is unset in the container", key))
		}
	}
	sort.Strings(keys)
	return keys, blockers
}

// validateMigrationEnv checks that Opfield supplied a value for exactly the
// environment keys of the manifest, naming every key that differs.
func validateMigrationEnv(manifestKeys []string, env []string) error {
	expected := make(map[string]bool, len(manifestKeys))
	for _, key := range manifestKeys {
		expected[key] = true
	}
	supplied := make(map[string]bool, len(env))
	var unexpected []string
	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			return fmt.Errorf("invalid environment entry")
		}
		if supplied[key] {
			return fmt.Errorf("environment key %s is supplied twice", key)
		}
		supplied[key] = true
		if !expected[key] {
			unexpected = append(unexpected, key)
		}
	}
	var missing []string
	for _, key := range manifestKeys {
		if !supplied[key] {
			missing = append(missing, key)
		}
	}
	if len(missing) == 0 && len(unexpected) == 0 {
		return nil
	}
	sort.Strings(unexpected)
	var details []string
	if len(missing) > 0 {
		details = append(details, "missing "+strings.Join(missing, ", "))
	}
	if len(unexpected) > 0 {
		details = append(details, "unexpected "+strings.Join(unexpected, ", "))
	}
	return fmt.Errorf("environment keys do not match manifest: %s", strings.Join(details, "; "))
}

func classifyMigrationMounts(
	mounts []container.MountPoint,
	blockers []string,
) ([]string, []string) {
	var volumeNames []string
	for _, mount := range mounts {
		switch string(mount.Type) {
		case "volume":
			if mount.Name == "" {
				blockers = append(blockers, "anonymous volumes are not migratable")
				continue
			}
			if mount.Driver != "local" {
				blockers = append(blockers, fmt.Sprintf("volume %q uses unsupported driver %q", mount.Name, mount.Driver))
			}
			volumeNames = append(volumeNames, mount.Name)
		case "bind":
			blockers = append(blockers, "bind mounts are host-bound")
		default:
			blockers = append(blockers, fmt.Sprintf("mount type %q is not supported", mount.Type))
		}
	}
	sort.Strings(volumeNames)
	return compactStrings(volumeNames), blockers
}

func portableNetworkAliases(aliases []string, containerID string) []string {
	shortID := containerID
	if len(shortID) > 12 {
		shortID = shortID[:12]
	}
	result := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		if alias != containerID && alias != shortID {
			result = append(result, alias)
		}
	}
	return result
}

func (c *Client) CreateContainerStopped(ctx context.Context, req createStoppedContainerRequest) (string, error) {
	manifest := req.Manifest
	// Version 1 is the manifest an archive import builds from its own keys.
	if req.MigrationID == "" || (manifest.SchemaVersion != 1 && manifest.SchemaVersion != migrationManifestSchemaVersion) ||
		manifest.Config == nil || manifest.HostConfig == nil {
		return "", fmt.Errorf("unsupported or incomplete migration manifest")
	}
	if err := validateStoppedCreateNetworks(manifest.HostConfig, manifest.NetworkingConfig); err != nil {
		return "", err
	}
	if existing, err := c.cli.ContainerInspect(ctx, manifest.Name, mobyclient.ContainerInspectOptions{}); err == nil {
		if existing.Container.Config != nil && labelValue(existing.Container.Config.Labels, migrationOwnershipLabel) == req.MigrationID {
			return existing.Container.ID, nil
		}
		return "", fmt.Errorf("target container name %q is already in use", manifest.Name)
	}
	if len(manifest.Blockers) > 0 {
		return "", fmt.Errorf("migration manifest contains blockers")
	}
	if err := validateMigrationEnv(manifest.EnvKeys, req.Env); err != nil {
		return "", err
	}
	config := cloneContainerConfig(manifest.Config)
	config.Env = append([]string(nil), req.Env...)
	if err := applyMigrationCreateImage(config, manifest); err != nil {
		return "", err
	}
	if config.Labels == nil {
		config.Labels = map[string]string{}
	}
	config.Labels[migrationOwnershipLabel] = req.MigrationID
	hostConfig := cloneHostConfig(manifest.HostConfig)
	applyDefaultWorkloadLogConfig(hostConfig, c.defaultWorkloadLogDriver())
	resp, err := c.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: config, HostConfig: hostConfig, NetworkingConfig: manifest.NetworkingConfig, Name: manifest.Name,
	})
	if err != nil {
		return "", fmt.Errorf("create stopped migration container: %w", err)
	}
	return resp.ID, nil
}

// validateStoppedCreateNetworks keeps a stopped create (a migration target or
// an archive import) to the networks a user container may join: never the
// host's or another container's namespace or the Secure Links management
// network. Managed database networks stay allowed, as for
// validateUserWorkloadNetworkMode.
func validateStoppedCreateNetworks(host *container.HostConfig, networking *network.NetworkingConfig) error {
	if err := validateUserWorkloadNetworkMode(string(host.NetworkMode)); err != nil {
		return err
	}
	if networking == nil {
		return nil
	}
	for name := range networking.EndpointsConfig {
		if err := validateUserWorkloadNetworkMode(name); err != nil {
			return err
		}
	}
	return nil
}

func applyMigrationCreateImage(config *container.Config, manifest dockerMigrationManifest) error {
	if config == nil || !dockerSHA256Digest.MatchString(manifest.ImageID) {
		return fmt.Errorf("migration manifest has no verified image digest")
	}
	config.Image = manifest.ImageID
	if original := strings.TrimSpace(manifest.ImageReference); original != "" && original != manifest.ImageID {
		if config.Labels == nil {
			config.Labels = map[string]string{}
		}
		config.Labels[archiveImageReferenceLabel] = original
	}
	return nil
}

func cloneContainerConfig(source *container.Config) *container.Config {
	data, _ := json.Marshal(source)
	var target container.Config
	_ = json.Unmarshal(data, &target)
	return &target
}

func cloneHostConfig(source *container.HostConfig) *container.HostConfig {
	data, _ := json.Marshal(source)
	var target container.HostConfig
	_ = json.Unmarshal(data, &target)
	return &target
}

func hasComposeLabels(labels map[string]string) bool {
	for key := range labels {
		if strings.HasPrefix(key, "com.docker.compose.") {
			return true
		}
	}
	return false
}

func hostNamespaceMode(value string) bool {
	return value == "host" || strings.HasPrefix(value, "container:")
}

func compactStrings(values []string) []string {
	if len(values) < 2 {
		return values
	}
	result := values[:1]
	for _, value := range values[1:] {
		if value != result[len(result)-1] {
			result = append(result, value)
		}
	}
	return result
}

func cloneStringMap(source map[string]string) map[string]string {
	if source == nil {
		return nil
	}
	target := make(map[string]string, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

// legacyCreateFields are the create fields Docker Engine 20.10 to 28 still
// reports in a container inspect and the API types of this daemon no longer
// have, with what a set value means. Engine 20.10 reports both kernel memory
// fields on every container, as 0; later engines report all three only when
// they are set. A zero value configures nothing. A set value is a setting the
// target container cannot be created with, so it blocks the migration.
var legacyCreateFields = map[string]map[string]string{
	"Config": {
		"MacAddress": "the container has a fixed MAC address, which the migrated container cannot keep; remove it before migrating",
	},
	"HostConfig": {
		"KernelMemory":    "the container has a kernel memory limit, which the migrated container cannot keep; remove it before migrating",
		"KernelMemoryTCP": "the container has a kernel TCP memory limit, which the migrated container cannot keep; remove it before migrating",
	},
}

// unsupportedCreateFields compares the create configuration of a raw container
// inspect with the API types the target container is created from, and
// returns a blocker for every field those types do not have, except a legacy
// field at its zero value.
func unsupportedCreateFields(raw []byte, configType, hostConfigType reflect.Type) []string {
	var inspect map[string]json.RawMessage
	if err := json.Unmarshal(raw, &inspect); err != nil {
		return []string{fmt.Sprintf("decode raw container inspect: %v", err)}
	}
	checks := []struct {
		name string
		typ  reflect.Type
	}{{"Config", configType}, {"HostConfig", hostConfigType}}
	var blockers []string
	for _, check := range checks {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(inspect[check.name], &object); err != nil {
			blockers = append(blockers, fmt.Sprintf("decode raw %s: %v", check.name, err))
			continue
		}
		known := jsonFieldNames(check.typ)
		keys := make([]string, 0, len(object))
		for key := range object {
			if !known[key] {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			reason, legacy := legacyCreateFields[check.name][key]
			switch {
			case !legacy:
				blockers = append(blockers, fmt.Sprintf("unknown Docker create field %s.%s", check.name, key))
			case !zeroJSONValue(object[key]):
				blockers = append(blockers, fmt.Sprintf("unsupported Docker create field %s.%s: %s", check.name, key, reason))
			}
		}
	}
	return blockers
}

// zeroJSONValue reports whether a raw JSON value is null or the zero value of
// its type.
func zeroJSONValue(raw json.RawMessage) bool {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	switch typed := value.(type) {
	case nil:
		return true
	case bool:
		return !typed
	case float64:
		return typed == 0
	case string:
		return typed == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	}
	return false
}

func jsonFieldNames(typ reflect.Type) map[string]bool {
	result := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if field.Anonymous {
			for name := range jsonFieldNames(field.Type) {
				result[name] = true
			}
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		result[name] = true
	}
	return result
}
