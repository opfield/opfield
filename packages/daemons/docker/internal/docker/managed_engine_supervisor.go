package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/events"
	mobyclient "github.com/moby/moby/client"
)

// Managed database and storage engines keep their data on a loop-mounted
// image. Docker must never start one on its own: at boot it would do so before
// this daemon mounted the image, and the engine would initialise an empty data
// directory on the root filesystem. Their restart policy is therefore "no",
// and this daemon is the only one that starts them, always after mounting the
// image: at its own start, when an engine stops while it should run (a crash,
// an OOM kill) and after a Docker restart.
var engineRestartPolicy = container.RestartPolicy{Name: container.RestartPolicyDisabled}

const (
	engineRestartFirstDelay  = time.Second
	engineRestartMaxDelay    = time.Minute
	engineRestartStableAfter = time.Minute
	engineRestartTimeout     = 2 * time.Minute
	engineEventsRetryDelay   = 5 * time.Second
)

// ensureEngineRestartPolicy turns Docker's own restart off for an engine
// container created by an older daemon ("unless-stopped"), live and without
// recreating it.
func ensureEngineRestartPolicy(ctx context.Context, client *Client, containerID string) error {
	inspect, err := client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return nil
		}
		return err
	}
	if hostConfig := inspect.Container.HostConfig; hostConfig == nil ||
		hostConfig.RestartPolicy.Name == "" || hostConfig.RestartPolicy.Name == container.RestartPolicyDisabled {
		return nil
	}
	policy := engineRestartPolicy
	if _, err := client.cli.ContainerUpdate(ctx, containerID, mobyclient.ContainerUpdateOptions{RestartPolicy: &policy}); err != nil {
		return fmt.Errorf("turn off Docker restart of engine container: %w", err)
	}
	return nil
}

// engineStopped reports whether an engine container exists and is not running;
// a missing container is left to the Gateway's repair.
func engineStopped(ctx context.Context, client *Client, containerID string) (bool, error) {
	inspect, err := client.cli.ContainerInspect(ctx, containerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return false, nil
		}
		return false, err
	}
	return inspect.Container.State == nil || !inspect.Container.State.Running, nil
}

// startStoppedEngine starts the database's engine if it should run and is not
// running, after mounting its image; it never starts it without the image.
// containerID, when set, is the container whose stop triggered this: a stop of
// a container since replaced or removed is ignored.
func (m *managedDatabaseManager) startStoppedEngine(ctx context.Context, id, containerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !record.DesiredRunning || record.Deleting || record.ContainerID == "" || (containerID != "" && containerID != record.ContainerID) {
		return nil
	}
	if record.AvailabilityMemberID != "" || record.clickHouseAvailabilityMember() {
		// The member runtime starts a set member, always through standby at
		// rest.
		return nil
	}
	// A disk being repaired (or whose repair failed) keeps its engine stopped;
	// the disk watch starts it once the disk is repaired.
	if m.repairs.running(id) || record.DiskRepair.blocksEngine() {
		return nil
	}
	if stopped, err := engineStopped(ctx, m.client, record.ContainerID); err != nil || !stopped {
		return err
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	// An engine on a read-only disk only fails again: the disk is repaired
	// instead, which starts the engine afterwards.
	if readOnly, reason := m.loopHost().readOnlyMount(record.MountPath); readOnly {
		go m.repairDisk(context.WithoutCancel(ctx), id, reason)
		return nil
	}
	if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
		if err := m.saveRecord(record); err != nil {
			return err
		}
		return runtimeFilesMissingError("managed database", missing)
	}
	if _, err := m.client.cli.ContainerStart(ctx, record.ContainerID, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed database container: %w", err)
	}
	m.logger.Info("started managed database engine after mounting its storage", "id", id)
	return m.saveRecord(record)
}

// startStoppedEngine is the managed storage variant; a removed member is never
// started.
func (m *managedStorageManager) startStoppedEngine(ctx context.Context, id, containerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(id)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !record.DesiredRunning || record.Removed || record.ContainerID == "" || (containerID != "" && containerID != record.ContainerID) {
		return nil
	}
	if record.Set != nil {
		// The member runtime starts a set member's containers.
		return nil
	}
	if m.repairs.running(id) || record.DiskRepair.blocksEngine() {
		return nil
	}
	if stopped, err := engineStopped(ctx, m.client, record.ContainerID); err != nil || !stopped {
		return err
	}
	// Until it runs again it is neither serving nor coming back: an engine
	// the supervisor cannot start is stopped, not starting.
	run := m.engineRun(record.ContainerID)
	m.setEngineRun(record.ContainerID, engineRun{exited: run.exited, restartedAt: run.restartedAt})
	if err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	if readOnly, reason := m.loopHost().readOnlyMount(record.MountPath); readOnly {
		go m.repairDisk(context.WithoutCancel(ctx), id, reason)
		return nil
	}
	if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
		if err := m.saveRecord(record); err != nil {
			return err
		}
		return runtimeFilesMissingError("managed storage", missing)
	}
	// A SeaweedFS engine the kernel killed for memory in a container an older
	// daemon made is recreated once with the current settings (memory bounds
	// among them) instead of being started as it was: it is down anyway, and
	// the same container would be killed the same way. Other crashes (damaged
	// data, for one) are not the settings' fault and only start it again.
	if containerID != "" && run.oomKilled && record.engine() == managedStorageEngineSeaweedFS && m.seaweedfsContainerOutdated(ctx, record) {
		if _, tried := m.oomRecreated.LoadOrStore(record.ContainerID, true); !tried {
			input := managedStorageCommand{Engine: managedStorageEngineSeaweedFS, PublishS3: record.PublishS3, PublishedPort: record.PublishedPort}
			if err := m.recreate(ctx, &record, input); err != nil {
				// The previous container is back and started (see recreate).
				m.logger.Warn("managed storage engine killed for memory could not be recreated with the current settings; it was started as it was", "id", id, "error", err)
				return nil
			}
			m.forgetEngineRun(containerID)
			m.logger.Info("recreated managed storage engine with the current settings after it was killed for memory", "id", id)
			return m.saveRecord(record)
		}
	}
	if _, err := m.client.cli.ContainerStart(ctx, record.ContainerID, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed storage container: %w", err)
	}
	m.setEngineRun(record.ContainerID, restartedEngineRun(run, containerID != "", time.Now()))
	m.logger.Info("started managed storage engine after mounting its storage", "id", id)
	return m.saveRecord(record)
}

// engineRestarts spaces the restarts of an engine that keeps stopping, like
// Docker's own backoff: the delay doubles up to a minute and starts over once
// an engine ran for a minute.
type engineRestarts struct {
	mu      sync.Mutex
	delay   map[string]time.Duration
	last    map[string]time.Time
	pending map[string]bool
	after   func(time.Duration, func())
	now     func() time.Time
}

func newEngineRestarts() *engineRestarts {
	return &engineRestarts{
		delay:   map[string]time.Duration{},
		last:    map[string]time.Time{},
		pending: map[string]bool{},
		after:   func(d time.Duration, f func()) { time.AfterFunc(d, f) },
		now:     time.Now,
	}
}

func (r *engineRestarts) schedule(key string, run func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pending[key] {
		return
	}
	delay := r.delay[key]
	if delay == 0 || r.now().Sub(r.last[key]) > engineRestartStableAfter {
		delay = engineRestartFirstDelay
	}
	r.delay[key] = min(2*delay, engineRestartMaxDelay)
	r.pending[key] = true
	r.after(delay, func() {
		r.mu.Lock()
		r.pending[key] = false
		r.last[key] = r.now()
		r.mu.Unlock()
		run()
	})
}

// runManagedEngineSupervisor follows Docker's container events for the life
// of the process and starts engines that stopped while they should run.
func (p *DockerPlugin) runManagedEngineSupervisor(ctx context.Context) {
	if p.storageManager != nil {
		// Engines are kept running here; their disks are kept from filling
		// up with deleted objects alongside.
		go p.storageManager.runSpaceReclaim(ctx)
	}
	// So are their disks: one that went read-only is repaired, and the space
	// of deleted data goes back to the node.
	go p.runManagedDiskWatch(ctx)
	restarts := newEngineRestarts()
	for {
		p.watchEngineEvents(ctx, restarts)
		select {
		case <-ctx.Done():
			return
		case <-time.After(engineEventsRetryDelay):
		}
	}
}

func (p *DockerPlugin) watchEngineEvents(ctx context.Context, restarts *engineRestarts) {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream := p.client.cli.Events(streamCtx, mobyclient.EventsListOptions{
		Filters: mobyclient.Filters{}.Add("type", string(events.ContainerEventType)).Add("event",
			string(events.ActionDie), string(events.ActionKill), string(events.ActionOOM), string(events.ActionStart)),
	})
	stops := newEngineStops()
	select {
	case err := <-stream.Err:
		// Docker is not answering (it is restarting); retried shortly.
		p.logger.Debug("managed engine supervision could not open the Docker event stream", "error", err)
		return
	default:
	}
	// Engines that stopped while no stream was open (a Docker restart, which
	// stops them without restarting them) start now.
	p.startStoppedEngines(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-stream.Err:
			if err != nil && ctx.Err() == nil {
				p.logger.Warn("managed engine supervision lost the Docker event stream", "error", err)
			}
			return
		case message := <-stream.Messages:
			if requested, oom, died := stops.observe(message); died {
				p.handleEngineStop(ctx, restarts, message, requested, oom)
			}
		}
	}
}

// handleEngineStop starts an engine that died while it should run.
// requested is a stop asked for through Docker's API (see engineStops).
func (p *DockerPlugin) handleEngineStop(ctx context.Context, restarts *engineRestarts, message events.Message, requested, oom bool) {
	containerID := message.Actor.ID
	if id := message.Actor.Attributes[managedDatabaseLabel]; id != "" && p.databaseManager != nil {
		if !requested {
			p.databaseManager.incidents.record(id, oom)
			p.logger.Warn("managed database engine stopped on its own; starting it again", "id", id, "outOfMemory", oom)
		}
		restarts.schedule("database/"+id, func() {
			restartCtx, cancel := context.WithTimeout(ctx, engineRestartTimeout)
			defer cancel()
			if err := p.databaseManager.startStoppedEngine(restartCtx, id, containerID); err != nil {
				p.logger.Warn("stopped managed database engine was not started", "id", id, "error", err)
			}
		})
	}
	if id := message.Actor.Attributes[managedStorageLabel]; id != "" && p.storageManager != nil {
		p.storageManager.recordEngineStop(containerID, requested, oom)
		if !requested {
			p.storageManager.incidents.record(id, oom)
			p.logger.Warn("managed storage engine stopped on its own; starting it again", "id", id, "outOfMemory", oom)
		}
		restarts.schedule("storage/"+id, func() {
			restartCtx, cancel := context.WithTimeout(ctx, engineRestartTimeout)
			defer cancel()
			if err := p.storageManager.startStoppedEngine(restartCtx, id, containerID); err != nil {
				p.logger.Warn("stopped managed storage engine was not started", "id", id, "error", err)
			}
		})
	}
}

// engineStopRequestWindow bounds how long a stop signal may precede the
// engine's exit to count as the cause of it (a stop's timeout ends in SIGKILL).
const engineStopRequestWindow = 2 * time.Minute

// engineStops tells why an engine container died, from the events before its
// die. A stop asked for through Docker's API (docker stop, kill or restart, or
// this daemon's own stop) sends a stop signal first, logged as a "kill"
// event; a process that crashes dies without one, and the kernel's OOM kill
// is logged as "oom". A start begins a new run. It is used by the event loop
// alone.
type engineStops struct {
	signalled map[string]time.Time
	oom       map[string]bool
}

func newEngineStops() *engineStops {
	return &engineStops{signalled: map[string]time.Time{}, oom: map[string]bool{}}
}

// observe follows one container event. For a die of an engine container it
// reports died, whether the stop was asked for (a stop signal within
// engineStopRequestWindow before it and no OOM kill since the engine
// started) and whether the kernel killed it for memory.
func (s *engineStops) observe(message events.Message) (requested, oom, died bool) {
	attributes := message.Actor.Attributes
	if attributes[managedDatabaseLabel] == "" && attributes[managedStorageLabel] == "" {
		return false, false, false
	}
	containerID := message.Actor.ID
	at := time.Unix(0, message.TimeNano)
	switch message.Action {
	case events.ActionKill:
		if engineStopSignals[strings.TrimPrefix(strings.ToUpper(attributes["signal"]), "SIG")] {
			s.signalled[containerID] = at
		}
	case events.ActionOOM:
		s.oom[containerID] = true
	case events.ActionStart:
		delete(s.signalled, containerID)
		delete(s.oom, containerID)
	case events.ActionDie:
		signalled, ok := s.signalled[containerID]
		oom = s.oom[containerID] || attributes["exitCode"] == "137" && !ok
		requested = ok && !s.oom[containerID] && at.Sub(signalled) <= engineStopRequestWindow
		delete(s.signalled, containerID)
		delete(s.oom, containerID)
		return requested, oom, true
	}
	return false, false, false
}

// engineStopSignals are the signals that stop an engine, as Docker logs them
// (a number) or as a name; a reload signal (SIGHUP for a certificate reload)
// is not one.
var engineStopSignals = map[string]bool{
	"2": true, "3": true, "9": true, "15": true,
	"INT": true, "QUIT": true, "KILL": true, "TERM": true,
}

// startStoppedEngines starts every engine that should run and does not.
func (p *DockerPlugin) startStoppedEngines(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, loopImageRepairTimeout)
	defer cancel()
	if p.databaseManager != nil {
		for _, id := range engineRecordIDs(filepath.Join(p.databaseManager.root, "records")) {
			if err := p.databaseManager.startStoppedEngine(ctx, id, ""); err != nil {
				p.logger.Warn("stopped managed database engine was not started", "id", id, "error", err)
			}
		}
	}
	if p.storageManager != nil {
		for _, id := range engineRecordIDs(filepath.Join(p.storageManager.root, "storage", "records")) {
			if err := p.storageManager.startStoppedEngine(ctx, id, ""); err != nil {
				p.logger.Warn("stopped managed storage engine was not started", "id", id, "error", err)
			}
		}
	}
}

func engineRecordIDs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var ids []string
	for _, entry := range entries {
		if id, ok := strings.CutSuffix(entry.Name(), ".json"); ok && !entry.IsDir() {
			ids = append(ids, id)
		}
	}
	return ids
}
