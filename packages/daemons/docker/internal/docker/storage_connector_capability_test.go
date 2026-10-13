package docker

import (
	"testing"

	"github.com/opfield/opfield/docker-daemon/internal/config"
)

func TestDockerProfileAdvertisesStorageLinkCapability(t *testing.T) {
	plugin := &DockerPlugin{cfg: &config.Config{}}
	if !containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, managedStorageLinkCapability) {
		t.Fatal("docker profile does not advertise that it hosts managed storage links")
	}
	plugin.cfg.Docker.Mode = "storage"
	if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, managedStorageLinkCapability) {
		t.Fatal("storage profile advertised the managed storage link capability")
	}
}

func TestDockerProfileAdvertisesCompletedLinkSessions(t *testing.T) {
	plugin := &DockerPlugin{cfg: &config.Config{}}
	if !containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, managedLinkCompletedCapability) {
		t.Fatal("docker profile does not advertise that its link reports carry completed_total")
	}
	plugin.cfg.Docker.Mode = "storage"
	if containsCapability(plugin.BuildRegisterMessage("node-1").Capabilities, managedLinkCompletedCapability) {
		t.Fatal("storage profile advertised the completed link sessions capability")
	}
}
