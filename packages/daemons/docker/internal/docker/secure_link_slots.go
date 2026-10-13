package docker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/securelink"
)

// A connector slot (secureLinkConnectorSlots) is free for a new connector when it is empty or holds a connector that
// carries no session: a leftover, or one whose retirement passed its deadline. A connector still finishing its
// sessions keeps its slot (the rc.1 stand lost 4 container link sessions to a second replacement that took the slot of
// the connector still retiring with them). A replacement never waits for a slot: when both other slots hold one, the
// connector whose retirement ends first goes with its sessions, and the log says how many.

// secureLinkConnectorSessionsWait bounds the question to a connector about to be removed how many sessions it carries.
const secureLinkConnectorSessionsWait = 2 * time.Second

// carriesSessionsLocked reports a connector that may still carry sessions: one being retired before its deadline, or
// the replaced one that keeps accepting until every egress listens on its replacement (pendingRetire).
func (m *dockerSecureLinkManager) carriesSessionsLocked(id string, now time.Time) bool {
	if m.pendingRetire != nil && m.pendingRetire.id == id {
		return true
	}
	until, ok := m.retiring.deadline(id)
	return ok && now.Before(until)
}

// replacementSlotLocked picks the slot a replacement of the connector serving in slot starts in, with the connector to
// remove from it (nil: empty): the first other slot that is free, else the one whose connector's retirement ends first
// (retiring: that connector still finishes sessions, which go with it).
func (m *dockerSecureLinkManager) replacementSlotLocked(ctx context.Context, serving int) (int, *container.InspectResponse, bool, error) {
	now := time.Now()
	var refused error
	var oldest *container.InspectResponse
	oldestSlot, oldestUntil := -1, time.Time{}
	for slot, candidate := range secureLinkConnectorSlots {
		if slot == serving {
			continue
		}
		inspected, err := m.plugin.client.cli.ContainerInspect(ctx, candidate.name, mobyclient.ContainerInspectOptions{})
		if isNotFoundErr(err) {
			return slot, nil, false, nil
		}
		if err != nil {
			return 0, nil, false, fmt.Errorf("inspect secure-link connector %s: %w", candidate.name, err)
		}
		if !managedSecureLinkConnector(inspected.Container, m.controlDirectory()) {
			refused = fmt.Errorf("refusing to remove non-managed container %s", candidate.name)
			continue
		}
		if m.carriesSessionsLocked(inspected.Container.ID, now) {
			if until := m.retirementEndLocked(inspected.Container.ID); oldest == nil || until.Before(oldestUntil) {
				oldest, oldestSlot, oldestUntil = &inspected.Container, slot, until
			}
			continue
		}
		return slot, &inspected.Container, false, nil
	}
	if oldest != nil {
		return oldestSlot, oldest, true, nil
	}
	if refused == nil {
		refused = errors.New("no free secure-link connector slot")
	}
	return 0, nil, false, refused
}

// retirementEndLocked is when a connector that carries sessions is removed at the latest: its recorded deadline, or,
// for the replaced connector that keeps accepting until every egress listens on its successor (pendingRetire), the
// retire limit from its replacement.
func (m *dockerSecureLinkManager) retirementEndLocked(id string) time.Time {
	if until, ok := m.retiring.deadline(id); ok {
		return until
	}
	if m.pendingRetire != nil && m.pendingRetire.id == id {
		return m.pendingRetireSince.Add(secureLinkConnectorRetireLimit)
	}
	return time.Time{}
}

// oldestRetiringSlotLocked returns the slot of the connector among the retiring ones in found whose retirement ends
// first (-1: none of this node's).
func (m *dockerSecureLinkManager) oldestRetiringSlotLocked(found [len(secureLinkConnectorSlots)]*container.InspectResponse, retiring [len(secureLinkConnectorSlots)]bool) int {
	oldest, oldestUntil := -1, time.Time{}
	for slot, inspect := range found {
		if inspect == nil || !retiring[slot] || !ownedSecureLinkConnector(*inspect) {
			continue
		}
		if until := m.retirementEndLocked(inspect.ID); oldest < 0 || until.Before(oldestUntil) {
			oldest, oldestUntil = slot, until
		}
	}
	return oldest
}

// cutOldestRetirementLocked removes the retiring connector in slot, the one whose retirement ends first, to make room
// for a new connector, and logs how many sessions that cut.
func (m *dockerSecureLinkManager) cutOldestRetirementLocked(ctx context.Context, inspect container.InspectResponse, slot int) error {
	sessions, err := m.cutConnectorLocked(ctx, inspect, slot)
	if err != nil {
		return err
	}
	if m.plugin.logger != nil {
		m.plugin.logger.Warn("every secure-link connector slot holds a connector finishing its sessions; the oldest was removed for a new one",
			"connector", inspect.ID, "sessions_cut", sessions, "slots", len(secureLinkConnectorSlots))
	}
	return nil
}

// cutConnectorLocked removes the connector in slot to free the slot and returns how many sessions it still carried.
// It first hands its sessions to the serving connector where both can (secure_link_handover.go): those are not cut.
func (m *dockerSecureLinkManager) cutConnectorLocked(ctx context.Context, inspect container.InspectResponse, slot int) (int, error) {
	socketPath := m.adoptedControlSocket(m.slotSocketPath(slot))
	occupant := connectorRuntime{id: inspect.ID, slot: slot, socketPath: socketPath}
	if successor, socket, ok, _ := m.handoverSuccessorLocked(occupant); ok && inspect.State != nil && inspect.State.Running {
		var state connectorHandover
		m.handOverConnector(occupant, successor, socket, &state)
	}
	sessions := m.connectorSessions(inspect.ID, socketPath)
	err := m.dropConnectorLocked(ctx, inspect.ID)
	if err == nil {
		m.plugin.recordConnectorCut(sessions)
	}
	return sessions, err
}

// dropConnectorLocked removes a connector container and forgets its retirement.
func (m *dockerSecureLinkManager) dropConnectorLocked(ctx context.Context, id string) error {
	// Its retirement, if any, must not tell the slot's next connector to drain.
	m.retiring.stop(id)
	if err := m.removeConnectorContainer(ctx, id); err != nil {
		return err
	}
	if m.pendingRetire != nil && m.pendingRetire.id == id {
		m.clearPendingRetireLocked()
	}
	if err := m.retiring.forget(id); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not record the removal of a retiring secure-link connector", "error", err)
	}
	return nil
}

// settleLeftoverLocked deals with a connector found next to the one to serve that has no retirement record: the one a
// replacement kept accepting until every egress listened on its successor (pendingRetire, which the replaced record
// keeps across a daemon restart), or one an interrupted replacement left. It is told to drain; with sessions it
// retires in its slot (kept) and finishes them, by the recorded deadline (the retire limit from its replacement) or
// else a fresh one; without any, or when it does not answer, it goes at once.
func (m *dockerSecureLinkManager) settleLeftoverLocked(ctx context.Context, inspect container.InspectResponse, slot int) (kept bool, err error) {
	socketPath := m.adoptedControlSocket(m.slotSocketPath(slot))
	drainCtx, cancel := context.WithTimeout(ctx, secureLinkConnectorSessionsWait)
	active, drainErr := securelink.Drain(drainCtx, socketPath)
	cancel()
	if drainErr == nil && active > 0 {
		if m.plugin.logger != nil {
			m.plugin.logger.Info("a secure-link connector found next to the serving one finishes its sessions before it goes",
				"connector", inspect.ID, "sessions", active)
		}
		until, recorded := m.replaced.deadline(inspect.ID)
		if !recorded {
			until = time.Now().Add(secureLinkConnectorRetireLimit)
		}
		m.retireConnectorUntil(connectorRuntime{id: inspect.ID, slot: slot, socketPath: socketPath}, until)
		return true, nil
	}
	if drainErr != nil && inspect.State != nil && inspect.State.Running && m.plugin.logger != nil {
		m.plugin.logger.Info("a leftover secure-link connector did not answer its drain request and is removed", "connector", inspect.ID, "error", drainErr)
	}
	return false, m.dropConnectorLocked(ctx, inspect.ID)
}

// connectorSessions is how many sessions a connector carries: its own count (a drain request answers it; the
// connector drains already or is removed next), else the tunnels this daemon tracks through it.
func (m *dockerSecureLinkManager) connectorSessions(id, socketPath string) int {
	tracked := m.plugin.proxyTunnels.count(func(connection *drainConn) bool { return connectionConnector(connection) == id })
	ctx, cancel := context.WithTimeout(context.Background(), secureLinkConnectorSessionsWait)
	defer cancel()
	if active, err := securelink.Drain(ctx, socketPath); err == nil {
		return max(active, tracked)
	}
	return tracked
}
