package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/atomicfile"
	"github.com/wiolett-industries/gateway/daemon-shared/witnessactivation"
)

// Standby witness activation while Gateway is down (decision 8 of the
// availability plan). A staged standby Keeper witness does not run; the
// supervisor listens on its relay-local raft port instead. The set's lease
// holder reaches that port over its witness route and sends an activation
// request (a holder statement, daemon-shared/witnessactivation). The relay
// worker checks that the committed holder of the set's lease policy signed it
// (VerifyHolderStatement); the request must name this very standby, its set
// and the policy of the spec Gateway applied. The supervisor then runs the
// standby as an active witness (on the same port) until Gateway applies a set
// that makes it active itself or removes it; the activation is kept on disk.

// holderVerifier asks the relay worker to check a holder statement.
type holderVerifier func(ctx context.Context, policyID string, slot uint32, domain string, payload, signature []byte) (string, error)

const activationReadTimeout = 10 * time.Second

func (m *witnessManager) activatedPath() string { return filepath.Join(m.dir, "activated.json") }

// loadActivations restores standby witnesses activated before a restart.
func (m *witnessManager) loadActivations() {
	data, err := os.ReadFile(m.activatedPath())
	if err != nil {
		return
	}
	var ids []string
	if json.Unmarshal(data, &ids) != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range ids {
		m.activated[id] = true
	}
}

func (m *witnessManager) saveActivationsLocked() error {
	ids := make([]string, 0, len(m.activated))
	for id := range m.activated {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	data, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return err
	}
	return atomicfile.WriteFile(m.activatedPath(), data, 0o600)
}

// pruneActivationsLocked forgets activations Gateway caught up with: the
// witness is active in the desired set, or no longer in it.
func (m *witnessManager) pruneActivationsLocked() {
	changed := false
	for id := range m.activated {
		spec := m.desired[id]
		if spec == nil || spec.GetRole() != witnessRoleStandby {
			delete(m.activated, id)
			changed = true
		}
	}
	if changed {
		if err := m.saveActivationsLocked(); err != nil {
			m.logWarn("witness activation state could not be saved", "error", err)
		}
	}
}

// effectiveRole is the role a witness runs with here.
func (m *witnessManager) effectiveRoleLocked(id, role string) string {
	if role == witnessRoleStandby && m.activated[id] {
		return witnessRoleActive
	}
	return role
}

// ensureActivationListener listens on a staged standby's raft port.
func (m *witnessManager) ensureActivationListener(id string, raftPort uint32) {
	m.mu.Lock()
	if m.verify == nil {
		m.mu.Unlock()
		return
	}
	if existing := m.activations[id]; existing != nil {
		if existing.port == raftPort {
			m.mu.Unlock()
			return
		}
		_ = existing.listener.Close()
		delete(m.activations, id)
	}
	m.mu.Unlock()
	listener, err := m.listen("tcp", net.JoinHostPort("127.0.0.1", strconv.FormatUint(uint64(raftPort), 10)))
	if err != nil {
		m.logWarn("standby witness activation listener could not start", "witness", id, "error", err)
		return
	}
	m.mu.Lock()
	m.activations[id] = &activationListener{listener: listener, port: raftPort}
	m.mu.Unlock()
	go m.serveActivations(id, listener)
}

func (m *witnessManager) closeActivationListener(id string) {
	m.mu.Lock()
	existing := m.activations[id]
	delete(m.activations, id)
	m.mu.Unlock()
	if existing != nil {
		_ = existing.listener.Close()
	}
}

func (m *witnessManager) closeActivationListeners() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.activations))
	for id := range m.activations {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.closeActivationListener(id)
	}
}

type activationListener struct {
	listener net.Listener
	port     uint32
}

func (m *witnessManager) serveActivations(id string, listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		go m.serveActivation(id, connection)
	}
}

func (m *witnessManager) serveActivation(id string, connection net.Conn) {
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(activationReadTimeout))
	var request witnessactivation.Request
	if err := witnessactivation.Read(connection, &request); err != nil {
		// Raft traffic of a member that still lists this standby: not a request.
		return
	}
	response := witnessactivation.Response{OK: true}
	if err := m.activate(id, request); err != nil {
		response = witnessactivation.Response{Error: err.Error()}
		m.logWarn("standby witness activation refused", "witness", id, "error", err)
	}
	_ = witnessactivation.Write(connection, response)
}

// activate checks an activation request for standby id and marks it active.
func (m *witnessManager) activate(id string, request witnessactivation.Request) error {
	if err := request.Validate(m.now()); err != nil {
		return err
	}
	m.mu.Lock()
	spec := m.desired[id]
	verify := m.verify
	m.mu.Unlock()
	switch {
	case spec == nil || spec.GetRole() != witnessRoleStandby:
		return errors.New("this relay holds no such standby witness")
	case request.WitnessID != id:
		return errors.New("the request names another witness")
	case request.SetID != spec.GetSetId() || spec.GetLeasePolicyId() == "" || request.LeasePolicyID != spec.GetLeasePolicyId():
		return errors.New("the request names another set or lease policy than the standby's")
	case verify == nil:
		return errors.New("this relay cannot verify holder statements")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	holder, err := verify(ctx, request.LeasePolicyID, 0, witnessactivation.Domain, request.Payload(), request.Signature)
	if err != nil {
		return fmt.Errorf("the holder statement was not accepted: %w", err)
	}
	if holder != request.HolderNodeID {
		return errors.New("the request was signed by another holder than it names")
	}
	m.mu.Lock()
	already := m.activated[id]
	m.activated[id] = true
	err = m.saveActivationsLocked()
	m.mu.Unlock()
	if err != nil {
		return fmt.Errorf("persist the activation: %w", err)
	}
	if !already && m.logger != nil {
		m.logger.Warn("standby witness activated by the set's lease holder (Opfield is down)", "witness", id,
			"set", request.SetID, "holder", holder)
	}
	m.kick()
	return nil
}
