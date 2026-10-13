package docker

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/docker-daemon/internal/lease"
)

// leaseEngine is the Docker side of the availability lease runtime. The
// runtime calls it only from background operations, never from its loop.
const composeProjectLabel = "com.docker.compose.project"

type leaseEngine struct {
	client     *Client
	cgroupRoot string
	// composeProjects maps compose project names of live placements to them.
	composeProjects func() map[string]availabilityPlacement
	// runtimeIdentities maps the recorded runtimes of container and deployment
	// placements (origin workloads carry no availability labels, D1).
	runtimeIdentities func() leaseRuntimeIdentities

	infoMu        sync.Mutex
	cgroupDriver  string
	cgroupVersion string
}

var _ lease.Engine = (*leaseEngine)(nil)

func (e *leaseEngine) ListLeaseContainers(ctx context.Context) ([]lease.Container, error) {
	filters := make(mobyclient.Filters).Add("label", availabilityPolicyLabel)
	listed, err := e.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true, Filters: filters})
	if err != nil {
		return nil, fmt.Errorf("list lease-mode containers: %w", err)
	}
	out := make([]lease.Container, 0, len(listed.Items))
	seen := map[string]bool{}
	for _, item := range listed.Items {
		c, found, inspectErr := e.Inspect(ctx, item.ID)
		if inspectErr != nil {
			return nil, inspectErr
		}
		if found {
			seen[c.ID] = true
			out = append(out, c)
		}
	}
	out, err = e.appendRuntimeIdentities(ctx, out, seen)
	if err != nil {
		return nil, err
	}
	return e.appendComposeProjects(ctx, out, seen)
}

// appendRuntimeIdentities adds the unlabeled containers a placement recorded
// as its runtime: the origin container or deployment a policy was enabled on
// keeps running as the slot's workload without availability labels (D1,
// stand run rc20 B-2: the orders origin never acquired its bootstrap slot).
func (e *leaseEngine) appendRuntimeIdentities(ctx context.Context, out []lease.Container, seen map[string]bool) ([]lease.Container, error) {
	if e.runtimeIdentities == nil {
		return out, nil
	}
	identities := e.runtimeIdentities()
	if identities.empty() {
		return out, nil
	}
	listed, err := e.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("list placement runtime containers: %w", err)
	}
	for _, item := range listed.Items {
		if seen[item.ID] {
			continue
		}
		placement, ok := identities.match(item.ID, item.Names, item.Labels)
		if !ok {
			continue
		}
		c, found, inspectErr := e.Inspect(ctx, item.ID)
		if inspectErr != nil {
			return nil, inspectErr
		}
		if found {
			c.PolicyID, c.PlacementID = placement.PolicyID, placement.PlacementID
			seen[c.ID] = true
			out = append(out, c)
		}
	}
	return out, nil
}

// appendComposeProjects adds the containers of compose placements: user
// Compose files carry no availability labels, so they are found by their
// project name from the placement's runtime identity (T6 §3.1).
func (e *leaseEngine) appendComposeProjects(ctx context.Context, out []lease.Container, seen map[string]bool) ([]lease.Container, error) {
	if e.composeProjects == nil {
		return out, nil
	}
	projects := e.composeProjects()
	if len(projects) == 0 {
		return out, nil
	}
	filters := make(mobyclient.Filters).Add("label", composeProjectLabel)
	listed, err := e.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true, Filters: filters})
	if err != nil {
		return nil, fmt.Errorf("list compose placement containers: %w", err)
	}
	for _, item := range listed.Items {
		placement, ok := projects[item.Labels[composeProjectLabel]]
		if !ok || seen[item.ID] {
			continue
		}
		c, found, inspectErr := e.Inspect(ctx, item.ID)
		if inspectErr != nil {
			return nil, inspectErr
		}
		if found {
			c.PolicyID, c.PlacementID = placement.PolicyID, placement.PlacementID
			out = append(out, c)
		}
	}
	return out, nil
}

func (e *leaseEngine) Inspect(ctx context.Context, id string) (lease.Container, bool, error) {
	result, err := e.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return lease.Container{}, false, nil
		}
		return lease.Container{}, false, fmt.Errorf("inspect lease-mode container: %w", err)
	}
	return e.convert(ctx, result.Container), true, nil
}

func (e *leaseEngine) convert(ctx context.Context, inspect container.InspectResponse) lease.Container {
	c := lease.Container{ID: inspect.ID, Name: trimContainerName(inspect.Name), RestartCount: inspect.RestartCount}
	if inspect.Config != nil {
		c.Labels = inspect.Config.Labels
		c.PolicyID = inspect.Config.Labels[availabilityPolicyLabel]
		c.PlacementID = inspect.Config.Labels[availabilityPlacementLabel]
		if inspect.Config.StopTimeout != nil && *inspect.Config.StopTimeout > 0 {
			c.StopTimeout = time.Duration(*inspect.Config.StopTimeout) * time.Second
		}
	}
	if inspect.HostConfig != nil {
		c.RestartPolicy = string(inspect.HostConfig.RestartPolicy.Name)
		if c.RestartPolicy == "" {
			c.RestartPolicy = "no"
		}
	}
	pid := 0
	if state := inspect.State; state != nil {
		c.Running, c.Paused, c.Restarting = state.Running, state.Paused, state.Restarting
		c.Status, c.ExitCode, pid = string(state.Status), state.ExitCode, state.Pid
		if state.Health != nil {
			c.Health = string(state.Health.Status)
		}
		if started, err := time.Parse(time.RFC3339Nano, state.StartedAt); err == nil && started.Year() > 1 {
			c.StartedAt = started
		}
	}
	c.CgroupPath = e.cgroupPath(ctx, inspect, pid)
	return c
}

// cgroupPath is the running container's cgroup from /proc, else Docker's
// predicted location. The watchdog also probes the standard layouts.
func (e *leaseEngine) cgroupPath(ctx context.Context, inspect container.InspectResponse, pid int) string {
	if pid > 0 {
		if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid)); err == nil {
			if path := leasefence.CgroupFromProc(e.cgroupRoot, string(data)); path != "" {
				return path
			}
		}
	}
	driver, version := e.cgroupInfo(ctx)
	parent := ""
	if inspect.HostConfig != nil {
		parent = inspect.HostConfig.CgroupParent
	}
	root := e.cgroupRoot
	if version == "1" {
		root = filepath.Join(root, "pids")
	}
	if driver == "systemd" {
		if parent == "" {
			parent = "system.slice"
		}
		return filepath.Join(root, parent, "docker-"+inspect.ID+".scope")
	}
	if parent == "" {
		parent = "docker"
	}
	return filepath.Join(root, parent, inspect.ID)
}

func (e *leaseEngine) cgroupInfo(ctx context.Context) (string, string) {
	e.infoMu.Lock()
	defer e.infoMu.Unlock()
	if e.cgroupDriver == "" {
		if info, err := e.client.cli.Info(ctx, mobyclient.InfoOptions{}); err == nil {
			e.cgroupDriver, e.cgroupVersion = info.Info.CgroupDriver, info.Info.CgroupVersion
		}
	}
	return e.cgroupDriver, e.cgroupVersion
}

func (e *leaseEngine) Start(ctx context.Context, id string) error {
	return e.client.StartContainer(ctx, id)
}

func (e *leaseEngine) Stop(ctx context.Context, id string, grace time.Duration) error {
	return e.client.StopContainer(ctx, id, int(math.Ceil(grace.Seconds())))
}

func (e *leaseEngine) Kill(ctx context.Context, id string) error {
	return e.client.KillContainer(ctx, id, "KILL")
}

func (e *leaseEngine) DisableRestart(ctx context.Context, id string) error {
	_, err := e.client.cli.ContainerUpdate(ctx, id, mobyclient.ContainerUpdateOptions{
		RestartPolicy: &container.RestartPolicy{Name: container.RestartPolicyDisabled},
	})
	return err
}

func (e *leaseEngine) CgroupEmpty(_ context.Context, c lease.Container) (bool, error) {
	return leasefence.ContainerCgroupEmpty(e.cgroupRoot, c.ID, c.CgroupPath)
}

func trimContainerName(name string) string {
	for len(name) > 0 && name[0] == '/' {
		name = name[1:]
	}
	return name
}
