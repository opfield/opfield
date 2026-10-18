package leasewatchdog

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/opfield/opfield/daemon-shared/legacycompat"
)

func TestEarlierFeedDefaultsMoveToTheOpfieldFeed(t *testing.T) {
	for value, want := range map[string]string{
		legacycompat.UpdateFeedBase + "/releases":  DefaultReleasesURL,
		legacycompat.UpdateFeedBase + "/releases/": DefaultReleasesURL,
		legacycompat.UpdateFeedBase:                DefaultArtifactBaseURL,
		DefaultReleasesURL:                         DefaultReleasesURL,
		"https://mirror.example/releases":          "https://mirror.example/releases",
	} {
		if got := CurrentFeedURL(value); got != want {
			t.Fatalf("CurrentFeedURL(%q) = %q, want %q", value, got, want)
		}
	}
	legacy := RunArgs("root", legacycompat.UpdateFeedBase+"/releases", legacycompat.UpdateFeedBase, "stable")
	if legacy != RunArgs("root", DefaultReleasesURL, DefaultArtifactBaseURL, "stable") {
		t.Fatalf("RunArgs keeps the earlier feed: %s", legacy)
	}
	inline, changed := argsWithCurrentFeed("run --auto-update --releases-url=" + legacycompat.UpdateFeedBase + "/releases --artifact-base-url https://mirror.example")
	if !changed || inline != "run --auto-update --releases-url="+DefaultReleasesURL+" --artifact-base-url https://mirror.example" {
		t.Fatalf("args %q changed %v", inline, changed)
	}
}

func TestNextTagAsksTheOpfieldFeedForAnEarlierDefault(t *testing.T) {
	client := &http.Client{Transport: fakeTransport{DefaultReleasesURL: `{"target":{"tag_name":"v2.12.6-watchdog"}}`}}
	tag, err := NextTag(context.Background(), client, legacycompat.UpdateFeedBase+"/releases", "stable", "v2.12.5")
	if err != nil || tag != "v2.12.6-watchdog" {
		t.Fatalf("tag %q err %v", tag, err)
	}
}

func TestServiceMovesToTheOpfieldFeed(t *testing.T) {
	legacyArgs := "run --records-owner root --auto-update --releases-url " + legacycompat.UpdateFeedBase + "/releases --artifact-base-url " + legacycompat.UpdateFeedBase + " --channel stable"
	currentArgs := RunArgs("root", DefaultReleasesURL, DefaultArtifactBaseURL, "stable")
	for _, tc := range []struct {
		name   string
		host   ServiceHost
		path   string
		render func(args string) string
	}{
		{"systemd", ServiceHost{Systemd: true}, SystemdUnitPath, func(args string) string { return SystemdUnit(BinaryPath, args) }},
		{"openrc", ServiceHost{OpenRC: true}, OpenRCPath, func(args string) string { return OpenRCScript(BinaryPath, args) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			var commands [][]string
			tc.host.Root = root
			tc.host.Run = func(_ context.Context, name string, args ...string) error {
				commands = append(commands, append([]string{name}, args...))
				return nil
			}
			path := filepath.Join(root, tc.path)
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(tc.render(legacyArgs)), 0o644); err != nil {
				t.Fatal(err)
			}
			moved, err := MoveServiceToCurrentFeed(context.Background(), tc.host)
			if err != nil || !moved {
				t.Fatalf("moved %v err %v", moved, err)
			}
			data, _ := os.ReadFile(path)
			if string(data) != tc.render(currentArgs) {
				t.Fatalf("service:\n%s\nwant:\n%s", data, tc.render(currentArgs))
			}
			if tc.host.Systemd && (len(commands) != 1 || commands[0][1] != "daemon-reload") {
				t.Fatalf("commands %v", commands)
			}
			if moved, err := MoveServiceToCurrentFeed(context.Background(), tc.host); err != nil || moved {
				t.Fatalf("second run moved %v err %v", moved, err)
			}
		})
	}
}
