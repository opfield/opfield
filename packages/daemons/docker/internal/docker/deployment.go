package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const (
	deploymentManagedLabel           = "net.opfield.deployment.managed"
	deploymentIDLabel                = "net.opfield.deployment.id"
	deploymentRoleLabel              = "net.opfield.deployment.role"
	deploymentSlotLabel              = "net.opfield.deployment.slot"
	availabilityPolicyLabel          = "net.opfield.availability.policy"
	availabilityPlacementLabel       = "net.opfield.availability.placement"
	availabilityGenerationLabel      = "net.opfield.availability.generation"
	availabilitySpecFingerprintLabel = "net.opfield.availability.spec-fingerprint"
)

// deploymentCandidateStopTimeoutSeconds is the grace a failed rollout candidate gets to stop, as for a drained slot.
const deploymentCandidateStopTimeoutSeconds = 10

type deploymentRouteConfig struct {
	HostPort      uint16 `json:"hostPort"`
	HostIP        string `json:"hostIp"`
	ContainerPort uint16 `json:"containerPort"`
	IsPrimary     bool   `json:"isPrimary"`
}

type deploymentHealthConfig struct {
	Path                 string `json:"path"`
	StatusMin            int    `json:"statusMin"`
	StatusMax            int    `json:"statusMax"`
	TimeoutSeconds       int    `json:"timeoutSeconds"`
	IntervalSeconds      int    `json:"intervalSeconds"`
	SuccessThreshold     int    `json:"successThreshold"`
	StartupGraceSeconds  int    `json:"startupGraceSeconds"`
	DeployTimeoutSeconds int    `json:"deployTimeoutSeconds"`
}

type deploymentDesiredConfig struct {
	Image          string            `json:"image"`
	Env            map[string]string `json:"env"`
	Mounts         []deploymentMount `json:"mounts"`
	Command        []string          `json:"command"`
	Entrypoint     []string          `json:"entrypoint"`
	WorkingDir     string            `json:"workingDir"`
	User           string            `json:"user"`
	Labels         map[string]string `json:"labels"`
	Networks       []string          `json:"networks"`
	ExtraHosts     []string          `json:"extraHosts"`
	RestartPolicy  string            `json:"restartPolicy"`
	RuntimeProfile string            `json:"runtimeProfile"`
	Runtime        map[string]any    `json:"runtime"`
	GPU            *GPUConfig        `json:"gpu"`
}

type deploymentMount struct {
	HostPath      string `json:"hostPath"`
	ContainerPath string `json:"containerPath"`
	Name          string `json:"name"`
	ReadOnly      bool   `json:"readOnly"`
}

type deploymentSnapshot struct {
	ID            string                  `json:"id"`
	RouterName    string                  `json:"routerName"`
	RouterImage   string                  `json:"routerImage"`
	NetworkName   string                  `json:"networkName"`
	ActiveSlot    string                  `json:"activeSlot"`
	Routes        []deploymentRouteConfig `json:"routes"`
	HealthConfig  deploymentHealthConfig  `json:"healthConfig"`
	DesiredConfig deploymentDesiredConfig `json:"desiredConfig"`
	Slots         []struct {
		Slot          string `json:"slot"`
		ContainerName string `json:"containerName"`
	} `json:"slots"`
}

type deploymentCommandPayload struct {
	DeploymentID     string                             `json:"deploymentId"`
	Name             string                             `json:"name"`
	ActiveSlot       string                             `json:"activeSlot"`
	RouterName       string                             `json:"routerName"`
	RouterImage      string                             `json:"routerImage"`
	NetworkName      string                             `json:"networkName"`
	Slots            map[string]string                  `json:"slots"`
	Routes           []deploymentRouteConfig            `json:"routes"`
	Health           deploymentHealthConfig             `json:"health"`
	DesiredConfig    deploymentDesiredConfig            `json:"desiredConfig"`
	SlotConfigs      map[string]deploymentDesiredConfig `json:"slotConfigs"`
	Labels           map[string]string                  `json:"labels"`
	Deployment       deploymentSnapshot                 `json:"deployment"`
	ToSlot           string                             `json:"toSlot"`
	Slot             string                             `json:"slot"`
	Image            string                             `json:"image"`
	RegistryAuthJSON string                             `json:"registryAuthJson"`
	Force            bool                               `json:"force"`
}

type deploymentOperation struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// deploymentLock serializes the mutating operations of one deployment. It is a
// one-slot semaphore so that waiting for it can be cancelled.
type deploymentLock struct {
	slot chan struct{}
	refs int
}

// beginDeploymentOperation registers a cancellable operation on a deployment.
// Every registered operation, running or still waiting for the deployment
// lock, is cancelled by an emergency kill.
func (p *DockerPlugin) beginDeploymentOperation(deploymentID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	p.deploymentOpMu.Lock()
	if p.deploymentOps == nil {
		p.deploymentOps = make(map[string]map[uint64]deploymentOperation)
	}
	p.deploymentOpSeq++
	generation := p.deploymentOpSeq
	done := make(chan struct{})
	if p.deploymentOps[deploymentID] == nil {
		p.deploymentOps[deploymentID] = make(map[uint64]deploymentOperation)
	}
	p.deploymentOps[deploymentID][generation] = deploymentOperation{cancel: cancel, done: done}
	p.deploymentOpMu.Unlock()
	return ctx, func() {
		cancel()
		p.deploymentOpMu.Lock()
		if operations := p.deploymentOps[deploymentID]; operations != nil {
			delete(operations, generation)
			if len(operations) == 0 {
				delete(p.deploymentOps, deploymentID)
			}
		}
		close(done)
		p.deploymentOpMu.Unlock()
	}
}

func (p *DockerPlugin) cancelDeploymentOperationAndWait(deploymentID string, timeout time.Duration) bool {
	p.deploymentOpMu.Lock()
	operations := make([]deploymentOperation, 0, len(p.deploymentOps[deploymentID]))
	for _, operation := range p.deploymentOps[deploymentID] {
		operations = append(operations, operation)
	}
	p.deploymentOpMu.Unlock()
	for _, operation := range operations {
		operation.cancel()
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for _, operation := range operations {
		select {
		case <-operation.done:
		case <-timer.C:
			return false
		}
	}
	return true
}

// deploymentOperationInProgress reports whether a mutating operation runs on,
// or waits for, the deployment. A kill holds the lock without registering.
func (p *DockerPlugin) deploymentOperationInProgress(deploymentID string) bool {
	p.deploymentOpMu.Lock()
	defer p.deploymentOpMu.Unlock()
	return len(p.deploymentOps[deploymentID]) > 0 || p.deploymentLocks[deploymentID] != nil
}

// lockDeployment waits until no other mutating operation runs on the
// deployment. The backend retries commands it timed out on, so without this a
// retry could run next to the original, e.g. recreate the slot the router is
// serving while a switch is still in progress.
func (p *DockerPlugin) lockDeployment(ctx context.Context, deploymentID string) (func(), error) {
	p.deploymentOpMu.Lock()
	if p.deploymentLocks == nil {
		p.deploymentLocks = make(map[string]*deploymentLock)
	}
	lock := p.deploymentLocks[deploymentID]
	if lock == nil {
		lock = &deploymentLock{slot: make(chan struct{}, 1)}
		p.deploymentLocks[deploymentID] = lock
	}
	lock.refs++
	p.deploymentOpMu.Unlock()

	release := func(held bool) {
		if held {
			<-lock.slot
		}
		p.deploymentOpMu.Lock()
		lock.refs--
		if lock.refs == 0 && p.deploymentLocks[deploymentID] == lock {
			delete(p.deploymentLocks, deploymentID)
		}
		p.deploymentOpMu.Unlock()
	}
	select {
	case lock.slot <- struct{}{}:
		// The slot can free up in the same instant an emergency kill cancels
		// this waiter; select then picks either. Cancellation wins.
		if err := ctx.Err(); err != nil {
			release(true)
			return nil, err
		}
		return func() { release(true) }, nil
	case <-ctx.Done():
		release(false)
		return nil, ctx.Err()
	}
}

func (p *DockerPlugin) handleDeploymentCommand(cmd *pb.DockerDeploymentCommand, result *pb.CommandResult) {
	if cmd.ConfigJson == "" && cmd.Action != "inspect" {
		result.Success = false
		result.Error = "config_json is required"
		return
	}

	var payload deploymentCommandPayload
	if cmd.ConfigJson != "" {
		if err := json.Unmarshal([]byte(cmd.ConfigJson), &payload); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("parse deployment payload: %v", err)
			return
		}
	}
	if payload.DeploymentID == "" {
		payload.DeploymentID = cmd.DeploymentId
	}
	if payload.Slot == "" {
		payload.Slot = cmd.Slot
	}
	if cmd.Force {
		payload.Force = true
	}

	ctx := context.Background()
	switch cmd.Action {
	case "inspect":
	case "kill":
		// Cancel the running operation and every one queued behind it, then
		// take the deployment lock so nothing interleaves with the kill.
		if !p.cancelDeploymentOperationAndWait(payload.DeploymentID, emergencyKillCancellationTimeout) {
			result.Success = false
			result.Error = "timed out cancelling the active deployment operation"
			return
		}
		lockCtx, cancelLock := context.WithTimeout(ctx, emergencyKillCancellationTimeout)
		unlock, err := p.lockDeployment(lockCtx, payload.DeploymentID)
		cancelLock()
		if err != nil {
			result.Success = false
			result.Error = "timed out waiting for the active deployment operation to stop"
			return
		}
		defer unlock()
	default:
		var finishOperation func()
		ctx, finishOperation = p.beginDeploymentOperation(payload.DeploymentID)
		defer finishOperation()
		unlock, err := p.lockDeployment(ctx, payload.DeploymentID)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("deployment %s action cancelled while waiting for another operation on the deployment: %v", cmd.Action, err)
			return
		}
		defer unlock()
	}

	var detail any
	var err error
	switch cmd.Action {
	case "create":
		detail, err = p.client.CreateDeployment(ctx, payload)
	case deploymentActionCreateStandby:
		detail, err = p.client.CreateDeploymentStandby(ctx, payload)
	case "deploy_slot":
		detail, err = p.client.DeployDeploymentSlot(ctx, payload)
	case deploymentActionPrepareSlot:
		detail, err = p.client.PrepareDeploymentSlot(ctx, payload)
	case "switch":
		detail, err = p.client.SwitchDeployment(ctx, payload)
	case "update_router":
		detail, err = p.client.UpdateDeploymentRouter(ctx, payload)
	case "start":
		detail, err = p.client.StartDeployment(ctx, payload)
	case "stop":
		err = p.client.StopDeployment(ctx, payload)
	case "restart":
		detail, err = p.client.RestartDeployment(ctx, payload)
	case "kill":
		err = p.client.KillDeployment(ctx, payload)
	case "inspect":
		var inspected map[string]any
		inspected, err = p.client.InspectDeployment(ctx, cmd.DeploymentId, payload.Deployment)
		if err == nil {
			// A backend that restarted mid-operation must not reconcile its
			// records against a router the still-running operation may change.
			inspected["operationInProgress"] = p.deploymentOperationInProgress(cmd.DeploymentId)
			detail = inspected
		}
	case "stop_slot":
		err = p.client.StopDeploymentSlot(ctx, payload)
	case "remove":
		err = p.client.RemoveDeployment(ctx, payload)
	default:
		err = fmt.Errorf("unknown deployment action: %s", cmd.Action)
	}
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	if detail != nil {
		data, marshalErr := json.Marshal(detail)
		if marshalErr != nil {
			result.Success = false
			result.Error = marshalErr.Error()
			return
		}
		result.Detail = string(data)
	}
}

// removeLeftoverDeploymentContainers makes a retried create idempotent. It
// removes every container an earlier, partially failed attempt left behind,
// proven to belong to this deployment by its managed and id labels. A container
// without those labels that holds one of the target names is never removed:
// the create fails instead, before anything is changed.
func (c *Client) removeLeftoverDeploymentContainers(ctx context.Context, deploymentID string, names []string) error {
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return err
	}
	targets := make(map[string]struct{}, len(names))
	for _, name := range names {
		if name != "" {
			targets[name] = struct{}{}
		}
	}
	var leftovers []ContainerInfo
	for _, ctr := range containers {
		if deploymentContainerLabelsOwned(ctr.Labels, deploymentID) {
			leftovers = append(leftovers, ctr)
			continue
		}
		if _, collides := targets[ctr.Name]; collides {
			return fmt.Errorf("deployment container name %q is already used by a container that is not owned by deployment %s; remove or rename that container and retry", ctr.Name, deploymentID)
		}
	}
	for _, ctr := range leftovers {
		target := ctr.ID
		if target == "" {
			target = ctr.Name
		}
		if err := c.removeContainerByName(ctx, target, true); err != nil {
			return fmt.Errorf("remove leftover deployment container %q: %w", ctr.Name, err)
		}
	}
	return nil
}

func (c *Client) CreateDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	if payload.RouterImage == "" {
		payload.RouterImage = defaultDeploymentRouterImage
	}
	if payload.ActiveSlot == "" {
		payload.ActiveSlot = "blue"
	}
	if payload.DesiredConfig.Image == "" {
		return nil, fmt.Errorf("deployment image is required")
	}
	gpuSelection, err := c.resolveGPUConfig(ctx, payload.DesiredConfig.GPU)
	if err != nil {
		return nil, err
	}
	if err := c.pullImageIfNeeded(ctx, payload.DesiredConfig.Image, payload.RegistryAuthJSON); err != nil {
		return nil, err
	}
	if err := c.pullImageIfNeeded(ctx, payload.RouterImage, ""); err != nil {
		return nil, err
	}
	for _, slot := range []string{"blue", "green"} {
		if payload.Slots[slot] == "" {
			return nil, fmt.Errorf("%s slot container name is required", slot)
		}
	}
	if err := c.removeLeftoverDeploymentContainers(ctx, payload.DeploymentID, []string{payload.Slots["blue"], payload.Slots["green"], payload.RouterName}); err != nil {
		return nil, err
	}
	if err := c.ensureDeploymentNetwork(ctx, payload.NetworkName, payload.DeploymentID); err != nil {
		return nil, err
	}

	slotIDs := map[string]string{}
	for _, slot := range []string{"blue", "green"} {
		slotName := payload.Slots[slot]
		slotID, err := c.createDeploymentSlot(ctx, payload.DeploymentID, payload.NetworkName, slot, slotName, payload.DesiredConfig, slot == payload.ActiveSlot, gpuSelection)
		if err != nil {
			return nil, err
		}
		slotIDs[slot] = slotID
	}
	routerID, err := c.createDeploymentRouter(ctx, payload, payload.ActiveSlot)
	if err != nil {
		return nil, err
	}
	slotName := payload.Slots[payload.ActiveSlot]
	if err := c.waitDeploymentReady(ctx, payload.NetworkName, slotName, payload.Routes, payload.Health); err != nil {
		return nil, err
	}
	return map[string]string{
		"routerId":         routerID,
		"containerId":      slotIDs[payload.ActiveSlot],
		"blueContainerId":  slotIDs["blue"],
		"greenContainerId": slotIDs["green"],
	}, nil
}

func (c *Client) DeployDeploymentSlot(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	slotName := dep.slotName(payload.ToSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", payload.ToSlot)
	}
	desired := payload.DesiredConfig
	if desired.Image == "" {
		desired = dep.DesiredConfig
		desired.Image = payload.Image
	}
	gpuSelection, err := c.resolveGPUConfig(ctx, desired.GPU)
	if err != nil {
		return nil, err
	}
	if err := c.pullImageIfNeeded(ctx, desired.Image, payload.RegistryAuthJSON); err != nil {
		return nil, err
	}
	_ = c.removeContainerByName(ctx, slotName, true)
	id, err := c.createDeploymentSlot(ctx, dep.ID, dep.NetworkName, payload.ToSlot, slotName, desired, true, gpuSelection)
	if err != nil {
		return nil, err
	}
	if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
		return nil, c.stopFailedDeploymentCandidate(ctx, dep, payload.ToSlot, slotName, err)
	}
	return map[string]string{"containerId": id}, nil
}

func (c *Client) SwitchDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	activeSlot := payload.ActiveSlot
	if activeSlot == "" {
		activeSlot = payload.Slot
	}
	if activeSlot == "" {
		return nil, fmt.Errorf("active slot is required")
	}
	slotName := dep.slotName(activeSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", activeSlot)
	}
	containerID := ""
	if payload.DesiredConfig.Image != "" {
		gpuSelection, err := c.resolveGPUConfig(ctx, payload.DesiredConfig.GPU)
		if err != nil {
			return nil, err
		}
		if err := c.pullImageIfNeeded(ctx, payload.DesiredConfig.Image, payload.RegistryAuthJSON); err != nil {
			return nil, err
		}
		_ = c.removeContainerByName(ctx, slotName, true)
		id, err := c.createDeploymentSlot(ctx, dep.ID, dep.NetworkName, activeSlot, slotName, payload.DesiredConfig, true, gpuSelection)
		if err != nil {
			return nil, err
		}
		containerID = id
	} else {
		id, err := c.ensureDeploymentSlotRunning(ctx, slotName)
		if err != nil {
			return nil, err
		}
		containerID = id
	}
	if !payload.Force {
		if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
			return nil, c.stopFailedDeploymentCandidate(ctx, dep, activeSlot, slotName, err)
		}
	}
	// A deployment that was stopped or killed has a stopped router; switching
	// traffic must bring it back instead of failing on the config reload.
	if _, err := c.ensureDeploymentRouterRunning(ctx, dep); err != nil {
		return nil, err
	}
	config := c.deploymentRouterConfigFor(ctx, dep.NetworkName, slotName, dep.Routes, activeSlot)
	if err := c.writeRouterConfig(ctx, dep.RouterName, config); err != nil {
		return nil, err
	}
	return map[string]string{"containerId": containerID}, nil
}

// stopFailedDeploymentCandidate stops a rollout candidate that failed readiness and returns the readiness error.
// Left running, a crash-looping candidate keeps taking its links' sessions (database bindings, storage links share
// one limit across both slots) from the slot that serves. The container stays for its logs. The slot the router
// serves (the snapshot's active slot) is never stopped here, and neither is a candidate of a cancelled operation:
// the emergency kill that cancelled it stops everything itself.
func (c *Client) stopFailedDeploymentCandidate(ctx context.Context, dep deploymentSnapshot, slot, slotName string, readinessErr error) error {
	if dep.ActiveSlot == "" || slot == dep.ActiveSlot || ctx.Err() != nil {
		return readinessErr
	}
	if err := c.StopContainer(ctx, slotName, deploymentCandidateStopTimeoutSeconds); err != nil && !isNotFoundErr(err) {
		return fmt.Errorf("%w; stopping the failed %s slot failed: %v", readinessErr, slot, err)
	}
	return fmt.Errorf("%w; the %s slot was stopped and kept for its logs", readinessErr, slot)
}

func (c *Client) UpdateDeploymentRouter(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	routes := payload.Routes
	if len(routes) == 0 {
		routes = dep.Routes
	}
	if len(routes) == 0 {
		return nil, fmt.Errorf("deployment routes are required")
	}
	if payload.DeploymentID == "" {
		payload.DeploymentID = dep.ID
	}
	if payload.RouterName == "" {
		payload.RouterName = dep.RouterName
	}
	if payload.RouterImage == "" {
		payload.RouterImage = dep.RouterImage
	}
	if payload.NetworkName == "" {
		payload.NetworkName = dep.NetworkName
	}
	payload.Routes = routes

	recreate, err := c.deploymentRouterNeedsRecreate(ctx, payload.RouterName, routes)
	if err != nil {
		return nil, err
	}
	if recreate {
		_ = c.removeContainerByName(ctx, payload.RouterName, true)
		routerID, err := c.createDeploymentRouter(ctx, payload, dep.ActiveSlot)
		if err != nil {
			if killErr := c.KillDeployment(ctx, payload); killErr != nil {
				return nil, fmt.Errorf("%w; deployment kill after router failure failed: %v", err, killErr)
			}
			return nil, fmt.Errorf("%w; deployment killed after router failure", err)
		}
		return map[string]string{"routerId": routerID}, nil
	}
	routerDep := dep
	routerDep.RouterName, routerDep.RouterImage, routerDep.NetworkName, routerDep.Routes = payload.RouterName, payload.RouterImage, payload.NetworkName, routes
	if _, err := c.ensureDeploymentRouterRunning(ctx, routerDep); err != nil {
		return nil, err
	}
	routerConfig := c.deploymentRouterConfigFor(ctx, payload.NetworkName, dep.slotName(dep.ActiveSlot), routes, dep.ActiveSlot)
	if err := c.writeRouterConfig(ctx, payload.RouterName, routerConfig); err != nil {
		if killErr := c.KillDeployment(ctx, payload); killErr != nil {
			return nil, fmt.Errorf("%w; deployment kill after router failure failed: %v", err, killErr)
		}
		return nil, fmt.Errorf("%w; deployment killed after router failure", err)
	}
	return map[string]string{}, nil
}

func (c *Client) StopDeploymentSlot(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	slot := payload.Slot
	if slot == "" {
		slot = payload.ToSlot
	}
	name := dep.slotName(slot)
	if name == "" {
		return fmt.Errorf("unknown deployment slot %q", slot)
	}
	timeout := 10
	err := c.StopContainer(ctx, name, timeout)
	if isNotFoundErr(err) {
		return nil
	}
	return err
}

func (c *Client) StartDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	if dep.ID == "" {
		dep.ID = payload.DeploymentID
	}
	slotName := dep.slotName(dep.ActiveSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", dep.ActiveSlot)
	}
	if err := c.stopInactiveDeploymentSlots(ctx, dep); err != nil {
		return nil, err
	}
	containerID, err := c.ensureDeploymentSlotRunning(ctx, slotName)
	if err != nil {
		return nil, err
	}
	// The router comes back even when the active slot is unhealthy, so a
	// following deploy to the other slot can switch traffic.
	if _, err := c.ensureDeploymentRouterRunning(ctx, dep); err != nil {
		return nil, err
	}
	if !payload.Force {
		if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
			return nil, err
		}
	}
	if err := c.writeRouterConfig(ctx, dep.RouterName, c.deploymentRouterConfigFor(ctx, dep.NetworkName, slotName, dep.Routes, dep.ActiveSlot)); err != nil {
		return nil, err
	}
	return map[string]string{"containerId": containerID}, nil
}

func (c *Client) StopDeployment(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	if err := c.StopContainer(ctx, dep.RouterName, 10); err != nil && !isNotFoundErr(err) {
		return err
	}
	for _, slot := range dep.Slots {
		if slot.ContainerName == "" {
			continue
		}
		if err := c.StopContainer(ctx, slot.ContainerName, 10); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) RestartDeployment(ctx context.Context, payload deploymentCommandPayload) (map[string]string, error) {
	dep := payload.Deployment
	if dep.ID == "" {
		dep.ID = payload.DeploymentID
	}
	slotName := dep.slotName(dep.ActiveSlot)
	if slotName == "" {
		return nil, fmt.Errorf("unknown deployment slot %q", dep.ActiveSlot)
	}
	if err := c.stopInactiveDeploymentSlots(ctx, dep); err != nil {
		return nil, err
	}
	if err := c.RestartContainer(ctx, slotName, 10); err != nil {
		return nil, err
	}
	if !payload.Force {
		if err := c.waitDeploymentReady(ctx, dep.NetworkName, slotName, dep.Routes, dep.HealthConfig); err != nil {
			return nil, err
		}
	}
	routerID, err := c.ensureDeploymentRouterRunning(ctx, dep)
	if err != nil {
		return nil, err
	}
	if err := c.writeRouterConfig(ctx, dep.RouterName, c.deploymentRouterConfigFor(ctx, dep.NetworkName, slotName, dep.Routes, dep.ActiveSlot)); err != nil {
		return nil, err
	}
	slotID, err := c.containerID(ctx, slotName)
	if err != nil {
		return nil, err
	}
	return map[string]string{"containerId": slotID, "routerId": routerID}, nil
}

func (c *Client) KillDeployment(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	if err := c.KillContainer(ctx, dep.RouterName, "SIGKILL"); err != nil && !isNotFoundErr(err) {
		return err
	}
	for _, slot := range dep.Slots {
		if slot.ContainerName == "" {
			continue
		}
		if err := c.KillContainer(ctx, slot.ContainerName, "SIGKILL"); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) stopInactiveDeploymentSlots(ctx context.Context, dep deploymentSnapshot) error {
	for _, slot := range dep.Slots {
		if slot.Slot == dep.ActiveSlot || slot.ContainerName == "" {
			continue
		}
		if err := c.StopContainer(ctx, slot.ContainerName, 10); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) RemoveDeployment(ctx context.Context, payload deploymentCommandPayload) error {
	dep := payload.Deployment
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return err
	}
	byName := make(map[string]ContainerInfo, len(containers))
	for _, container := range containers {
		byName[container.Name] = container
	}
	targets := []struct {
		name string
		role string
		slot string
	}{
		{name: dep.slotName("blue"), role: "app", slot: "blue"},
		{name: dep.slotName("green"), role: "app", slot: "green"},
		{name: dep.RouterName, role: "router"},
	}
	for _, target := range targets {
		if target.name == "" {
			continue
		}
		container, exists := byName[target.name]
		if !exists {
			continue
		}
		if !deploymentRemovalContainerMatches(container, dep, target.role, target.slot, payload.Force) {
			return fmt.Errorf("deployment container %q ownership does not match removal payload", target.name)
		}
	}
	for _, target := range targets {
		if err := c.removeContainerByName(ctx, target.name, true); err != nil {
			return err
		}
	}
	if dep.NetworkName != "" {
		err = c.RemoveNetwork(ctx, dep.NetworkName)
		if err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	return nil
}

func (c *Client) InspectDeployment(ctx context.Context, deploymentID string, expected deploymentSnapshot) (map[string]any, error) {
	result := map[string]any{"deploymentId": deploymentID, "containers": []ContainerInfo{}}
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return nil, err
	}
	var matched []ContainerInfo
	expectedNames := map[string]struct{}{}
	if expected.RouterName != "" {
		expectedNames[expected.RouterName] = struct{}{}
	}
	for _, slot := range expected.Slots {
		if slot.ContainerName != "" {
			expectedNames[slot.ContainerName] = struct{}{}
		}
	}
	for _, ctr := range containers {
		_, exactNameMatch := expectedNames[ctr.Name]
		if ctr.Labels[deploymentIDLabel] == deploymentID || exactNameMatch {
			matched = append(matched, ctr)
		}
	}
	result["containers"] = matched
	router := deploymentRouterInspect{Name: expected.RouterName}
	if container := findDeploymentRouter(matched, deploymentID, expected.RouterName); container != nil {
		router = c.inspectDeploymentRouter(ctx, *container)
	}
	result["router"] = router
	return result, nil
}

// findDeploymentRouter prefers the router this deployment owns by label and
// falls back to the router name the backend expects.
func findDeploymentRouter(containers []ContainerInfo, deploymentID, routerName string) *ContainerInfo {
	for i := range containers {
		labels := containers[i].Labels
		if deploymentID != "" && labels[deploymentIDLabel] == deploymentID && labels[deploymentRoleLabel] == "router" {
			return &containers[i]
		}
	}
	for i := range containers {
		if routerName != "" && containers[i].Name == routerName {
			return &containers[i]
		}
	}
	return nil
}

func deploymentRemovalContainerMatches(container ContainerInfo, dep deploymentSnapshot, role, slot string, force bool) bool {
	labels := container.Labels
	if labels[deploymentIDLabel] != dep.ID || labels[deploymentManagedLabel] != "true" || labels[deploymentRoleLabel] != role {
		return false
	}
	if role == "app" && labels[deploymentSlotLabel] != slot {
		return false
	}
	if force {
		return true
	}
	expectedLabels := dep.DesiredConfig.Labels
	actualAvailability := []string{
		labels[availabilityPolicyLabel],
		labels[availabilityPlacementLabel],
		labels[availabilityGenerationLabel],
		labels[availabilitySpecFingerprintLabel],
	}
	hasAvailabilityIdentity := false
	for _, value := range actualAvailability {
		if value != "" {
			hasAvailabilityIdentity = true
			break
		}
	}
	if !hasAvailabilityIdentity {
		// The managed, id, role and slot labels checked above prove ownership.
		// The image is not compared: the standby slot keeps the previous image
		// after a deploy or rollback, and tags move or gain registry prefixes.
		return true
	}
	if role != "app" {
		return false
	}
	if expectedLabels[availabilityPolicyLabel] == "" && expectedLabels[availabilityPlacementLabel] == "" {
		return true
	}
	if expectedLabels[availabilityPolicyLabel] == "" || expectedLabels[availabilityPlacementLabel] == "" {
		return false
	}
	if labels[availabilityPolicyLabel] != expectedLabels[availabilityPolicyLabel] ||
		labels[availabilityPlacementLabel] != expectedLabels[availabilityPlacementLabel] {
		return false
	}
	actualGeneration, actualErr := strconv.ParseUint(labels[availabilityGenerationLabel], 10, 64)
	expectedGeneration, expectedErr := strconv.ParseUint(expectedLabels[availabilityGenerationLabel], 10, 64)
	return actualErr == nil && expectedErr == nil && actualGeneration > 0 && actualGeneration <= expectedGeneration
}
