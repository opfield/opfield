package docker

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const (
	dockerAvailabilityCapability = "docker_availability_v1"

	availabilityActionPrepare     = "prepare"
	availabilityActionActivate    = "activate"
	availabilityActionStop        = "stop"
	availabilityActionInspect     = "inspect"
	availabilityActionDrain       = "drain"
	availabilityActionRemove      = "remove"
	availabilityActionAdoptSingle = "adopt_single"

	availabilityLifecyclePrepared = "prepared"
	availabilityLifecycleActive   = "active"
	availabilityLifecycleSingle   = "single"
	availabilityLifecycleDraining = "draining"
	availabilityLifecycleStopped  = "stopped"
	availabilityLifecycleRemoved  = "removed"

	availabilityStateVersion = 1
)

type availabilityManager struct {
	mu        sync.Mutex
	directory string
	statePath string
	state     availabilityState
}

type availabilityState struct {
	Version    int                              `json:"version"`
	Placements map[string]availabilityPlacement `json:"placements"`
}

type availabilityPlacement struct {
	PolicyID           string         `json:"policyId"`
	PlacementID        string         `json:"placementId"`
	ResourceKind       string         `json:"resourceKind"`
	ResourceID         string         `json:"resourceId"`
	HighestGeneration  uint64         `json:"highestGeneration"`
	LastIdempotencyKey string         `json:"lastIdempotencyKey"`
	OperationID        string         `json:"operationId"`
	LifecycleState     string         `json:"lifecycleState"`
	Tombstone          bool           `json:"tombstone"`
	RuntimeMetadata    map[string]any `json:"runtimeMetadata,omitempty"`
	LastAction         string         `json:"lastAction,omitempty"`
	UpdatedAtUnixMs    int64          `json:"updatedAtUnixMs"`
	LastResult         string         `json:"lastResult,omitempty"`
}

type availabilityPlacementDetail struct {
	PolicyID           string         `json:"policyId"`
	PlacementID        string         `json:"placementId"`
	ResourceKind       string         `json:"resourceKind"`
	ResourceID         string         `json:"resourceId"`
	Generation         uint64         `json:"generation"`
	State              string         `json:"state"`
	RuntimeIdentity    map[string]any `json:"runtimeIdentity,omitempty"`
	HighestGeneration  uint64         `json:"highestGeneration"`
	LastIdempotencyKey string         `json:"lastIdempotencyKey"`
	OperationID        string         `json:"operationId"`
	LifecycleState     string         `json:"lifecycleState"`
	Tombstone          bool           `json:"tombstone"`
	RuntimeMetadata    map[string]any `json:"runtimeMetadata,omitempty"`
	LastAction         string         `json:"lastAction,omitempty"`
	UpdatedAtUnixMs    int64          `json:"updatedAtUnixMs"`
}

func newAvailabilityManager(stateDir string) (*availabilityManager, error) {
	if strings.TrimSpace(stateDir) == "" {
		return nil, fmt.Errorf("state directory is required")
	}

	directory := filepath.Join(stateDir, "availability")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create availability state directory: %w", err)
	}
	info, err := os.Stat(directory)
	if err != nil {
		return nil, fmt.Errorf("stat availability state directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("availability state path is not a directory")
	}

	manager := &availabilityManager{
		directory: directory,
		statePath: filepath.Join(directory, "state.json"),
		state: availabilityState{
			Version:    availabilityStateVersion,
			Placements: make(map[string]availabilityPlacement),
		},
	}

	data, err := os.ReadFile(manager.statePath)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("read availability state: %w", err)
		}
		if err := manager.persistLocked(); err != nil {
			return nil, fmt.Errorf("initialize availability state: %w", err)
		}
		return manager, nil
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("availability state is empty")
	}
	if err := json.Unmarshal(data, &manager.state); err != nil {
		return nil, fmt.Errorf("decode availability state: %w", err)
	}
	if manager.state.Version != availabilityStateVersion {
		return nil, fmt.Errorf("unsupported availability state version %d", manager.state.Version)
	}
	if manager.state.Placements == nil {
		manager.state.Placements = make(map[string]availabilityPlacement)
	}
	for key, placement := range manager.state.Placements {
		if placement.PolicyID == "" || placement.PlacementID == "" {
			return nil, fmt.Errorf("availability state placement %q is missing identity", key)
		}
		if placement.Tombstone && placement.LifecycleState != availabilityLifecycleRemoved {
			return nil, fmt.Errorf("availability state placement %q has an invalid tombstone lifecycle", key)
		}
	}

	return manager, nil
}

func (m *availabilityManager) apply(cmd *pb.DockerAvailabilityCommand) (string, error) {
	if cmd == nil {
		return "", fmt.Errorf("docker availability command is required")
	}
	if err := validateAvailabilityCommand(cmd); err != nil {
		return "", err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	key := availabilityPlacementKey(cmd.GetPolicyId(), cmd.GetPlacementId())
	current, exists := m.state.Placements[key]
	if exists && !sameAvailabilityResource(current, cmd) {
		return "", fmt.Errorf("availability placement %q resource identity conflicts with persisted state", cmd.GetPlacementId())
	}

	if cmd.GetAction() == availabilityActionInspect {
		if !exists {
			return "", fmt.Errorf("availability placement %q is not persisted", cmd.GetPlacementId())
		}
		if cmd.GetGeneration() < current.HighestGeneration {
			return "", staleAvailabilityGeneration(cmd.GetGeneration(), current.HighestGeneration)
		}
		if current.LastResult != "" && cmd.GetGeneration() == current.HighestGeneration && current.LastIdempotencyKey == cmd.GetIdempotencyKey() {
			return current.LastResult, nil
		}
		return marshalAvailabilityPlacementDetail(current)
	}

	if exists && cmd.GetGeneration() < current.HighestGeneration {
		return "", staleAvailabilityGeneration(cmd.GetGeneration(), current.HighestGeneration)
	}
	if exists && cmd.GetGeneration() == current.HighestGeneration && current.LastResult != "" && current.LastIdempotencyKey == cmd.GetIdempotencyKey() {
		return current.LastResult, nil
	}
	var metadata map[string]any
	var err error
	if availabilityActionAcceptsConfig(cmd.GetAction()) && cmd.GetConfigJson() != "" {
		metadata, err = sanitizeAvailabilityConfig(cmd.GetConfigJson())
		if err != nil {
			return "", err
		}
	}

	higherGeneration := !exists || cmd.GetGeneration() > current.HighestGeneration
	candidate := current
	if exists {
		candidate.RuntimeMetadata = cloneAvailabilityMetadata(current.RuntimeMetadata)
	}
	if !exists {
		candidate = availabilityPlacement{
			PolicyID:     cmd.GetPolicyId(),
			PlacementID:  cmd.GetPlacementId(),
			ResourceKind: cmd.GetResourceKind(),
			ResourceID:   cmd.GetResourceId(),
		}
	}
	if higherGeneration {
		candidate.HighestGeneration = cmd.GetGeneration()
		candidate.LastResult = ""
		candidate.RuntimeMetadata = nil
	}
	candidate.LastIdempotencyKey = cmd.GetIdempotencyKey()
	candidate.OperationID = cmd.GetOperationId()
	candidate.LastAction = cmd.GetAction()
	candidate.UpdatedAtUnixMs = time.Now().UTC().UnixMilli()

	claimedPrepared := candidate.LifecycleState == availabilityLifecyclePrepared && candidate.RuntimeMetadata["phase"] == "claimed"
	if err := validateAvailabilityTransition(candidate.LifecycleState, cmd.GetAction(), higherGeneration, exists, claimedPrepared); err != nil {
		return "", err
	}

	switch cmd.GetAction() {
	case availabilityActionPrepare:
		candidate.LifecycleState = availabilityLifecyclePrepared
		candidate.Tombstone = false
	case availabilityActionActivate:
		candidate.LifecycleState = availabilityLifecycleActive
		candidate.Tombstone = false
	case availabilityActionAdoptSingle:
		candidate.LifecycleState = availabilityLifecycleSingle
		candidate.Tombstone = false
	case availabilityActionDrain:
		candidate.LifecycleState = availabilityLifecycleDraining
		candidate.Tombstone = false
	case availabilityActionStop:
		candidate.LifecycleState = availabilityLifecycleStopped
		candidate.Tombstone = false
	case availabilityActionRemove:
		candidate.LifecycleState = availabilityLifecycleRemoved
		candidate.Tombstone = true
	default:
		return "", fmt.Errorf("unknown Docker availability action %q", cmd.GetAction())
	}
	if metadata != nil {
		if candidate.RuntimeMetadata == nil {
			candidate.RuntimeMetadata = make(map[string]any)
		}
		for key, value := range metadata {
			candidate.RuntimeMetadata[key] = value
		}
	}

	detail, err := marshalAvailabilityPlacementDetail(candidate)
	if err != nil {
		return "", err
	}
	candidate.LastResult = detail

	previous, hadPrevious := m.state.Placements[key]
	m.state.Placements[key] = candidate
	if err := m.persistLocked(); err != nil {
		if hadPrevious {
			m.state.Placements[key] = previous
		} else {
			delete(m.state.Placements, key)
		}
		return "", fmt.Errorf("persist availability state: %w", err)
	}

	return detail, nil
}

func (m *availabilityManager) persistLocked() error {
	data, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	temporary, err := os.CreateTemp(m.directory, ".state-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryName, m.statePath); err != nil {
		return err
	}
	directory, err := os.Open(m.directory)
	if err != nil {
		return fmt.Errorf("open availability state directory for sync: %w", err)
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return fmt.Errorf("sync availability state directory: %w", err)
	}
	if err := directory.Close(); err != nil {
		return fmt.Errorf("close availability state directory after sync: %w", err)
	}
	return nil
}

func validateAvailabilityCommand(cmd *pb.DockerAvailabilityCommand) error {
	switch cmd.GetAction() {
	case availabilityActionPrepare, availabilityActionActivate, availabilityActionStop, availabilityActionInspect,
		availabilityActionDrain, availabilityActionRemove, availabilityActionAdoptSingle:
	default:
		return fmt.Errorf("unknown Docker availability action %q", cmd.GetAction())
	}
	if strings.TrimSpace(cmd.GetPolicyId()) == "" {
		return fmt.Errorf("availability policy id is required")
	}
	if strings.TrimSpace(cmd.GetPlacementId()) == "" {
		return fmt.Errorf("availability placement id is required")
	}
	if strings.TrimSpace(cmd.GetResourceKind()) == "" {
		return fmt.Errorf("availability resource kind is required")
	}
	if strings.TrimSpace(cmd.GetResourceId()) == "" {
		return fmt.Errorf("availability resource id is required")
	}
	return nil
}

func validateAvailabilityTransition(currentState, action string, higherGeneration, exists, claimedPrepared bool) error {
	if !exists {
		currentState = ""
	}

	valid := false
	switch action {
	case availabilityActionPrepare:
		valid = higherGeneration || currentState == "" || currentState == availabilityLifecyclePrepared
	case availabilityActionActivate:
		// Starting an existing placement does not create a new spec generation.
		// Ownership and generation fencing are checked before this transition.
		valid = currentState == availabilityLifecyclePrepared || currentState == availabilityLifecycleActive || currentState == availabilityLifecycleSingle || currentState == availabilityLifecycleStopped
	case availabilityActionAdoptSingle:
		valid = currentState == "" || currentState == availabilityLifecyclePrepared || currentState == availabilityLifecycleActive || currentState == availabilityLifecycleSingle || (higherGeneration && currentState == availabilityLifecycleRemoved)
	case availabilityActionDrain:
		valid = currentState == availabilityLifecycleActive || currentState == availabilityLifecycleSingle || currentState == availabilityLifecycleDraining || (currentState == availabilityLifecyclePrepared && claimedPrepared)
	case availabilityActionStop:
		valid = currentState == availabilityLifecyclePrepared || currentState == availabilityLifecycleActive || currentState == availabilityLifecycleSingle || currentState == availabilityLifecycleDraining || currentState == availabilityLifecycleStopped
	case availabilityActionRemove:
		valid = currentState == "" || currentState == availabilityLifecyclePrepared || currentState == availabilityLifecycleActive || currentState == availabilityLifecycleSingle || currentState == availabilityLifecycleDraining || currentState == availabilityLifecycleStopped || currentState == availabilityLifecycleRemoved
	}
	if valid {
		return nil
	}
	if currentState == "" {
		currentState = "new"
	}
	return fmt.Errorf("invalid availability lifecycle transition: %s -> %s", currentState, action)
}

func staleAvailabilityGeneration(commandGeneration, persistedGeneration uint64) error {
	return fmt.Errorf("stale availability generation: command generation %d is below persisted highest generation %d", commandGeneration, persistedGeneration)
}

func sameAvailabilityResource(placement availabilityPlacement, cmd *pb.DockerAvailabilityCommand) bool {
	return placement.PolicyID == cmd.GetPolicyId() &&
		placement.PlacementID == cmd.GetPlacementId() &&
		placement.ResourceKind == cmd.GetResourceKind() &&
		placement.ResourceID == cmd.GetResourceId()
}

func availabilityPlacementKey(policyID, placementID string) string {
	return policyID + "\x00" + placementID
}

func availabilityActionAcceptsConfig(action string) bool {
	return action == availabilityActionPrepare || action == availabilityActionActivate || action == availabilityActionStop || action == availabilityActionAdoptSingle
}

func marshalAvailabilityPlacementDetail(placement availabilityPlacement) (string, error) {
	detail := availabilityPlacementDetail{
		PolicyID:           placement.PolicyID,
		PlacementID:        placement.PlacementID,
		ResourceKind:       placement.ResourceKind,
		ResourceID:         placement.ResourceID,
		Generation:         placement.HighestGeneration,
		State:              placement.LifecycleState,
		RuntimeIdentity:    availabilityRuntimeIdentity(placement.RuntimeMetadata),
		HighestGeneration:  placement.HighestGeneration,
		LastIdempotencyKey: placement.LastIdempotencyKey,
		OperationID:        placement.OperationID,
		LifecycleState:     placement.LifecycleState,
		Tombstone:          placement.Tombstone,
		RuntimeMetadata:    cloneAvailabilityMetadata(placement.RuntimeMetadata),
		LastAction:         placement.LastAction,
		UpdatedAtUnixMs:    placement.UpdatedAtUnixMs,
	}
	data, err := json.Marshal(detail)
	if err != nil {
		return "", fmt.Errorf("encode availability state detail: %w", err)
	}
	return string(data), nil
}

func availabilityRuntimeIdentity(metadata map[string]any) map[string]any {
	for key, value := range metadata {
		if normalizeAvailabilityMetadataKey(key) != "runtimeidentity" {
			continue
		}
		if identity, ok := value.(map[string]any); ok {
			return cloneAvailabilityMetadata(identity)
		}
	}
	return cloneAvailabilityMetadata(metadata)
}
