package docker

import (
	"context"
	"time"

	"github.com/moby/moby/api/types/events"
	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

var _ lifecycle.HealthRefreshPlugin = (*DockerPlugin)(nil)

// Opfield learns a container's state from the health report: it compares the states of two reports and refreshes
// its copy of each container that changed. The periodic report comes every 30 s and its states are as old as the
// last metrics pass (every 10 s, longer with many running containers), so a container that exits on its own would
// show as running for up to a minute. A container event sends a report at once instead.
const (
	// containerStateSettle gathers the events of one change (kill, die, stop) into one report.
	containerStateSettle = 250 * time.Millisecond
	// containerStateReportSpacing bounds the extra reports of a container that keeps restarting.
	containerStateReportSpacing = 2 * time.Second
)

// containerStateActions are the events that change a container's state or whether it exists. An OOM kill is
// followed by its die.
var containerStateActions = []events.Action{
	events.ActionCreate, events.ActionStart, events.ActionDie, events.ActionDestroy,
	events.ActionPause, events.ActionUnPause,
}

// HealthRefreshRequested implements lifecycle.HealthRefreshPlugin.
func (p *DockerPlugin) HealthRefreshRequested() <-chan struct{} {
	return p.healthRefresh
}

func (p *DockerPlugin) requestHealthRefresh() {
	select {
	case p.healthRefresh <- struct{}{}:
	default:
	}
}

// followContainerStates sends a health report when a container starts, exits or is removed, for the life of the
// session.
func (p *DockerPlugin) followContainerStates(ctx context.Context, collector *StatsCollector) {
	for {
		p.watchContainerStates(ctx, collector)
		select {
		case <-ctx.Done():
			return
		case <-time.After(engineEventsRetryDelay):
		}
	}
}

func (p *DockerPlugin) watchContainerStates(ctx context.Context, collector *StatsCollector) {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	filters := mobyclient.Filters{}.Add("type", string(events.ContainerEventType))
	for _, action := range containerStateActions {
		filters = filters.Add("event", string(action))
	}
	stream := p.client.cli.Events(streamCtx, mobyclient.EventsListOptions{Filters: filters})
	var settle <-chan time.Time
	var reported time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-stream.Err:
			if err != nil && ctx.Err() == nil {
				p.logger.Debug("container state events stopped", "error", err)
			}
			return
		case <-stream.Messages:
			if settle == nil {
				settle = time.After(max(containerStateSettle, time.Until(reported.Add(containerStateReportSpacing))))
			}
		case <-settle:
			settle = nil
			changed, err := collector.refreshStates(ctx)
			if err != nil {
				p.logger.Debug("container states could not be read after a container event", "error", err)
				continue
			}
			if changed {
				reported = time.Now()
				p.requestHealthRefresh()
			}
		}
	}
}
