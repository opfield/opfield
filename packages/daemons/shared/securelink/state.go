package securelink

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/statecompat"
	"google.golang.org/protobuf/proto"
)

type StateStore struct {
	committed statecompat.File
	pending   statecompat.File
	mu        sync.RWMutex
	current   *pb.SyncProxySecureLinksCommand
}

// NewStateStore opens the committed restart snapshot. Both it and the
// pending marker are kept twice (statecompat, B-10): proxy-secure-links.json
// and proxy-secure-links.pending.json only hold what v2.10.0 knows, without
// dormant availability members, which a daemon that predates the lease must
// never serve; the .full.json copies hold everything.
func NewStateStore(stateDir string) (*StateStore, error) {
	store := &StateStore{
		committed: stateFile(stateDir, "proxy-secure-links"),
		pending:   stateFile(stateDir, "proxy-secure-links.pending"),
		current:   &pb.SyncProxySecureLinksCommand{},
	}
	command := &pb.SyncProxySecureLinksCommand{}
	found, err := store.committed.Read(command)
	if err != nil {
		return nil, fmt.Errorf("decode proxy secure-link state: %w", err)
	}
	if found {
		store.current = command
	}
	return store, nil
}

func stateFile(stateDir, name string) statecompat.File {
	return statecompat.File{
		Legacy: filepath.Join(stateDir, name+".json"),
		Full:   filepath.Join(stateDir, name+".full.json"),
		Prune:  pruneDormantMembers,
	}
}

// pruneDormantMembers drops dormant availability members from the copy older
// daemons read: they know no dormant flag and would serve them. Opfield never
// sends them a dormant member either.
func pruneDormantMembers(message proto.Message) {
	command, ok := message.(*pb.SyncProxySecureLinksCommand)
	if !ok {
		return
	}
	kept := command.Bindings[:0]
	for _, binding := range command.Bindings {
		if !binding.GetDormant() {
			kept = append(kept, binding)
		}
	}
	command.Bindings = kept
}

func (s *StateStore) Save(command *pb.SyncProxySecureLinksCommand) error {
	return s.saveCommitted(command, false)
}

// Stage durably records an accepted command before live connector mutation.
// It deliberately does not replace the committed restart snapshot.
func (s *StateStore) Stage(command *pb.SyncProxySecureLinksCommand) error {
	if command == nil {
		return errors.New("proxy secure-link state is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending.Write(command)
}

// Commit makes a fully applied command eligible for restart recovery and
// clears any interrupted-apply marker.
func (s *StateStore) Commit(command *pb.SyncProxySecureLinksCommand) error {
	return s.saveCommitted(command, true)
}

func (s *StateStore) saveCommitted(command *pb.SyncProxySecureLinksCommand, clearPending bool) error {
	if command == nil {
		return errors.New("proxy secure-link state is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.committed.Write(command); err != nil {
		return err
	}
	s.current = proto.Clone(command).(*pb.SyncProxySecureLinksCommand)
	if clearPending {
		// Once the committed snapshot is durably renamed, the operation is
		// accepted. A stale pending marker is harmless and will be retried on
		// the next commit/startup; reporting failure here could make the caller
		// roll back even though restart recovery already points at this command.
		_ = s.pending.Remove()
	}
	return nil
}

func (s *StateStore) HasPending() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pending.Exists(&pb.SyncProxySecureLinksCommand{})
}

func (s *StateStore) Pending() (*pb.SyncProxySecureLinksCommand, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	command := &pb.SyncProxySecureLinksCommand{}
	found, err := s.pending.Read(command)
	if err != nil {
		return nil, true, fmt.Errorf("decode pending proxy secure-link state: %w", err)
	}
	if !found {
		return nil, false, nil
	}
	return command, true, nil
}

func (s *StateStore) DiscardPending() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending.Remove()
}

func (s *StateStore) Get() *pb.SyncProxySecureLinksCommand {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return proto.Clone(s.current).(*pb.SyncProxySecureLinksCommand)
}

// Binding returns a copy of the binding of linkID in role, or nil. Unlike Get
// it copies one binding, not the whole set: it runs per relayed connection.
func (s *StateStore) Binding(linkID, role string) *pb.ProxySecureLinkBinding {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, binding := range s.current.GetBindings() {
		if binding.GetLinkId() == linkID && binding.GetRole() == role {
			return proto.Clone(binding).(*pb.ProxySecureLinkBinding)
		}
	}
	return nil
}

// SetSourceConfigManaged durably records whether restart recovery owns the
// generated Nginx proxy_pass for one source binding. It returns the previous
// value and whether the binding currently exists.
func (s *StateStore) SetSourceConfigManaged(linkID string, managed bool) (bool, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := proto.Clone(s.current).(*pb.SyncProxySecureLinksCommand)
	for _, binding := range next.Bindings {
		if binding.LinkId != linkID || binding.Role != "source" {
			continue
		}
		previous := binding.SourceConfigManaged
		if previous == managed {
			return previous, true, nil
		}
		binding.SourceConfigManaged = managed
		if err := s.committed.Write(next); err != nil {
			return previous, true, err
		}
		s.current = next
		return previous, true, nil
	}
	return false, false, nil
}
