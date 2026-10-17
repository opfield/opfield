package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// installConfigTemplate is the configuration `install` writes on a host without one.
const installConfigTemplate = `opfield:
  address: "%s"
  token: "%s"
  cert_sha256: "%s"

tls:
  ca_cert: "/etc/nginx-daemon/certs/ca.pem"
  client_cert: "/etc/nginx-daemon/certs/node.pem"
  client_key: "/etc/nginx-daemon/certs/node-key.pem"

nginx:
  config_dir: "%s"
  certs_dir: "/etc/nginx/certs"
  logs_dir: "/var/log/nginx"
  global_config: "/etc/nginx/nginx.conf"
  binary: "/usr/sbin/nginx"
  stub_status_url: "http://127.0.0.1/nginx_status"
  htpasswd_dir: "/etc/nginx/opfield/htpasswd"
  acme_challenge_dir: "/var/www/acme-challenge"

state_dir: "/var/lib/nginx-daemon"
log_level: "info"
log_format: "json"
`

// writeInstallConfig writes the configuration `install` enrolls with. An existing configuration (written by the
// operator first, as the manual setup describes) is kept: only its Opfield address, token and certificate fingerprint
// are set, in the control section the file has (opfield:, else the pre-Opfield one). kept reports that case.
func writeInstallConfig(path, address, token, certSHA256 string) (kept bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		content := fmt.Sprintf(installConfigTemplate, address, token, certSHA256, defaultNginxConfigDir())
		return false, os.WriteFile(path, []byte(content), 0o600)
	}
	if err != nil {
		return false, err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return false, fmt.Errorf("parse %s: %w", path, err)
	}
	if document.Kind == 0 {
		document = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return false, fmt.Errorf("%s is not a YAML mapping", path)
	}
	sectionKey := "opfield"
	// legacy-name: gateway: section of configs written before 2.12.1 — remove once every node reports none
	if !hasKey(document.Content[0], "opfield") && hasKey(document.Content[0], "gateway") {
		sectionKey = "gateway"
	}
	section := mappingValue(document.Content[0], sectionKey)
	if section.Kind != yaml.MappingNode {
		return false, fmt.Errorf("%s in %s is not a mapping", sectionKey, path)
	}
	for _, field := range [][2]string{{"address", address}, {"token", token}, {"cert_sha256", certSHA256}} {
		value := mappingValue(section, field[0])
		value.Kind, value.Tag, value.Value, value.Style, value.Content = yaml.ScalarNode, "!!str", field[1], yaml.DoubleQuotedStyle, nil
	}
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return false, err
	}
	if err := encoder.Close(); err != nil {
		return false, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	return true, os.WriteFile(path, out.Bytes(), info.Mode().Perm())
}

// hasKey reports whether mapping has key.
func hasKey(mapping *yaml.Node, key string) bool {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return true
		}
	}
	return false
}

// mappingValue returns the value of key in mapping, appending the key (with an empty mapping for a control section,
// else an empty scalar) when it is missing.
func mappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	value := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str"}
	if key == "opfield" || key == "gateway" {
		value = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	}
	mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
	return value
}
