package docker

import (
	"context"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/moby/moby/api/types/events"
	mobyclient "github.com/moby/moby/client"
)

const (
	// connectorEventSettle gathers the events of one connector start (and dockerd's restart of every container).
	connectorEventSettle = time.Second
	// connectorEventsRetry spaces the subscriptions while dockerd does not answer.
	connectorEventsRetry = 2 * time.Second
	// connectorResyncSpacing is the least time between two resyncs started by connector events.
	connectorResyncSpacing = 5 * time.Second
	// connectorDrainSettle gives a connector told to drain by its signal the moment it takes to act on it: the
	// resync then finds it refusing and replaces it.
	connectorDrainSettle = 200 * time.Millisecond
)

// followConnectorStarts resyncs the connector as soon as its container starts again (D5): a connector that crashed
// and was restarted by its restart policy, or that dockerd started after its own restart, holds no listener, and
// workloads reach the egress listeners directly, without a dial through the daemon that would restore them. After
// the event stream broke (dockerd restarted) it resyncs as well: a start may have been missed. A connector told to
// drain by its signal (docker kill -s USR1) closes its listeners at once for the same workloads: the resync that
// follows replaces it (abandonDrainingConnectorLocked) instead of the next sync, which waited for a grant bundle.
func (m *dockerSecureLinkManager) followConnectorStarts(ctx context.Context) {
	if m.plugin == nil || m.plugin.client == nil {
		return
	}
	for {
		missed := m.watchConnectorStarts(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(connectorEventsRetry):
		}
		if missed {
			m.resyncAfterConnectorStart()
		}
	}
}

// watchConnectorStarts follows the connector's start events until the stream ends, and reports whether it ended
// with an error (events may have been missed).
func (m *dockerSecureLinkManager) watchConnectorStarts(ctx context.Context) bool {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	filters := mobyclient.Filters{}.
		Add("type", string(events.ContainerEventType)).
		// No label filter: a connector created before Opfield carries its
		// label under the pre-Opfield key; the name check below selects it.
		Add("event", string(events.ActionStart)).
		Add("event", string(events.ActionRestart)).
		Add("event", string(events.ActionKill))
	stream := m.plugin.client.cli.Events(streamCtx, mobyclient.EventsListOptions{Filters: filters})
	var settle <-chan time.Time
	var settleAt, resynced time.Time
	for {
		select {
		case <-ctx.Done():
			return false
		case err := <-stream.Err:
			return err != nil && ctx.Err() == nil
		case message := <-stream.Messages:
			if !isSecureLinkConnectorName(message.Actor.Attributes["name"]) {
				continue
			}
			// A resync starts the connector itself when it had to replace it: that start is not resynced again
			// before connectorResyncSpacing. A drain signal is answered at once.
			wait := max(connectorEventSettle, time.Until(resynced.Add(connectorResyncSpacing)))
			if message.Action == events.ActionKill {
				if !m.drainSignalled(message) {
					continue
				}
				wait = connectorDrainSettle
			}
			if at := time.Now().Add(wait); settle == nil || at.Before(settleAt) {
				settle, settleAt = time.After(wait), at
			}
		case <-settle:
			settle = nil
			m.resyncAfterConnectorStart()
			resynced = time.Now()
		}
	}
}

// drainSignalled reports a drain signal to a connector this daemon does not retire: an operator's (or another
// tool's) docker kill -s USR1 to the serving connector. The daemon's own drain signal goes to a connector it
// recorded as retiring first (retireConnectorUntil).
func (m *dockerSecureLinkManager) drainSignalled(message events.Message) bool {
	if message.Action != events.ActionKill || !isDrainSignal(message.Actor.Attributes["signal"]) {
		return false
	}
	return !m.retiring.snapshot()[message.Actor.ID]
}

// isDrainSignal reads the signal of a kill event: dockerd reports its number.
func isDrainSignal(signal string) bool {
	name := strings.TrimPrefix(strings.ToUpper(signal), "SIG")
	return signal == strconv.Itoa(int(syscall.SIGUSR1)) || name == strings.TrimPrefix(secureLinkDrainSignal, "SIG")
}

// resyncAfterConnectorStart binds the committed ingress bindings and the egress listeners again. A serving connector
// that drains refuses that sync and is replaced by a new one.
func (m *dockerSecureLinkManager) resyncAfterConnectorStart() {
	ingress := m.plugin.secureLinkState != nil && len(m.plugin.secureLinkState.Get().Bindings) > 0
	if ingress {
		// The restore applies the egress listeners too.
		if err := m.restoreBindingsCoalesced(true); err == nil {
			return
		} else if m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector started again; its links could not all be bound yet", "error", err)
		}
	}
	m.resyncEgress()
}
