package daemon

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sync"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/statecompat"
	"google.golang.org/protobuf/proto"
)

type relayGrantStore struct {
	file    statecompat.File
	writeMu sync.Mutex
	mu      sync.RWMutex
	current *pb.SyncRelayGrantsCommand
	// index maps current's assignments (nil: lookups scan current).
	index   map[relaybridge.AssignmentKey]*pb.RelayGrantAssignment
	changed chan struct{}
}

// relay-grants.json is what every daemon since v2.10.0 reads at start and
// only holds the fields v2.10.0 knows; relay-grants.full.json holds the whole
// bundle (statecompat, B-10: a node rolled back to an older binary must
// start).
func newRelayGrantStore(stateDir string) (*relayGrantStore, error) {
	store := &relayGrantStore{
		file:    statecompat.File{Legacy: filepath.Join(stateDir, "relay-grants.json"), Full: filepath.Join(stateDir, "relay-grants.full.json")},
		current: &pb.SyncRelayGrantsCommand{}, changed: make(chan struct{}, 1),
	}
	command := &pb.SyncRelayGrantsCommand{}
	found, err := store.file.Read(command)
	if err != nil {
		return nil, fmt.Errorf("decode relay grants: %w", err)
	}
	if found {
		store.current, store.index = command, relaybridge.IndexAssignments(command)
	}
	return store, nil
}

func (s *relayGrantStore) sync(command *pb.SyncRelayGrantsCommand) error {
	if command == nil {
		return errors.New("relay grant bundle is required")
	}
	// writeMu orders the syncs; mu is held only to read and to swap the bundle, so the lookups of new connections
	// never wait for the state file's fsyncs.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.RLock()
	current := s.current
	s.mu.RUnlock()
	if command.PolicyRevision < current.PolicyRevision ||
		(command.PolicyRevision == current.PolicyRevision && command.GeneratedAtUnixMs < current.GeneratedAtUnixMs) {
		return errors.New("stale relay grant bundle")
	}
	if proto.Equal(command, current) {
		return nil
	}
	if err := s.file.Write(command); err != nil {
		return err
	}
	runtimeChanged := current.GetDataLanes() != command.GetDataLanes() ||
		!reflect.DeepEqual(relaybridge.RequiredTargets(current), relaybridge.RequiredTargets(command))
	next := proto.Clone(command).(*pb.SyncRelayGrantsCommand)
	index := relaybridge.IndexAssignments(next)
	s.mu.Lock()
	s.current, s.index = next, index
	s.mu.Unlock()
	if runtimeChanged {
		select {
		case s.changed <- struct{}{}:
		default:
		}
	}
	return nil
}

func (s *relayGrantStore) get() *pb.SyncRelayGrantsCommand {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return proto.Clone(s.current).(*pb.SyncRelayGrantsCommand)
}

// lookup returns a copy of one assignment of the current bundle. It runs for
// every Secure Link connection, so it copies only that assignment, never the
// whole bundle (B-22).
func (s *relayGrantStore) lookup(role, ownerKind, ownerID string) *pb.RelayGrantAssignment {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var assignment *pb.RelayGrantAssignment
	if s.index != nil {
		assignment = s.index[relaybridge.AssignmentKey{Role: role, OwnerKind: ownerKind, OwnerID: ownerID}]
	} else {
		assignment = findRelayAssignment(s.current, role, ownerKind, ownerID)
	}
	if assignment == nil {
		return nil
	}
	return proto.Clone(assignment).(*pb.RelayGrantAssignment)
}

// readChunkBytes is the bundle's relay read chunk size.
func (s *relayGrantStore) readChunkBytes() uint32 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current.GetReadChunkBytes()
}

func findRelayAssignment(bundle *pb.SyncRelayGrantsCommand, role, ownerKind, ownerID string) *pb.RelayGrantAssignment {
	for _, assignment := range bundle.Grants {
		if assignment.Role == role && assignment.OwnerKind == ownerKind && assignment.OwnerId == ownerID {
			return assignment
		}
	}
	return nil
}

var _ lifecycle.RelayLatencyTargetPlugin = (*NginxPlugin)(nil)

// RelayLatencyTargets names every pool relay for the lifecycle's latency probes.
func (p *NginxPlugin) RelayLatencyTargets() []lifecycle.RelayTunnelTarget {
	targets := relaybridge.LatencyTargets(p.relayGrants.get())
	result := make([]lifecycle.RelayTunnelTarget, 0, len(targets))
	for _, target := range targets {
		result = append(result, lifecycle.RelayTunnelTarget{ID: target.ID, Addresses: relaybridge.TargetAddresses(target)})
	}
	return result
}
