package docker

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	imagetypes "github.com/moby/moby/api/types/image"
	mobyclient "github.com/moby/moby/client"
)

// A database or storage node runs only Opfield's engines, and Opfield cannot
// reach its Docker images from the control plane (the storage profile takes no
// generic image commands). Each engine version pulls its own image, pinned by
// digest, and nothing removed the one an update or a version change left
// behind. This sweep removes unused images on the node itself.
const (
	storageImageSweepFirst    = 10 * time.Minute
	storageImageSweepInterval = time.Hour
	// storageImageUnusedAge is how long an image must have been unused, as this
	// process saw it, before it goes: an image pulled for an engine about to be
	// created or moved is never removed under it.
	storageImageUnusedAge = 24 * time.Hour
)

type storageImageSweep struct {
	mu    sync.Mutex
	since map[string]time.Time
}

// runStorageImageSweep removes unused engine and tool images on a storage-profile
// node for the life of the process (see selectStorageImageRemovals).
func (p *DockerPlugin) runStorageImageSweep(ctx context.Context) {
	sweep := &storageImageSweep{since: map[string]time.Time{}}
	timer := time.NewTimer(storageImageSweepFirst)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		p.sweepStorageImages(ctx, sweep, time.Now())
		timer.Reset(storageImageSweepInterval)
	}
}

func (p *DockerPlugin) sweepStorageImages(ctx context.Context, sweep *storageImageSweep, now time.Time) {
	images, err := p.client.cli.ImageList(ctx, mobyclient.ImageListOptions{All: true})
	if err != nil {
		p.logger.Debug("unused image sweep skipped: image list failed", "error", err)
		return
	}
	// Without the container list nothing can be judged unused.
	containers, err := p.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true})
	if err != nil {
		p.logger.Debug("unused image sweep skipped: container list failed", "error", err)
		return
	}
	var needed []string
	if p.storageManager != nil {
		records, _, err := p.storageManager.records()
		if err != nil {
			p.logger.Debug("unused image sweep skipped: storage records unreadable", "error", err)
			return
		}
		for _, record := range records {
			if !record.Removed && record.Image != "" {
				needed = append(needed, record.Image)
			}
		}
	}
	sweep.mu.Lock()
	remove, next := selectStorageImageRemovals(images.Items, containers.Items, needed, sweep.since, now)
	sweep.since = next
	sweep.mu.Unlock()
	removed := 0
	for _, id := range remove {
		// Never forced: Docker refuses an image a container uses, or one with
		// references in several repositories.
		if _, err := p.client.cli.ImageRemove(ctx, id, mobyclient.ImageRemoveOptions{PruneChildren: true}); err != nil {
			p.logger.Debug("unused image kept: Docker refused to remove it", "image_id", id, "error", err)
			continue
		}
		removed++
		sweep.mu.Lock()
		delete(sweep.since, id)
		sweep.mu.Unlock()
	}
	if removed > 0 {
		p.logger.Info("removed unused images", "count", removed)
	}
}

// imageRepositoryOf is the repository of an image's first reference (tag or
// digest); "" for an image nothing names.
func imageRepositoryOf(image imagetypes.Summary) string {
	for _, reference := range append(append([]string(nil), image.RepoTags...), image.RepoDigests...) {
		if reference == "" || strings.HasPrefix(reference, "<none>") {
			continue
		}
		name := reference
		if at := strings.Index(name, "@"); at >= 0 {
			name = name[:at]
		}
		if colon := strings.LastIndex(name, ":"); colon > strings.LastIndex(name, "/") {
			name = name[:colon]
		}
		return name
	}
	return ""
}

// imageNamedBy reports whether one of the references names the image, by
// digest (the GHCR mirror and the upstream share it) or by exact tag.
func imageNamedBy(image imagetypes.Summary, digests, tags map[string]struct{}) bool {
	for _, reference := range image.RepoDigests {
		if at := strings.Index(reference, "@"); at >= 0 {
			if _, ok := digests[reference[at+1:]]; ok {
				return true
			}
		}
	}
	for _, tag := range image.RepoTags {
		if _, ok := tags[tag]; ok {
			return true
		}
	}
	return false
}

// selectStorageImageRemovals decides which images a storage-profile node
// removes now. An image stays while a container (running or stopped) uses it,
// while a managed instance names it, and while it is the newest unused image of
// its repository (the image a stopped engine, the backup runner or the next
// restore staging runs again). Every other image goes once it has been unused
// for storageImageUnusedAge, counted from `since` (the first sweep that found
// it removable). It returns the image IDs to remove and the tracking to keep.
func selectStorageImageRemovals(
	images []imagetypes.Summary,
	containers []container.Summary,
	needed []string,
	since map[string]time.Time,
	now time.Time,
) ([]string, map[string]time.Time) {
	digests := map[string]struct{}{}
	tags := map[string]struct{}{}
	for _, reference := range needed {
		for _, candidate := range thirdPartyImageCandidates(reference) {
			if at := strings.Index(candidate, "@"); at >= 0 {
				digests[candidate[at+1:]] = struct{}{}
			} else {
				tags[candidate] = struct{}{}
			}
		}
	}
	byRepository := map[string][]imagetypes.Summary{}
	for _, image := range images {
		used := false
		for _, ctr := range containers {
			if containerUsesImage(ctr, image) {
				used = true
				break
			}
		}
		if used || imageNamedBy(image, digests, tags) {
			continue
		}
		repository := imageRepositoryOf(image)
		if repository == "" {
			// Nothing names it: no newest one to keep.
			repository = "\x00" + image.ID
		}
		byRepository[repository] = append(byRepository[repository], image)
	}
	next := map[string]time.Time{}
	var remove []string
	for repository, unused := range byRepository {
		sort.Slice(unused, func(i, j int) bool {
			if unused[i].Created != unused[j].Created {
				return unused[i].Created > unused[j].Created
			}
			return unused[i].ID < unused[j].ID
		})
		if !strings.HasPrefix(repository, "\x00") {
			unused = unused[1:]
		}
		for _, image := range unused {
			first, ok := since[image.ID]
			if !ok {
				first = now
			}
			next[image.ID] = first
			if now.Sub(first) >= storageImageUnusedAge {
				remove = append(remove, image.ID)
			}
		}
	}
	sort.Strings(remove)
	return remove, next
}
