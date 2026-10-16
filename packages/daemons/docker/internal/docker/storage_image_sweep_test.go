package docker

import (
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	imagetypes "github.com/moby/moby/api/types/image"
)

const (
	pgOld     = "ghcr.io/the-square-labs/gateway/postgres@sha256:1111111111111111111111111111111111111111111111111111111111111111"
	pgMiddle  = "ghcr.io/the-square-labs/gateway/postgres@sha256:2222222222222222222222222222222222222222222222222222222222222222"
	pgCurrent = "ghcr.io/the-square-labs/gateway/postgres@sha256:3333333333333333333333333333333333333333333333333333333333333333"
	swOld     = "ghcr.io/the-square-labs/gateway/seaweedfs@sha256:4444444444444444444444444444444444444444444444444444444444444444"
	swCurrent = "docker.io/chrislusf/seaweedfs@sha256:5555555555555555555555555555555555555555555555555555555555555555"
)

func sweepImage(id, reference string, created int64) imagetypes.Summary {
	return imagetypes.Summary{ID: "sha256:" + id, RepoDigests: []string{reference}, Created: created}
}

func TestStorageImageSweepKeepsUsedNamedAndNewestUnused(t *testing.T) {
	images := []imagetypes.Summary{
		sweepImage("pg-old", pgOld, 1),
		sweepImage("pg-middle", pgMiddle, 2),
		sweepImage("pg-current", pgCurrent, 3),
		sweepImage("sw-old", swOld, 1),
		// The same SeaweedFS digest pulled from the mirror: a storage record names its upstream reference.
		sweepImage("sw-current", "ghcr.io/the-square-labs/gateway/seaweedfs@sha256:5555555555555555555555555555555555555555555555555555555555555555", 2),
		{ID: "sha256:dangling", Created: 1},
	}
	// A stopped engine container still uses the oldest Postgres image.
	containers := []container.Summary{{ImageID: "sha256:pg-old", State: "exited"}}
	start := time.Unix(1_000_000, 0)

	remove, since := selectStorageImageRemovals(images, containers, []string{swCurrent}, map[string]time.Time{}, start)
	if len(remove) != 0 {
		t.Fatalf("first sweep removed %v, want nothing before the unused age", remove)
	}
	// pg-current is the newest unused Postgres image (kept); sw-old is the only unused SeaweedFS image (kept).
	if _, ok := since["sha256:pg-middle"]; !ok || len(since) != 2 {
		t.Fatalf("tracking = %v, want pg-middle and dangling", since)
	}
	if _, ok := since["sha256:dangling"]; !ok {
		t.Fatalf("dangling image not tracked: %v", since)
	}

	remove, _ = selectStorageImageRemovals(images, containers, []string{swCurrent}, since, start.Add(storageImageUnusedAge-time.Second))
	if len(remove) != 0 {
		t.Fatalf("removed %v before the unused age", remove)
	}
	remove, _ = selectStorageImageRemovals(images, containers, []string{swCurrent}, since, start.Add(storageImageUnusedAge))
	if len(remove) != 2 || remove[0] != "sha256:dangling" || remove[1] != "sha256:pg-middle" {
		t.Fatalf("removed %v, want the dangling image and the superseded Postgres image", remove)
	}
}

func TestStorageImageSweepRestartsTheClockForAnImageUsedAgain(t *testing.T) {
	images := []imagetypes.Summary{sweepImage("a", pgOld, 1), sweepImage("b", pgMiddle, 2), sweepImage("c", pgCurrent, 3)}
	start := time.Unix(1_000_000, 0)
	_, since := selectStorageImageRemovals(images, nil, nil, map[string]time.Time{}, start)
	// An engine was created from "a" meanwhile: it drops out of the tracking.
	_, since = selectStorageImageRemovals(images, []container.Summary{{ImageID: "sha256:a"}}, nil, since, start.Add(time.Hour))
	if _, ok := since["sha256:a"]; ok {
		t.Fatalf("an image in use is still tracked: %v", since)
	}
	remove, _ := selectStorageImageRemovals(images, nil, nil, since, start.Add(storageImageUnusedAge))
	for _, id := range remove {
		if id == "sha256:a" {
			t.Fatalf("an image used an hour ago was removed: %v", remove)
		}
	}
}
