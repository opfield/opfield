package docker

import (
	"context"
	"time"
)

const (
	// builderIdlePruneFirst lets the isolated runtime settle after the daemon starts.
	builderIdlePruneFirst = time.Minute
	// builderIdlePruneInterval retries a prune that failed after a build, while no build runs.
	builderIdlePruneInterval = time.Hour
	builderIdlePruneTimeout  = 2 * time.Minute
)

// runBuilderIdlePrune empties the builder's stores while no build runs: once shortly after the daemon starts and then
// every builderIdlePruneInterval (see builder.Manager.PruneIdle).
func (p *DockerPlugin) runBuilderIdlePrune(ctx context.Context) {
	timer := time.NewTimer(builderIdlePruneFirst)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if manager := p.builderManager; manager != nil {
			pruneCtx, cancel := context.WithTimeout(ctx, builderIdlePruneTimeout)
			ran, err := manager.PruneIdle(pruneCtx)
			cancel()
			if err != nil {
				p.logger.Warn("builder store cleanup failed; it is retried", "error", err)
			} else if ran {
				p.logger.Debug("builder stores cleaned while idle")
			}
		}
		timer.Reset(builderIdlePruneInterval)
	}
}
