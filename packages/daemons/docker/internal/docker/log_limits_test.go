package docker

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
	"gopkg.in/yaml.v3"
)

func TestHostDefaultLogOptionsCountsOnlyAMaxSize(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]bool{
		`{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"3"}}`: true,
		`{"log-opts":{"tag":"{{.Name}}"}}`:                                        false,
		`{"log-opts":{"max-file":"5"}}`:                                           false,
		`{"log-opts":{"max-size":""}}`:                                            false,
		`{}`:                                                                      false,
	}
	for content, want := range cases {
		path := filepath.Join(dir, "daemon.json")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := hostDefaultLogOptions(path)
		if err != nil || got != want {
			t.Fatalf("%s: got %v err %v, want %v", content, got, err, want)
		}
	}
	if got, _ := hostDefaultLogOptions(filepath.Join(dir, "missing.json")); got {
		t.Fatal("a missing daemon.json bounds nothing")
	}
	broken := filepath.Join(dir, "broken.json")
	if err := os.WriteFile(broken, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := hostDefaultLogOptions(broken); got || err == nil {
		t.Fatalf("an unreadable daemon.json must not count as bounded: %v %v", got, err)
	}
}

func TestInternalContainerLogConfigIsBounded(t *testing.T) {
	cfg := internalContainerLogConfig()
	if cfg.Type != "json-file" || cfg.Config["max-size"] != "10m" || cfg.Config["max-file"] != "3" {
		t.Fatalf("%+v", cfg)
	}
	if unboundedJSONFileLog(cfg) {
		t.Fatal("internal containers must not count as unbounded")
	}
}

func TestUnboundedJSONFileLog(t *testing.T) {
	if !unboundedJSONFileLog(container.LogConfig{Type: "json-file"}) {
		t.Fatal("json-file without options never rotates")
	}
	if !unboundedJSONFileLog(container.LogConfig{Type: "json-file", Config: map[string]string{"max-file": "3"}}) {
		t.Fatal("max-file alone does not rotate")
	}
	for _, cfg := range []container.LogConfig{
		{Type: "json-file", Config: map[string]string{"max-size": "50m"}},
		{Type: "local"},
		{Type: "journald"},
		{Type: "none"},
	} {
		if unboundedJSONFileLog(cfg) {
			t.Fatalf("%+v counted as unbounded", cfg)
		}
	}
}

func TestCutContainerLogKeepsTheNewestWholeLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "abc-json.log")
	line := []byte(`{"log":"request served\n","stream":"stdout","time":"2026-10-16T10:00:00Z"}` + "\n")
	if err := os.WriteFile(path, bytes.Repeat(line, 200), 0o640); err != nil {
		t.Fatal(err)
	}
	size := int64(len(line) * 200)

	if freed, err := cutContainerLog(path, size, 1000); err != nil || freed != 0 {
		t.Fatalf("a log within the cap was cut: %d %v", freed, err)
	}
	freed, err := cutContainerLog(path, 1000, 1000)
	if err != nil {
		t.Fatal(err)
	}
	kept, _ := os.ReadFile(path)
	if len(kept) == 0 || len(kept) > 1000 || !strings.HasPrefix(string(kept), `{"log"`) || !strings.HasSuffix(string(kept), "}\n") {
		t.Fatalf("kept %q", kept)
	}
	if freed != size-int64(len(kept)) {
		t.Fatalf("freed %d", freed)
	}
	if freed, err := cutContainerLog(filepath.Join(t.TempDir(), "gone-json.log"), 1, 1); err != nil || freed != 0 {
		t.Fatalf("a missing log: %d %v", freed, err)
	}
}

func TestInjectComposeLogLimitsBoundsJSONFileLoggingWithoutMaxSize(t *testing.T) {
	input := []byte(`services:
  plain:
    image: nginx
  counted:
    image: nginx
    logging:
      driver: json-file
      options:
        max-file: "5"
  defaulted:
    image: nginx
    logging:
      options:
        compress: "true"
  sized:
    image: nginx
    logging:
      driver: json-file
      options:
        max-size: 10m
  local:
    image: nginx
    logging:
      driver: local
`)
	output, err := injectComposeLogLimits(input)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Services map[string]struct {
			Logging *struct {
				Driver  string            `yaml:"driver"`
				Options map[string]string `yaml:"options"`
			} `yaml:"logging"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(output, &document); err != nil {
		t.Fatal(err)
	}
	expect := map[string]map[string]string{
		"plain":     {"max-size": "50m", "max-file": "3"},
		"counted":   {"max-size": "50m", "max-file": "5"},
		"defaulted": {"max-size": "50m", "compress": "true"},
		"sized":     {"max-size": "10m"},
	}
	for name, want := range expect {
		got := document.Services[name].Logging
		if got == nil {
			t.Fatalf("%s: no logging", name)
		}
		for key, value := range want {
			if got.Options[key] != value {
				t.Fatalf("%s: %s = %q, want %q (%v)", name, key, got.Options[key], value, got.Options)
			}
		}
		if len(got.Options) != len(want) {
			t.Fatalf("%s: options %v, want %v", name, got.Options, want)
		}
	}
	if local := document.Services["local"].Logging; local == nil || local.Driver != "local" || len(local.Options) != 0 {
		t.Fatalf("local driver changed: %+v", local)
	}
}
