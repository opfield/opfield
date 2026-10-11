package relaybridge

import (
	"errors"
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

	// A demoted relay still takes the opens no other relay took (a lone relay
	// is never left out), but only at a bounded rate for what it refused:
	// each traffic class it refuses as a whole (hard pressure, database
	// reserve), or each route it refused for its fair share, goes to it at
	// most once per demotedProbeInterval; the other such opens count as its
	// refusal without reaching it (HoldDemoted). The retry loops of new
	// connections and of streams re-pathing after a policy change otherwise
	// sent it hundreds of opens it could only refuse (stand 2.12 R-3). The
	// probes that do reach it find out when it admits again.
	demotedProbeInterval = time.Second
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
	// classes is the traffic class (proxy, registry, database) of each route
	// a relay refused for its pressure, as the refusal named it.
	classes map[string]string
	// probes is when a demoted relay may take the next open of a class (or
	// fair-share route) it refused (HoldDemoted).
	probes map[penaltyKey]time.Time
}

type penaltyKey struct{ relay, route string }

type relayPenalty struct {
	until  time.Time
	length time.Duration
	// Demotions only: state is the admission state of the relay's latest
	// refusal, refused the traffic classes it refused since the demotion
	// started.
	state   string
	refused map[string]bool
}

// heldOpenError is HoldDemoted's answer: the open counts as the demoted
// relay's admission refusal without reaching it. It carries the refusal's
// status, so every caller handles it as the relay's own refusal.
type heldOpenError struct{ status *status.Status }

func (e *heldOpenError) Error() string              { return e.status.Err().Error() }
func (e *heldOpenError) GRPCStatus() *status.Status { return e.status }

// Opened records how relayID answered an open of route and logs a relay that
// starts or stops refusing for its admission pressure. A success forgets the
// route's failures there and the relay's demotion; an admission-pressure
// refusal demotes the relay for every route; another failure that tells about
// the relay's path to the route (PenalizesRelay) penalizes the route there.
//
// A route of a traffic class the relay was not refusing (a database tunnel
// while it reserves its capacity for databases) opening there says nothing
// about its pressure and keeps the demotion, as does a route whose class is
// not known yet while the demotion runs: the paced probes of what it refused
// (HoldDemoted) tell when it admits again. An open HoldDemoted held back
// records nothing.
func (p *RelayPenalties) Opened(logger *slog.Logger, relayID, route string, err error) {
	if p == nil || relayID == "" {
		return
	}
	if held := (*heldOpenError)(nil); errors.As(err, &held) {
		return
	}
	if err == nil {
		p.Succeeded(relayID, route)
		if p.admitted(relayID, route) && logger != nil {
			logger.Info("relay admits new tunnels again", "relay_instance_id", relayID)
		}
		return
	}
	if state, ok := admissionPressureState(err); ok {
		length, changed := p.demote(relayID, route, admissionRefusalClass(err), state)
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

// demote demotes relayID after an admission-pressure refusal of route (of
// traffic class, in admission state) and reports the demotion's length and
// whether it started or grew. A refusal while the relay is demoted already
// (opens in flight, a relay that is the only candidate) does not lengthen
// it. The refusal starts the wait before the next open of its class (or
// fair-share route) goes to the relay (HoldDemoted).
func (p *RelayPenalties) demote(relayID, route, class, state string) (time.Duration, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	entry := p.demoted[relayID]
	changed := true
	switch {
	case entry == nil:
		if p.demoted == nil {
			p.demoted = map[string]*relayPenalty{}
		}
		entry = &relayPenalty{length: demotionInitial}
		p.demoted[relayID] = entry
	case now.Before(entry.until):
		changed = false
	default:
		entry.length = min(entry.length*2, demotionMax)
		entry.refused = nil
	}
	if changed {
		entry.until = now.Add(entry.length)
	}
	entry.state = state
	if class != "" && route != "" {
		if entry.refused == nil {
			entry.refused = map[string]bool{}
		}
		entry.refused[class] = true
		if p.classes == nil || len(p.classes) >= penaltyEntries {
			p.classes = map[string]string{}
		}
		p.classes[route] = class
		p.armProbeLocked(probeKey(relayID, route, class, state), now)
	}
	return entry.length, changed
}

// admitted handles an open of route that relayID admitted and reports whether
// it ended the relay's demotion: an open of a class the relay refused while
// demoted, or any open once the demotion ran out. A class it did not refuse
// (a database tunnel while it reserves capacity for databases), or a route
// whose class is unknown while the demotion runs, keeps it.
func (p *RelayPenalties) admitted(relayID, route string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.demoted[relayID]
	if entry == nil {
		return false
	}
	class, known := p.classes[route]
	switch {
	case known && entry.refused[class]:
	case known:
		return false
	case p.clock().Before(entry.until):
		return false
	}
	delete(p.demoted, relayID)
	for key := range p.probes {
		if key.relay == relayID {
			delete(p.probes, key)
		}
	}
	return true
}

// HoldDemoted returns the refusal to count for an open of route on relayID
// without sending it there, or nil when it may go. Only a relay demoted for
// its admission pressure holds opens back, and only of a traffic class it
// refused (a fair-share refusal: of a route it refused): one such open goes
// to it per demotedProbeInterval, so a demoted relay that is the last (or
// only) candidate of retrying connections and moving streams is probed at a
// bounded rate instead of taking every retry. Opens it does not refuse (a
// database tunnel while it reserves capacity for databases) always go.
// Callers ask right before they open a tunnel on the relay and pass the
// returned error to Opened like the relay's own answer.
func (p *RelayPenalties) HoldDemoted(relayID, route string) error {
	if p == nil || relayID == "" || route == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	entry := p.demoted[relayID]
	if entry == nil || !now.Before(entry.until) {
		return nil
	}
	class, known := p.classes[route]
	if !known || !entry.refused[class] {
		return nil
	}
	key := probeKey(relayID, route, class, entry.state)
	if next, ok := p.probes[key]; ok && now.Before(next) {
		return &heldOpenError{status: status.New(codes.ResourceExhausted, admissionRefusal+class+" tunnel: "+entry.state)}
	}
	p.armProbeLocked(key, now)
	return nil
}

// probeKey is what HoldDemoted paces for a route of class on a relay in
// admission state: the class as a whole, or the route itself while the relay
// refuses by fair share (which refuses some routes and admits others).
func probeKey(relayID, route, class, state string) penaltyKey {
	if state == "fair_share" {
		return penaltyKey{relay: relayID, route: "route:" + route}
	}
	return penaltyKey{relay: relayID, route: "class:" + class}
}

func (p *RelayPenalties) armProbeLocked(key penaltyKey, now time.Time) {
	if p.probes == nil {
		p.probes = map[penaltyKey]time.Time{}
	}
	if len(p.probes) >= penaltyEntries {
		for stale, next := range p.probes {
			if !now.Before(next) {
				delete(p.probes, stale)
			}
		}
		if len(p.probes) >= penaltyEntries {
			return
		}
	}
	p.probes[key] = now.Add(demotedProbeInterval)
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

// admissionRefusalClass is the traffic class an admission-pressure refusal
// names ("relay adaptive admission rejected <class> tunnel: <state>"), or "".
func admissionRefusalClass(err error) string {
	current, ok := status.FromError(err)
	if !ok {
		return ""
	}
	message := current.Message()
	at := strings.Index(message, admissionRefusal)
	if at < 0 {
		return ""
	}
	class, _, found := strings.Cut(message[at+len(admissionRefusal):], " tunnel: ")
	if !found {
		return ""
	}
	switch class {
	case "proxy", "registry", "database":
		return class
	}
	return ""
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
