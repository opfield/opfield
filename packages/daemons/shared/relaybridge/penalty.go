package relaybridge

import (
	"log/slog"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	// A relay that failed to open a route's tunnel is tried after the others
	// of its role for penaltyInitial; each further failure once that ran out
	// doubles it, up to penaltyMax. A success forgets it.
	penaltyInitial = 10 * time.Second
	penaltyMax     = 2 * time.Minute
	// penaltyEntries bounds the remembered failures of a daemon.
	penaltyEntries = 4096

	// A relay that refused a tunnel for its admission pressure is tried after
	// every other connected relay, for any route, for demotionInitial; a
	// refusal on the first open after that ran out doubles it, up to
	// demotionMax. Its first successful open forgets it.
	demotionInitial = 30 * time.Second
	demotionMax     = 5 * time.Minute
)

// admissionRefusal is the relay's message for an admission-pressure refusal:
// "relay adaptive admission rejected <class> tunnel: <state>"
// (relay/internal/admission Rejected).
const admissionRefusal = "relay adaptive admission rejected "

// RelayPenalties remembers relays that recently failed to open a source
// tunnel for a route: one whose lane is up but that refuses or never answers
// for this route (the target not registered there, a stale policy, a hung
// accept) would otherwise stay first for every new connection, each paying a
// failed attempt before the next relay. A penalized relay is only tried later,
// never left out: a lone relay is still tried. The zero value is ready to use.
type RelayPenalties struct {
	mu sync.Mutex
	// now replaces time.Now when set (tests).
	now     func() time.Time
	entries map[penaltyKey]*relayPenalty
	// demoted holds the relays that refused a tunnel for their admission
	// pressure (Opened), per relay: the pressure is the relay's, not a route's.
	demoted map[string]*relayPenalty
}

type penaltyKey struct{ relay, route string }

type relayPenalty struct {
	until  time.Time
	length time.Duration
}

// Opened records how relayID answered an open of route and logs a relay that
// starts or stops refusing for its admission pressure. A success forgets the
// route's failures there and the relay's demotion; an admission-pressure
// refusal demotes the relay for every route; another failure that tells about
// the relay's path to the route (PenalizesRelay) penalizes the route there.
func (p *RelayPenalties) Opened(logger *slog.Logger, relayID, route string, err error) {
	if p == nil || relayID == "" {
		return
	}
	if err == nil {
		p.Succeeded(relayID, route)
		if p.forgetDemotion(relayID) && logger != nil {
			logger.Info("relay admits new tunnels again", "relay_instance_id", relayID)
		}
		return
	}
	if state, ok := admissionPressureState(err); ok {
		length, changed := p.demote(relayID)
		if !changed || logger == nil {
			return
		}
		message := "relay refuses new tunnels under load; new tunnels try other relays first"
		if length > demotionInitial {
			message = "relay still refuses new tunnels under load; new tunnels try other relays first"
		}
		logger.Warn(message, "relay_instance_id", relayID, "admission_state", state, "for", length.String())
		return
	}
	if PenalizesRelay(err) {
		p.Failed(relayID, route)
	}
}

// demote demotes relayID after an admission-pressure refusal and reports the
// demotion's length and whether it started or grew. A refusal while the relay
// is demoted already (opens in flight, a relay that is the only candidate)
// does not lengthen it.
func (p *RelayPenalties) demote(relayID string) (time.Duration, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	entry := p.demoted[relayID]
	switch {
	case entry == nil:
		if p.demoted == nil {
			p.demoted = map[string]*relayPenalty{}
		}
		entry = &relayPenalty{length: demotionInitial}
		p.demoted[relayID] = entry
	case now.Before(entry.until):
		return entry.length, false
	default:
		entry.length = min(entry.length*2, demotionMax)
	}
	entry.until = now.Add(entry.length)
	return entry.length, true
}

// forgetDemotion forgets relayID's demotion and reports whether it had one.
func (p *RelayPenalties) forgetDemotion(relayID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.demoted[relayID] == nil {
		return false
	}
	delete(p.demoted, relayID)
	return true
}

// Demoted reports a relay to try after every other connected relay: it
// refused a tunnel for its admission pressure recently (Opened).
func (p *RelayPenalties) Demoted(relayID string) bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.demoted[relayID]
	return entry != nil && p.clock().Before(entry.until)
}

// admissionPressureState is the admission state of a relay's refusal for its
// pressure (hard_pressure, database_reserve, fair_share). A session-cap
// refusal and any other error are not one.
func admissionPressureState(err error) (string, bool) {
	current, ok := status.FromError(err)
	if !ok || current.Code() != codes.ResourceExhausted {
		return "", false
	}
	message := current.Message()
	at := strings.Index(message, admissionRefusal)
	if at < 0 {
		return "", false
	}
	_, state, found := strings.Cut(message[at:], " tunnel: ")
	if !found {
		return "", false
	}
	switch state {
	case "hard_pressure", "database_reserve", "fair_share":
		return state, true
	}
	return "", false
}

func (p *RelayPenalties) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// Failed records a failed open of route on relay. Failures while the relay is
// penalized already (concurrent connections) do not lengthen it.
func (p *RelayPenalties) Failed(relayID, route string) {
	if p == nil || relayID == "" || route == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	key := penaltyKey{relay: relayID, route: route}
	entry := p.entries[key]
	switch {
	case entry == nil || now.Sub(entry.until) > penaltyMax:
		if p.entries == nil {
			p.entries = map[penaltyKey]*relayPenalty{}
		}
		if len(p.entries) >= penaltyEntries {
			for stale, old := range p.entries {
				if now.Sub(old.until) > 0 {
					delete(p.entries, stale)
				}
			}
			if len(p.entries) >= penaltyEntries {
				return
			}
		}
		entry = &relayPenalty{length: penaltyInitial}
		p.entries[key] = entry
	case now.Before(entry.until):
		return
	default:
		entry.length = min(entry.length*2, penaltyMax)
	}
	entry.until = now.Add(entry.length)
}

// Succeeded forgets the failures of route on relay.
func (p *RelayPenalties) Succeeded(relayID, route string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) > 0 {
		delete(p.entries, penaltyKey{relay: relayID, route: route})
	}
}

// Penalized reports a relay to try after the others for route.
func (p *RelayPenalties) Penalized(relayID, route string) bool {
	if p == nil || route == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.entries[penaltyKey{relay: relayID, route: route}]
	return entry != nil && p.clock().Before(entry.until)
}

// PenalizesRelay reports an open failure that tells about the relay's path to
// the route, unlike a capacity refusal: the route's or endpoint's session
// limit is the same on every relay. An admission-pressure refusal demotes the
// relay instead (Opened).
func PenalizesRelay(err error) bool {
	return err != nil && status.Code(err) != codes.ResourceExhausted
}
