package docker

import (
	"context"
	"testing"
)

// A recreate whose replacement was created but answered an error (the
// command's context ran out) leaves no replacement behind: the previous
// container gets its name back and runs again. Before, the replacement stayed
// "Created" under the storage's name and the previous one ran on as
// "...-replaced" (production, 2026-10).
func TestFailedRecreateLeavesNoReplacementBehind(t *testing.T) {
	ctx := context.Background()
	mirror, _ := thirdPartyMirrorReference(seaweedfsUpstreamImage)
	m, docker, record := newMoveTest(t, mirror, map[string]bool{mirror: true, seaweedfsImage: true}, map[string]bool{})
	docker.createTimesOut = true

	err := m.recreate(ctx, &record, managedStorageCommand{Engine: managedStorageEngineSeaweedFS})
	if err == nil {
		t.Fatal("the recreate succeeded")
	}
	if len(docker.containers) != 1 || docker.containers["old1"] == nil {
		t.Fatalf("containers after the failed recreate: %v (calls %v)", docker.containers, docker.calls)
	}
	if old := docker.containers["old1"]; old.name != record.ContainerName || !old.running {
		t.Fatalf("previous container %+v, want it running under %s (calls %v)", old, record.ContainerName, docker.calls)
	}
	if record.ContainerID != "old1" {
		t.Fatalf("record names container %s", record.ContainerID)
	}
}

// A daemon start repairs what a replacement left: a superseded container is
// removed only when it is provably this storage's, not the record's and not
// running; the record's container gets its name back.
func TestDaemonStartHealsAReplacedStorageContainer(t *testing.T) {
	ctx := context.Background()
	setup := func(t *testing.T, containers map[string]*fakeMoveContainer, recordContainer string) (*managedStorageManager, *fakeMoveDocker, managedStorageRecord) {
		t.Helper()
		m, docker, record := newMoveTest(t, seaweedfsImage, map[string]bool{seaweedfsImage: true}, map[string]bool{})
		docker.containers = containers
		record.ContainerID = recordContainer
		return m, docker, record
	}
	base := "gateway-storage-33333333-3333-4333-8333-333333333333"

	t.Run("restored container under the rollback name", func(t *testing.T) {
		m, docker, record := setup(t, map[string]*fakeMoveContainer{
			"old1": {name: base + "-replaced", running: true},
			"new1": {name: base},
		}, "old1")
		m.healReplacedContainers(ctx, record)
		if docker.containers["new1"] != nil || docker.containers["old1"].name != base || !docker.containers["old1"].running {
			t.Fatalf("containers %v (calls %v)", docker.containers, docker.calls)
		}
	})

	t.Run("running holder of the name is kept", func(t *testing.T) {
		m, docker, record := setup(t, map[string]*fakeMoveContainer{
			"old1": {name: base + "-replaced", running: true},
			"new1": {name: base, running: true},
		}, "old1")
		m.healReplacedContainers(ctx, record)
		if docker.containers["new1"] == nil || docker.containers["old1"].name != base+"-replaced" {
			t.Fatalf("containers %v (calls %v)", docker.containers, docker.calls)
		}
	})

	t.Run("another owner's container is kept", func(t *testing.T) {
		m, docker, record := setup(t, map[string]*fakeMoveContainer{
			"old1": {name: base + "-replaced", running: true},
			"new1": {name: base, owner: "99999999-9999-4999-8999-999999999999"},
		}, "old1")
		m.healReplacedContainers(ctx, record)
		if docker.containers["new1"] == nil || docker.containers["old1"].name != base+"-replaced" {
			t.Fatalf("containers %v (calls %v)", docker.containers, docker.calls)
		}
	})

	t.Run("previous container a finished replacement left", func(t *testing.T) {
		m, docker, record := setup(t, map[string]*fakeMoveContainer{
			"new1": {name: base, running: true},
			"old1": {name: base + "-replaced"},
		}, "new1")
		m.healReplacedContainers(ctx, record)
		if docker.containers["old1"] != nil || docker.containers["new1"] == nil || docker.containers["new1"].name != base {
			t.Fatalf("containers %v (calls %v)", docker.containers, docker.calls)
		}
	})

	t.Run("running previous container is kept", func(t *testing.T) {
		m, docker, record := setup(t, map[string]*fakeMoveContainer{
			"new1": {name: base, running: true},
			"old1": {name: base + "-replaced", running: true},
		}, "new1")
		m.healReplacedContainers(ctx, record)
		if docker.containers["old1"] == nil || docker.containers["new1"] == nil {
			t.Fatalf("containers %v (calls %v)", docker.containers, docker.calls)
		}
	})

	t.Run("nothing to heal", func(t *testing.T) {
		m, docker, record := setup(t, map[string]*fakeMoveContainer{"new1": {name: base, running: true}}, "new1")
		m.healReplacedContainers(ctx, record)
		if len(docker.calls) != 0 {
			t.Fatalf("calls %v", docker.calls)
		}
	})
}
