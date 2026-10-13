package docker

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

var composeServiceFields = map[string]bool{
	"image": true, "environment": true, "command": true, "entrypoint": true, "working_dir": true, "user": true,
	"hostname": true, "ports": true, "healthcheck": true, "depends_on": true, "restart": true, "volumes": true,
	"networks": true, "extra_hosts": true, "labels": true, "cpus": true, "cpu_shares": true, "mem_limit": true,
	"mem_reservation": true, "memswap_limit": true, "pids_limit": true, "logging": true,
}

// Services may choose their own log rotation, but only with drivers that keep
// the files on the node, so a Compose project cannot ship logs elsewhere.
var composeLoggingDrivers = map[string]bool{"json-file": true, "local": true, "none": true}

var composeLoggingOptions = map[string]bool{"max-size": true, "max-file": true, "compress": true}

var composeByteValuePattern = regexp.MustCompile(`(?i)^\d+(?:\.\d+)?(?:[kmgtpe]i?b?|b)?$`)

var composeDependsOnConditions = map[string]bool{
	"service_started": true, "service_healthy": true, "service_completed_successfully": true,
}

// composeActionStartsContainers reports the actions that create or start a
// project's containers. Only they apply the rules that keep a project off the
// host's and Gateway's networks and labels and its bindings off the compose
// client's settings (reservedPolicy): a project saved before those rules can
// still be stopped and brought down, which joins and labels nothing, and the
// sidecar's own environment is set last for every action.
func composeActionStartsContainers(action string) bool {
	switch action {
	case "apply", "pull_apply", composeActionPullCreate, "start", "restart":
		return true
	default:
		return false
	}
}

func validateAndInjectComposeYAML(request *composeRequest) error {
	reservedPolicy := composeActionStartsContainers(request.action)
	serviceDigests, err := composeServiceConfigDigests(request.normalizedModelJSON)
	if err != nil {
		return err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(request.composeYAML, &document); err != nil {
		return errors.New("compose_yaml is invalid")
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return errors.New("compose_yaml must contain one mapping document")
	}
	root := document.Content[0]
	topLevel := mappingValues(root)
	for key := range topLevel {
		switch key {
		case "name", "services", "volumes", "networks", "version":
		default:
			return fmt.Errorf("compose feature %q is not supported", key)
		}
	}
	if name := topLevel["name"]; name != nil {
		if name.Kind != yaml.ScalarNode || name.Value != request.projectName {
			return errors.New("compose document name must match project_name")
		}
	}
	services, ok := topLevel["services"]
	if !ok || services.Kind != yaml.MappingNode || len(services.Content) == 0 {
		return errors.New("compose services are required")
	}
	volumes := topLevel["volumes"]
	networks := topLevel["networks"]
	if volumes != nil && volumes.Kind != yaml.MappingNode {
		return errors.New("compose volumes must be a mapping")
	}
	if networks != nil && networks.Kind != yaml.MappingNode {
		return errors.New("compose networks must be a mapping")
	}
	if err := validateTopLevelResources(volumes, "volume", reservedPolicy); err != nil {
		return err
	}
	if err := validateTopLevelResources(networks, "network", reservedPolicy); err != nil {
		return err
	}
	if reservedPolicy {
		if err := validateComposeNetworkNames(networks); err != nil {
			return err
		}
	}
	for i := 0; i < len(services.Content); i += 2 {
		if err := validateComposeService(services.Content[i].Value, services.Content[i+1], services, volumes, networks, reservedPolicy); err != nil {
			return err
		}
		digest := request.configDigest
		if serviceDigest := serviceDigests[services.Content[i].Value]; serviceDigest != "" {
			digest = serviceDigest
		}
		injectComposeLabels(services.Content[i+1], request.projectID, digest)
	}
	output, err := yaml.Marshal(&document)
	if err != nil {
		return errors.New("normalize compose_yaml")
	}
	request.composeYAML = output
	return nil
}

func validateComposeService(name string, service, services, volumes, networks *yaml.Node, reservedPolicy bool) error {
	if name == "" || service.Kind != yaml.MappingNode {
		return errors.New("compose service definition is invalid")
	}
	values := mappingValues(service)
	image := values["image"]
	if image == nil || image.Kind != yaml.ScalarNode || strings.TrimSpace(image.Value) == "" {
		return errors.New("every compose service requires image")
	}
	for key := range values {
		if !composeServiceFields[key] {
			return fmt.Errorf("compose service feature %q is not supported", key)
		}
	}
	if err := validateServiceLabels(values["labels"], reservedPolicy); err != nil {
		return err
	}
	if err := validateServiceVolumes(name, values["volumes"], volumes); err != nil {
		return err
	}
	if err := validateServiceNetworks(name, values["networks"], networks); err != nil {
		return err
	}
	if err := validateServiceDependsOn(name, values["depends_on"], services); err != nil {
		return err
	}
	if err := validateNonNegativeFloat(values["cpus"], "cpus"); err != nil {
		return err
	}
	if err := validateNonNegativeInteger(values["cpu_shares"], "cpu_shares"); err != nil {
		return err
	}
	if err := validateByteValue(values["mem_limit"], "mem_limit"); err != nil {
		return err
	}
	if err := validateByteValue(values["mem_reservation"], "mem_reservation"); err != nil {
		return err
	}
	if err := validateByteValue(values["memswap_limit"], "memswap_limit", true); err != nil {
		return err
	}
	if err := validatePidsLimit(values["pids_limit"], "pids_limit"); err != nil {
		return err
	}
	return validateServiceLogging(values["logging"])
}

func validateServiceLogging(node *yaml.Node) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return errors.New("compose service logging must be a mapping")
	}
	values := mappingValues(node)
	for key := range values {
		if key != "driver" && key != "options" {
			return fmt.Errorf("compose service logging field %q is not supported", key)
		}
	}
	driver := jsonFileLogDriver
	if value := values["driver"]; value != nil {
		if value.Kind != yaml.ScalarNode || !composeLoggingDrivers[value.Value] {
			return errors.New("compose service logging driver must be json-file, local or none")
		}
		driver = value.Value
	}
	options := values["options"]
	if options == nil {
		return nil
	}
	if options.Kind != yaml.MappingNode {
		return errors.New("compose service logging options must be a mapping")
	}
	if driver == "none" && len(options.Content) > 0 {
		return errors.New("compose service logging driver none takes no options")
	}
	for key, value := range mappingValues(options) {
		if !composeLoggingOptions[key] {
			return fmt.Errorf("compose service logging option %q is not supported", key)
		}
		if value.Kind != yaml.ScalarNode {
			return fmt.Errorf("compose service logging option %s must be a scalar", key)
		}
		switch key {
		case "max-size":
			if err := validateByteValue(value, "logging max-size"); err != nil {
				return err
			}
		case "max-file":
			if count, err := strconv.Atoi(strings.TrimSpace(value.Value)); err != nil || count < 1 {
				return errors.New("compose service logging max-file must be a positive integer")
			}
		case "compress":
			if !strings.EqualFold(value.Value, "true") && !strings.EqualFold(value.Value, "false") {
				return errors.New("compose service logging compress must be true or false")
			}
		}
	}
	return nil
}

// injectComposeLogLimits gives every service without its own logging the
// rotation single workloads get (json-file, 50m x 3). Callers use it only
// when the host's default driver is plain json-file.
func injectComposeLogLimits(composeYAML []byte) ([]byte, error) {
	var document yaml.Node
	if err := yaml.Unmarshal(composeYAML, &document); err != nil || len(document.Content) != 1 {
		return nil, errors.New("compose_yaml is invalid")
	}
	services := mappingValues(document.Content[0])["services"]
	if services == nil || services.Kind != yaml.MappingNode {
		return composeYAML, nil
	}
	for i := 1; i < len(services.Content); i += 2 {
		service := services.Content[i]
		if mappingValues(service)["logging"] != nil {
			continue
		}
		service.Content = append(service.Content, composeScalar("logging"), composeMapping(
			composeScalar("driver"), composeScalar(jsonFileLogDriver),
			composeScalar("options"), composeMapping(
				composeScalar("max-size"), composeScalar(workloadLogMaxSize),
				composeScalar("max-file"), composeScalar(workloadLogMaxFile),
			),
		))
	}
	output, err := yaml.Marshal(&document)
	if err != nil {
		return nil, errors.New("normalize compose_yaml")
	}
	return output, nil
}

func composeScalar(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

func composeMapping(content ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: content}
}

func validateNonNegativeFloat(node *yaml.Node, field string) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.ScalarNode {
		return fmt.Errorf("compose service %s must be a non-negative number", field)
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(node.Value), 64)
	if err != nil || value < 0 {
		return fmt.Errorf("compose service %s must be a non-negative number", field)
	}
	return nil
}

func validateNonNegativeInteger(node *yaml.Node, field string) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.ScalarNode {
		return fmt.Errorf("compose service %s must be a non-negative integer", field)
	}
	value, err := strconv.ParseInt(strings.TrimSpace(node.Value), 10, 64)
	if err != nil || value < 0 {
		return fmt.Errorf("compose service %s must be a non-negative integer", field)
	}
	return nil
}

func validatePidsLimit(node *yaml.Node, field string) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.ScalarNode {
		return fmt.Errorf("compose service %s must be -1 or a positive integer", field)
	}
	value, err := strconv.ParseInt(strings.TrimSpace(node.Value), 10, 64)
	if err != nil || value == 0 || value < -1 {
		return fmt.Errorf("compose service %s must be -1 or a positive integer", field)
	}
	return nil
}

func validateByteValue(node *yaml.Node, field string, allowUnlimited ...bool) error {
	if node == nil {
		return nil
	}
	if len(allowUnlimited) > 0 && allowUnlimited[0] && strings.TrimSpace(node.Value) == "-1" {
		return nil
	}
	if node.Kind != yaml.ScalarNode || !composeByteValuePattern.MatchString(strings.TrimSpace(node.Value)) {
		return fmt.Errorf("compose service %s must be a byte value", field)
	}
	return nil
}

func validateTopLevelResources(node *yaml.Node, resource string, reservedPolicy bool) error {
	if node == nil {
		return nil
	}
	for i := 0; i < len(node.Content); i += 2 {
		definition := node.Content[i+1]
		if definition.Kind == yaml.ScalarNode && definition.Tag == "!!null" {
			continue
		}
		if definition.Kind != yaml.MappingNode {
			return fmt.Errorf("compose %s definition is invalid", resource)
		}
		for key, value := range mappingValues(definition) {
			if key != "external" && key != "name" && key != "driver" && key != "labels" {
				return fmt.Errorf("compose %s feature %q is not supported", resource, key)
			}
			// Match the backend YAML core schema: True/TRUE are booleans, quoted "true" is a string.
			if key == "external" && !isComposeBool(value) {
				return fmt.Errorf("compose %s external must be boolean", resource)
			}
			if (key == "name" || key == "driver") && !isComposeString(value) {
				return fmt.Errorf("compose %s %s must be a string", resource, key)
			}
			if key == "labels" {
				if err := validateServiceLabels(value, reservedPolicy); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// composeManagedDatabaseNetworkKey is the logical network the backend adds to
// a project for a managed database link (compose-managed-bindings.ts
// networkKey): it names the link's gateway-db-* network as external.
var composeManagedDatabaseNetworkKey = regexp.MustCompile(`^gateway_db_[0-9a-f]{16}$`)

// composeContainerLinkNetworkKey is the logical network the backend adds to a project for a container link whose
// source is one of its services: it names the link's gateway-link-* network as external.
var composeContainerLinkNetworkKey = regexp.MustCompile(`^gateway_link_[0-9a-f]{16}$`)

// validateComposeNetworkNames keeps Compose networks off the host's network
// namespaces and off the networks Gateway owns on the node, which a user
// container may not join either (validateUserWorkloadNetworkMode, the
// backend's isReservedOpfieldNetworkName). Docker Compose joins an existing
// network by its name, external or not, so the name decides: name: when
// set, else the key of an external network. A name with a variable could
// resolve to anything and is refused like a host path with one. The managed
// database link network the backend adds is the one exception.
func validateComposeNetworkNames(networks *yaml.Node) error {
	if networks == nil {
		return nil
	}
	for i := 0; i+1 < len(networks.Content); i += 2 {
		key, values := networks.Content[i].Value, mappingValues(networks.Content[i+1])
		external := isComposeBool(values["external"]) && strings.EqualFold(values["external"].Value, "true")
		name := ""
		if values["name"] != nil {
			name = values["name"].Value
		} else if external {
			name = key
		}
		if strings.Contains(name, "$") {
			return fmt.Errorf("compose network %q name must not use variables", key)
		}
		if name != "host" && name != "none" && !isReservedOpfieldNetworkName(name) {
			continue
		}
		if external && composeManagedDatabaseNetworkKey.MatchString(key) && strings.HasPrefix(name, "gateway-db-") {
			continue
		}
		if external && composeContainerLinkNetworkKey.MatchString(key) && containerLinkNetworkPattern.MatchString(name) {
			continue
		}
		return fmt.Errorf("compose network %q uses reserved network name %q", key, name)
	}
	return nil
}

// isReservedOpfieldNetworkName mirrors the backend's isReservedOpfieldNetworkName:
// every name Gateway owns or will own on a node, the Secure Links management
// network and managed database and storage link networks.
func isReservedOpfieldNetworkName(name string) bool {
	return name == secureLinkManagementNetwork || strings.HasPrefix(name, "gateway-db-") || strings.HasPrefix(name, "gateway-storage-") ||
		strings.HasPrefix(name, "gateway-link-")
}

// validateServiceVolumes mirrors the backend Compose policy: only declared named
// volumes, as SOURCE:TARGET[:ro|rw] strings or long-syntax type: volume mappings.
// The shared cases in testdata/compose-policy-parity.yaml keep the two in step.
func validateServiceVolumes(service string, node, topLevel *yaml.Node) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.SequenceNode {
		return fmt.Errorf("compose service %q volumes must be a list", service)
	}
	known := mappingValues(topLevel)
	for index, entry := range node.Content {
		var err error
		switch {
		case entry.Kind == yaml.ScalarNode && entry.Tag == "!!str":
			err = validateShortServiceVolume(service, index, entry.Value, known)
		case entry.Kind == yaml.MappingNode:
			err = validateLongServiceVolume(service, index, entry, known)
		default:
			err = fmt.Errorf("compose service %q volume %d must be a named-volume string or mapping", service, index)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func validateShortServiceVolume(service string, index int, value string, known map[string]*yaml.Node) error {
	parts := strings.Split(value, ":")
	if len(parts) < 2 || len(parts) > 3 || parts[0] == "" || parts[1] == "" {
		return fmt.Errorf("compose service %q volume %d: host bind mounts and unnamed volumes are not supported", service, index)
	}
	source, target := parts[0], parts[1]
	if isComposeHostPath(source) {
		return fmt.Errorf("compose service %q volume %d: host bind mounts and unnamed volumes are not supported", service, index)
	}
	// Compose rejects an empty mode section ("data:/data:"), so only ro or rw may follow the target.
	if !strings.HasPrefix(target, "/") || (len(parts) == 3 && parts[2] != "ro" && parts[2] != "rw") {
		return fmt.Errorf("compose service %q volume %d target must be an absolute container path and mode must be ro or rw", service, index)
	}
	if known[source] == nil {
		return fmt.Errorf("compose service %q volume %d uses undeclared named volume %q", service, index, source)
	}
	return nil
}

func validateLongServiceVolume(service string, index int, entry *yaml.Node, known map[string]*yaml.Node) error {
	for i := 0; i+1 < len(entry.Content); i += 2 {
		switch key := entry.Content[i].Value; key {
		case "type", "source", "target", "read_only":
		default:
			return fmt.Errorf("compose service %q volume %d: long-syntax volume feature %q is not supported", service, index, key)
		}
	}
	values := mappingValues(entry)
	// The Compose specification requires type on every long-syntax mount, and
	// docker compose rejects the entry without it.
	volumeType := values["type"]
	if volumeType == nil {
		return fmt.Errorf("compose service %q volume %d uses long syntax without type; add type: volume", service, index)
	}
	if !isComposeString(volumeType) || volumeType.Value != "volume" {
		return fmt.Errorf("compose service %q volume %d: host bind mounts and unnamed volumes are not supported; only type: volume is allowed", service, index)
	}
	source := values["source"]
	if source == nil || !isComposeString(source) || source.Value == "" {
		return fmt.Errorf("compose service %q volume %d: named volumes require a string source", service, index)
	}
	if isComposeHostPath(source.Value) {
		return fmt.Errorf("compose service %q volume %d: host bind mounts and unnamed volumes are not supported", service, index)
	}
	if target := values["target"]; target == nil || !isComposeString(target) || !strings.HasPrefix(target.Value, "/") {
		return fmt.Errorf("compose service %q volume %d target must be an absolute container path", service, index)
	}
	if readOnly := values["read_only"]; readOnly != nil && !isComposeBool(readOnly) {
		return fmt.Errorf("compose service %q volume %d read_only must be a boolean", service, index)
	}
	if known[source.Value] == nil {
		return fmt.Errorf("compose service %q volume %d uses undeclared named volume %q", service, index, source.Value)
	}
	return nil
}

func validateServiceNetworks(service string, node, topLevel *yaml.Node) error {
	if node == nil {
		return nil
	}
	known := mappingValues(topLevel)
	// Compose always provides the project default network, so it needs no top-level declaration.
	declared := func(name string) bool { return name == "default" || known[name] != nil }
	if node.Kind == yaml.SequenceNode {
		for _, entry := range node.Content {
			if !isComposeString(entry) {
				return fmt.Errorf("compose service %q networks are invalid", service)
			}
			if !declared(entry.Value) {
				return fmt.Errorf("compose service %q network %q is not declared", service, entry.Value)
			}
		}
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("compose service %q networks are invalid", service)
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		name, definition := node.Content[i].Value, node.Content[i+1]
		if !declared(name) {
			return fmt.Errorf("compose service %q network %q is not declared", service, name)
		}
		if isComposeNull(definition) {
			continue
		}
		if definition.Kind != yaml.MappingNode {
			return fmt.Errorf("compose service %q network %q is invalid", service, name)
		}
		for j := 0; j+1 < len(definition.Content); j += 2 {
			if definition.Content[j].Value != "aliases" {
				return fmt.Errorf("compose service %q network %q only supports aliases", service, name)
			}
		}
	}
	return nil
}

// validateServiceDependsOn accepts a list of service names or a long-syntax
// mapping whose entries name a Compose condition, as docker compose requires.
func validateServiceDependsOn(service string, node, services *yaml.Node) error {
	if node == nil {
		return nil
	}
	defined := mappingValues(services)
	switch node.Kind {
	case yaml.SequenceNode:
		for _, entry := range node.Content {
			if !isComposeString(entry) {
				return fmt.Errorf("compose service %q depends_on must be a service list or mapping", service)
			}
			if defined[entry.Value] == nil {
				return fmt.Errorf("compose service %q depends on undefined service %q", service, entry.Value)
			}
		}
		return nil
	case yaml.MappingNode:
		for i := 0; i+1 < len(node.Content); i += 2 {
			dependency, definition := node.Content[i].Value, node.Content[i+1]
			if definition.Kind != yaml.MappingNode {
				return fmt.Errorf("compose service %q depends_on %q must be a mapping with condition", service, dependency)
			}
			for j := 0; j+1 < len(definition.Content); j += 2 {
				if key := definition.Content[j].Value; key != "condition" {
					return fmt.Errorf("compose service %q depends_on %q feature %q is not supported", service, dependency, key)
				}
			}
			condition := mappingValues(definition)["condition"]
			if condition == nil {
				return fmt.Errorf("compose service %q depends_on %q requires condition", service, dependency)
			}
			if !isComposeString(condition) || !composeDependsOnConditions[condition.Value] {
				return fmt.Errorf("compose service %q depends_on %q condition must be service_started, service_healthy, or service_completed_successfully", service, dependency)
			}
			if defined[dependency] == nil {
				return fmt.Errorf("compose service %q depends on undefined service %q", service, dependency)
			}
		}
		return nil
	default:
		return fmt.Errorf("compose service %q depends_on must be a service list or mapping", service)
	}
}

func isComposeHostPath(source string) bool {
	return strings.HasPrefix(source, "/") || strings.HasPrefix(source, ".") || strings.HasPrefix(source, "~") || strings.ContainsAny(source, `\$`)
}

func isComposeString(node *yaml.Node) bool {
	return node != nil && node.Kind == yaml.ScalarNode && node.Tag == "!!str"
}

func isComposeBool(node *yaml.Node) bool {
	return node != nil && node.Kind == yaml.ScalarNode && node.Tag == "!!bool"
}

func isComposeNull(node *yaml.Node) bool {
	return node != nil && node.Kind == yaml.ScalarNode && node.Tag == "!!null"
}

// validateServiceLabels refuses the labels Gateway and Docker Compose read. With
// reservedPolicy (actions that create or start containers) that is the full
// reserved set and keys built from variables; otherwise only Compose's
// ownership labels, as before the full set existed.
func validateServiceLabels(node *yaml.Node, reservedPolicy bool) error {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.SequenceNode {
		content := make([]*yaml.Node, 0, len(node.Content)*2)
		for _, entry := range node.Content {
			if entry.Kind != yaml.ScalarNode || !strings.Contains(entry.Value, "=") {
				return errors.New("compose labels must be a mapping or KEY=value list")
			}
			parts := strings.SplitN(entry.Value, "=", 2)
			content = append(content,
				&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: parts[0]},
				&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: parts[1]},
			)
		}
		node.Kind = yaml.MappingNode
		node.Tag = "!!map"
		node.Content = content
	}
	if node.Kind != yaml.MappingNode {
		return errors.New("compose labels must be a mapping or KEY=value list")
	}
	for key := range mappingValues(node) {
		if !reservedPolicy {
			if strings.HasPrefix(key, "com.docker.compose.") || strings.HasPrefix(key, "net.opfield.compose.") ||
				// legacy-name: wiolett.gateway.compose.* labels of pre-Opfield Compose projects — remove once every node reports none
				strings.HasPrefix(key, "wiolett.gateway.compose.") {
				return fmt.Errorf("compose label %q is reserved by Docker Compose or Opfield", key)
			}
			continue
		}
		// Compose interpolates a KEY=value list entry, so a variable could spell a reserved key.
		if strings.Contains(key, "$") {
			return fmt.Errorf("compose label %q cannot use variables in its key", key)
		}
		if isReservedDockerLabel(key) {
			return fmt.Errorf("compose label %q is reserved by Docker Compose or Opfield", key)
		}
	}
	return nil
}

// composeServiceConfigDigests reads the configuration digest of each service that Gateway sends with the
// normalized model (`serviceConfigDigests`). A service is labelled with its own digest, so a new revision changes
// the label, and with it Compose's config hash, only of the services it changes: Compose recreates those and leaves
// the others running. Without them (an older Gateway, Availability placements) every service carries the revision
// digest, and every new revision recreates every service.
func composeServiceConfigDigests(normalizedModelJSON string) (map[string]string, error) {
	var model struct {
		ServiceConfigDigests map[string]string `json:"serviceConfigDigests"`
	}
	if err := json.Unmarshal([]byte(normalizedModelJSON), &model); err != nil {
		return nil, errors.New("docker compose normalized_model_json is invalid")
	}
	for service, digest := range model.ServiceConfigDigests {
		if !composeDigestPattern.MatchString(digest) {
			return nil, fmt.Errorf("docker compose service %q has an invalid configuration digest", service)
		}
	}
	return model.ServiceConfigDigests, nil
}

func injectComposeLabels(service *yaml.Node, projectID, digest string) {
	values := mappingValues(service)
	labels := values["labels"]
	if labels == nil {
		service.Content = append(service.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "labels"}, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"})
		labels = service.Content[len(service.Content)-1]
	}
	labels.Content = append(labels.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "net.opfield.compose.managed"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "true"},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "net.opfield.compose.project-id"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: projectID},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "net.opfield.compose.revision"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: digest},
	)
}

func mappingValues(node *yaml.Node) map[string]*yaml.Node {
	values := make(map[string]*yaml.Node)
	if node == nil || node.Kind != yaml.MappingNode {
		return values
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		values[node.Content[i].Value] = node.Content[i+1]
	}
	return values
}
