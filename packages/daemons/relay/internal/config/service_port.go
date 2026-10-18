package config

import (
	"fmt"
	"strconv"

	"gopkg.in/yaml.v3"
)

// SetWorkerServicePort writes worker.service_port into the config file at
// path, keeping every other setting, the comments, and the file's owner and
// mode. It is the port the worker listens on from its next start; a re-run of
// the installer without --service-port keeps it.
func SetWorkerServicePort(path string, port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("worker.service_port must be between 1 and 65535")
	}
	return rewriteConfig(path, func(root *yaml.Node) {
		section := mappingValue(root, "worker")
		if section.Kind != yaml.MappingNode {
			*section = yaml.Node{Kind: yaml.MappingNode}
		}
		node := mappingValue(section, "service_port")
		*node = yaml.Node{
			Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(port),
			LineComment: node.LineComment, HeadComment: node.HeadComment,
		}
	})
}
