package access

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/protobuf/proto"
)

// policyFile holds the last applied policy in the daemon's state directory.
const policyFile = "access-policy.pb"

// Store keeps the applied policy in memory and on disk: a restarted daemon answers from it before (or without)
// reaching Opfield.
type Store struct {
	path    string
	writeMu sync.Mutex
	current atomic.Pointer[Policy]
}

// OpenStore loads the policy the daemon applied last. A file that cannot be read or no longer validates leaves the
// store empty (every check answers 503 until Opfield syncs again) and is reported.
func OpenStore(stateDir string) (*Store, error) {
	store := &Store{path: filepath.Join(stateDir, policyFile)}
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return store, fmt.Errorf("read access policy: %w", err)
	}
	command := &pb.SyncAccessPolicyCommand{}
	if err := proto.Unmarshal(data, command); err != nil {
		return store, fmt.Errorf("decode access policy: %w", err)
	}
	policy, err := NewPolicy(command, time.Now())
	if err != nil {
		return store, fmt.Errorf("validate access policy: %w", err)
	}
	store.current.Store(policy)
	return store, nil
}

// Policy is the applied policy (nil: none yet).
func (s *Store) Policy() *Policy {
	if s == nil {
		return nil
	}
	return s.current.Load()
}

// HasList reports whether the applied policy has the list.
func (s *Store) HasList(id string) bool {
	_, ok := s.Policy().List(id)
	return ok
}

// Apply validates, persists and applies a command. A revision older than or equal to the applied one changes nothing
// (applied false).
func (s *Store) Apply(command *pb.SyncAccessPolicyCommand) (applied bool, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if current := s.current.Load(); current != nil && command != nil && command.Revision <= current.Revision {
		return false, nil
	}
	policy, err := NewPolicy(command, time.Now())
	if err != nil {
		return false, err
	}
	// Revoked sessions that expired are not kept on disk either.
	stored := proto.Clone(command).(*pb.SyncAccessPolicyCommand)
	stored.RevokedSessions = stored.RevokedSessions[:0]
	for _, session := range command.RevokedSessions {
		if _, kept := policy.revoked[session.SessionId]; kept {
			stored.RevokedSessions = append(stored.RevokedSessions, session)
		}
	}
	data, err := proto.MarshalOptions{Deterministic: true}.Marshal(stored)
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return false, err
	}
	// The file holds bcrypt hashes and service token digests: owner only.
	if err := atomicfile.WriteFile(s.path, data, 0o600); err != nil {
		return false, fmt.Errorf("persist access policy: %w", err)
	}
	s.current.Store(policy)
	return true, nil
}
