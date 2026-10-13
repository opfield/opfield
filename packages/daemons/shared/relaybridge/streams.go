package relaybridge

import (
	"math/rand/v2"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// Where resumable relay streams (RSv1) belong. Both daemons that open them
// (docker links and nginx Secure Links) decide with these helpers, so a stream
// never leaves a relay that stays in its route's assignment, and streams on a
// standby or farther relay find their way back to the nearest one.

// StreamAction is what a resumable stream does after its route's assignment
// changed.
type StreamAction int

const (
	// StreamStays: the stream's path is still assigned.
	StreamStays StreamAction = iota
	// StreamRegrants: the stream's relay stays in the assignment, but the
	// generation its grant belongs to is gone (or drains with a deadline: the
	// relay keeps serving only its built-in local services through a drain).
	// The stream re-paths onto the same relay under the new grant (or a better
	// relay, if one is).
	StreamRegrants
	// StreamLeaves: the relay leaves the assignment, or drains as a whole.
	StreamLeaves
)

// RegrantSpread is how long re-paths of one bundle are spread over when the
// generation they leave has no drain deadline (a placement change).
const RegrantSpread = 5 * time.Second

// PlaceStream decides what a stream on relayID, opened with a grant of
// generation (0 when unknown), does under assignment, and by when (zero: no
// deadline).
func PlaceStream(assignment *pb.RelayGrantAssignment, relayID string, generation uint64) (StreamAction, time.Time) {
	candidates := PreparedCandidates(assignment)
	if relayID == "" || len(candidates) == 0 {
		// A route without pool candidates (legacy grants) has nowhere else to go.
		return StreamStays, time.Time{}
	}
	var own *pb.RelayDataCandidate
	stays := false
	var deadline time.Time
	for _, candidate := range candidates {
		if candidate.GetRelayInstanceId() != relayID {
			continue
		}
		state := candidate.GetAssignmentState()
		if state == "active" || state == "staging" {
			stays = true
		}
		if generation != 0 && candidate.GetAssignmentGeneration() == generation {
			own = candidate
		}
		if ms := candidate.GetDrainDeadlineUnixMs(); state == "draining" && ms > 0 {
			if at := time.UnixMilli(ms); deadline.IsZero() || at.Before(deadline) {
				deadline = at
			}
		}
	}
	switch {
	case own != nil && own.GetAssignmentState() != "draining":
		return StreamStays, time.Time{}
	case stays && generation == 0:
		// The path's generation is unknown: a relay that stays keeps it.
		return StreamStays, time.Time{}
	case stays && own != nil && own.GetDrainDeadlineUnixMs() == 0:
		// Placement drained the generation and the relay serves the new one:
		// the stream stays on its path. The relay keeps a draining
		// generation's tunnels, and Gateway retires a generation only once no
		// tunnel uses it. Re-pathing every stream onto the same relay under the
		// new grant moved all of them whenever a relay joined or left the
		// assignment, also one that carried none of them (stand 2.12 R-5, N-2).
		return StreamStays, time.Time{}
	case stays:
		if own != nil && own.GetDrainDeadlineUnixMs() > 0 {
			return StreamRegrants, time.UnixMilli(own.GetDrainDeadlineUnixMs())
		}
		return StreamRegrants, time.Time{}
	default:
		return StreamLeaves, deadline
	}
}

// RelayStays reports a relay that serves the assignment in an active or
// staging generation: streams through it have no reason to leave it.
func RelayStays(assignment *pb.RelayGrantAssignment, relayID string) bool {
	for _, candidate := range PreparedCandidates(assignment) {
		if candidate.GetRelayInstanceId() != relayID {
			continue
		}
		if state := candidate.GetAssignmentState(); state == "active" || state == "staging" {
			return true
		}
	}
	return false
}

const (
	// A stream returns from a farther relay of its role only when its cost is
	// beyond this band of the nearest relay's: wider than the band new tunnels
	// share (costBand), so relays near that band's edge never trade streams.
	returnBandRatio = 1.5
	returnBandFloor = 10 * time.Millisecond
)

func returnBand(nearest time.Duration) time.Duration {
	band := time.Duration(float64(nearest) * returnBandRatio)
	if floor := nearest + returnBandFloor; floor > band {
		return floor
	}
	return band
}

// ReturnTarget is the relay a resumable stream on currentRelayID should move
// back to, if any. candidates are the route's active candidates; transports
// should count a relay as available only once it has been connected and
// stable for a while, so a relay that just came back takes nothing yet.
//
// The target is the nearest available relay (OrderCandidates' first) when it
// stands clearly better than the current one: a primary while the stream is
// on a standby, or a relay of the same role measured nearer by more than the
// return band, or measured while the current relay's distance is unknown.
// Relays of one cost tier never trade streams: load alone moves nothing.
func ReturnTarget(candidates []*pb.RelayDataCandidate, transports map[string]TransportLoad, rtt func(string) (time.Duration, bool), currentRelayID string) (string, bool) {
	assigned := false
	for _, candidate := range candidates {
		if candidate.GetRelayInstanceId() == currentRelayID {
			assigned = true
			break
		}
	}
	if !assigned || len(candidates) < 2 {
		return "", false
	}
	places := placeCandidates(candidates, transports, rtt)
	current := places[currentRelayID]
	if !current.available {
		// The stream's own relay is down: its path failure moves it.
		return "", false
	}
	var best *pb.RelayDataCandidate
	for _, candidate := range OrderCandidates(candidates, transports, 0, rtt) {
		if places[candidate.GetRelayInstanceId()].available && !transports[candidate.GetRelayInstanceId()].Penalized {
			best = candidate
			break
		}
	}
	if best == nil || best.GetRelayInstanceId() == currentRelayID {
		return "", false
	}
	target := places[best.GetRelayInstanceId()]
	switch {
	case target.role < current.role:
		return best.GetRelayInstanceId(), true
	case target.role > current.role || !target.known:
		return "", false
	case !current.known:
		return best.GetRelayInstanceId(), true
	case current.cost > returnBand(target.cost):
		return best.GetRelayInstanceId(), true
	}
	return "", false
}

// ReturnStableFor is how long a relay must have been connected without a
// break before streams return to it: a relay that just came back (or keeps
// flapping) takes nothing until it proved itself. A return is a planned move
// (the stream stays where it is when the new path does not open), so a short
// proof is enough; a minute kept streams on a relay up to 300 ms away for that
// long after every local relay restart (stand rc.7, F-3).
var ReturnStableFor = 20 * time.Second

// RelayStability remembers since when each relay has been connected without a
// break. The zero value is ready to use.
type RelayStability struct {
	mu    sync.Mutex
	now   func() time.Time
	since map[string]time.Time
}

func (s *RelayStability) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// Observe records whether the relay is connected now: a connected relay
// keeps the start of its streak, one that is not loses it.
func (s *RelayStability) Observe(relayID string, connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.since == nil {
		s.since = map[string]time.Time{}
	}
	if !connected {
		delete(s.since, relayID)
		return
	}
	if _, ok := s.since[relayID]; !ok {
		s.since[relayID] = s.clock()
	}
}

// Broke ends the relay's streak: one of its lanes left the connected state.
func (s *RelayStability) Broke(relayID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.since, relayID)
}

// Stable reports a relay connected without a break for at least d.
func (s *RelayStability) Stable(relayID string, d time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	since, ok := s.since[relayID]
	return ok && s.clock().Sub(since) >= d
}

// Forget drops the relays keep refuses (no longer targets).
func (s *RelayStability) Forget(keep func(relayID string) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.since {
		if !keep(id) {
			delete(s.since, id)
		}
	}
}

// StableTransports is transports for ReturnTarget: a relay counts as
// available only once it has been stable for ReturnStableFor, except the
// stream's own relay, which counts as available while it is connected.
func StableTransports(transports map[string]TransportLoad, stability *RelayStability, currentRelayID string) map[string]TransportLoad {
	result := make(map[string]TransportLoad, len(transports))
	for id, load := range transports {
		if id != currentRelayID && load.Available && !stability.Stable(id, ReturnStableFor) {
			load.Available = false
		}
		result[id] = load
	}
	return result
}

// RegrantAt is when one re-path of a bundle starts: spread over RegrantSpread,
// or over the first half of the time left before deadline when that is
// shorter, so a generation change does not move every stream at once.
func RegrantAt(deadline time.Time) time.Time {
	now := time.Now()
	spread := RegrantSpread
	if !deadline.IsZero() {
		if half := deadline.Sub(now) / 2; half < spread {
			spread = half
		}
	}
	if spread <= 0 {
		return now
	}
	return now.Add(time.Duration(rand.Int64N(int64(spread))))
}
