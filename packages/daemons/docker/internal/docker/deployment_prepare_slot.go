package docker

import (
	"context"
	"errors"
	"fmt"

	mobyclient "github.com/moby/moby/client"
)

// deploymentActionPrepareSlot creates one slot of a deployment with the
// desired config and pulls its image, without starting it. A planned handoff
// of a singleton (enabling strict failover Availability on a deployment whose
// running slot must be recreated) prepares the other colour first, then stops
// the active slot and switches: the serving gap is stop + start + readiness,
// never pull or create. Older daemons answer "unknown deployment action" and
// Opfield creates the colour inside the gap instead.
const deploymentActionPrepareSlot = "prepare_slot"

var errPrepareOverRunningSlot = errors.New("a deployment slot is never prepared over its running container")

func (c *Client) PrepareDeploymentSlot(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	slot := payload.ToSlot
	if slot == "" {
		slot = payload.Slot
	}
	slotName := dep.slotName(slot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", slot)
	}
	desired := payload.DesiredConfig
	if desired.Image == "" {
		return nil, fmt.Errorf("deployment image is required")
	}
	inspected, err := c.cli.ContainerInspect(ctx, slotName, mobyclient.ContainerInspectOptions{})
	switch {
	case err == nil && inspected.Container.State != nil && inspected.Container.State.Running:
		// The slot carrying traffic (or any running copy under this name) is
		// replaced only by a switch that stopped it first.
		return nil, errPrepareOverRunningSlot
	case err != nil && !isNotFoundErr(err):
		return nil, fmt.Errorf("inspect deployment slot %s: %w", slotName, err)
	}
	gpuSelection, err := c.resolveGPUConfig(ctx, desired.GPU)
	if err != nil {
		return nil, err
	}
	if err := c.pullImageIfNeeded(ctx, desired.Image, payload.RegistryAuthJSON); err != nil {
		return nil, err
	}
	if err := c.removeContainerByName(ctx, slotName, true); err != nil {
		return nil, err
	}
	id, err := c.createDeploymentSlot(ctx, dep.ID, dep.NetworkName, slot, slotName, desired, false, gpuSelection)
	if err != nil {
		return nil, err
	}
	return map[string]string{"containerId": id}, nil
}
