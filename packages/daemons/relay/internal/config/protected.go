package config

import (
	"bytes"
	"fmt"
	"os"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"gopkg.in/yaml.v3"
)

// SetProtected writes protected.enabled and protected.allow_database_witness
// into the config file at path, keeping every other setting, the comments,
// and the file's owner and mode. The relay supervisor reads it on its next
// start.
func SetProtected(path string, enabled, allowDatabaseWitness bool) error {
	return rewriteConfig(path, func(root *yaml.Node) {
		section := mappingValue(root, "protected")
		if section.Kind != yaml.MappingNode {
			*section = yaml.Node{Kind: yaml.MappingNode}
		}
		setBool(section, "enabled", enabled)
		setBool(section, "allow_database_witness", allowDatabaseWitness)
	})
}

// rewriteConfig applies edit to the top-level mapping of the config file at
// path and writes it back, keeping every other setting, the comments, and the
// file's owner and mode.
func rewriteConfig(path string, edit func(root *yaml.Node)) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("config %s is not a regular file", path)
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(encoded, &document); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	if document.Kind == 0 {
		document = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("config %s is not a YAML mapping", path)
	}
	edit(document.Content[0])
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := encoder.Close(); err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	// The result must still load as a relay supervisor config.
	check := &Config{}
	if err := yaml.Unmarshal(out.Bytes(), check); err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := atomicfile.WriteFile(path, out.Bytes(), info.Mode().Perm()); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		// A root edit of a config that a non-root supervisor reads keeps it readable.
		if err := os.Chown(path, int(stat.Uid), int(stat.Gid)); err != nil {
			return fmt.Errorf("restore config owner: %w", err)
		}
	}
	return nil
}

// mappingValue returns the value node of key in mapping, adding the key when
// it is missing.
func mappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			return mapping.Content[index+1]
		}
	}
	value := &yaml.Node{Kind: yaml.MappingNode}
	mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
	return value
}

func setBool(mapping *yaml.Node, key string, value bool) {
	node := mappingValue(mapping, key)
	text := "false"
	if value {
		text = "true"
	}
	*node = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: text, LineComment: node.LineComment, HeadComment: node.HeadComment}
}
