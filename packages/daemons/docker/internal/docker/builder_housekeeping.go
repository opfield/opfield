package docker

import (
	"context"
	"time"

	builderruntime "github.com/opfield/opfield/docker-daemon/internal/builder"
)

// builderHousekeepingFirstRun gives the isolated runtime time to come up before the first IdleHousekeeping.
var builderHousekeepingFirstRun = time.Minute

// runBuilderHousekeeping runs the builder's IdleHousekeeping shortly after start (what a crash or an older daemon
// left waits no longer for the next build) and then every IdleHousekeepingInterval while the worker is idle; a run
// skipped because a build runs is retried after builderHousekeepingRetry.
func (p *DockerPlugin) runBuilderHousekeeping() {
	const builderHousekeepingRetry = 10 * time.Minute
	wait := builderHousekeepingFirstRun
	for {
		time.Sleep(wait)
		if p.builderManager == nil {
			return
		}
		ran, err := p.builderManager.IdleHousekeeping(context.Background())
		if err != nil {
			p.logger.Warn("builder housekeeping could not remove everything", "error", err)
		}
		wait = builderruntime.IdleHousekeepingInterval
		if !ran {
			wait = builderHousekeepingRetry
		}
	}
}
