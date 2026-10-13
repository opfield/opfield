package memberha

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// MemberState is what the runtime keeps about a member across restarts.
type MemberState struct {
	// Assignment is a manual pair's latest primary assignment.
	Assignment Assignment `json:"assignment"`
	// SelfFenced is the generation under which this member, as the manual
	// primary, demoted itself (it reached neither Gateway nor its peer); 0
	// when it did not. It serves again under that generation once it reaches
	// either and no newer assignment exists.
	SelfFenced uint64 `json:"selfFenced,omitempty"`
	// Stopped: Gateway removes the member; it stays stopped.
	Stopped bool `json:"stopped,omitempty"`
	// Held: this member held the primary role of the set's lease at least
	// once (a detach before the first holder is refused afterwards, H2).
	Held bool `json:"held,omitempty"`
	// Detached: a detach before the first holder began (H2); the member
	// takes no lease role any more until the daemon forgets it.
	Detached *DetachState `json:"detached,omitempty"`
	// Restart is a restart Gateway asked for (settings that need one, M4);
	// cleared once it ran.
	Restart *RestartRequest `json:"restart,omitempty"`
	// RestartDone is the operation id of the last restart that finished, so a
	// repeat of it is accepted without restarting again.
	RestartDone string `json:"restartDone,omitempty"`
	// NextEvent and Events are the durable event queue (decision 18).
	NextEvent uint64  `json:"nextEvent"`
	Events    []Event `json:"events,omitempty"`
}

type storedMember struct {
	Version int         `json:"v"`
	Config  Config      `json:"config"`
	State   MemberState `json:"state"`
}

// Store keeps one file per set under dir (written atomically, fsynced).
type Store struct {
	dir string
}

// NewStore creates dir if needed.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("availability member state directory: %w", err)
	}
	return &Store{dir: dir}, nil
}

func (s *Store) path(setID string) string { return filepath.Join(s.dir, setID+".json") }

// Save persists a member before the runtime acts on its new state.
func (s *Store) Save(config Config, state MemberState) error {
	data, err := json.Marshal(storedMember{Version: 1, Config: config, State: state})
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(s.path(config.SetID), data, 0o600)
}

// Delete removes a member's file.
func (s *Store) Delete(setID string) error {
	err := os.Remove(s.path(setID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// LoadAll reads every member; unreadable files are reported and skipped.
func (s *Store) LoadAll() (map[string]storedMember, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	out := map[string]storedMember{}
	var problems []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(s.dir, name))
		var stored storedMember
		if readErr == nil {
			readErr = json.Unmarshal(data, &stored)
		}
		if readErr == nil {
			readErr = stored.Config.Validate()
		}
		if readErr != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", name, readErr))
			continue
		}
		out[stored.Config.SetID] = stored
	}
	if len(problems) > 0 {
		return out, errors.New(strings.Join(problems, "; "))
	}
	return out, nil
}

// Event kinds reported to Gateway (audit availability.*) and kept on disk
// until Gateway acknowledges them.
const (
	EventPromoted        = "promoted"
	EventFenced          = "fenced"
	EventUnownedPrimary  = "unowned_primary_stopped"
	EventRejoined        = "rejoined"
	EventRejoinFailed    = "rejoin_failed"
	EventHealthRestart   = "health_restart"
	EventHealthRelease   = "health_release"
	EventHealthAlert     = "health_alert"
	EventDiskAlert       = "disk_alert"
	EventSwitchover      = "switchover"
	EventSwitchoverFail  = "switchover_failed"
	EventSelfFenced      = "self_fenced"
	EventSelfFenceEnded  = "self_fence_ended"
	EventSteppedDown     = "stepped_down"
	EventCertified       = "state_certified"
	EventRetainedOnClose = "retained"
	// Added with the engine extensions (extensions.go).
	EventAssignmentLearned = "assignment_learned"
	EventForceArmed        = "forced_promotion_armed"
	EventDetached          = "detached"
	EventRestarted         = "restarted"
	EventRestartFailed     = "restart_failed"
)

// maxEvents bounds the unacknowledged events kept per member.
const maxEvents = 256

// Event is one autonomous transition of a member, with the time it happened.
type Event struct {
	Seq         uint64            `json:"seq"`
	Kind        string            `json:"kind"`
	AtUnixMs    int64             `json:"at"`
	Reason      string            `json:"reason,omitempty"`
	OperationID string            `json:"op,omitempty"`
	Detail      map[string]string `json:"detail,omitempty"`
}

// addEvent appends an event to the durable queue; the caller saves.
func (s *MemberState) addEvent(at time.Time, event Event) Event {
	s.NextEvent++
	event.Seq = s.NextEvent
	if event.AtUnixMs == 0 {
		// Engine events carry the time they happened.
		event.AtUnixMs = at.UnixMilli()
	}
	s.Events = append(s.Events, event)
	if len(s.Events) > maxEvents {
		s.Events = s.Events[len(s.Events)-maxEvents:]
	}
	return event
}

// ackEvents drops events up to seq; reports whether anything changed.
func (s *MemberState) ackEvents(seq uint64) bool {
	kept := s.Events[:0]
	for _, event := range s.Events {
		if event.Seq > seq {
			kept = append(kept, event)
		}
	}
	changed := len(kept) != len(s.Events)
	s.Events = kept
	return changed
}
