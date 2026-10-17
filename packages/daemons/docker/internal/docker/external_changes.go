package docker

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/events"
)

// Containers removed, created, renamed, stopped, killed, paused, resumed or
// updated by anything other than this daemon (a person or an agent with docker
// on the node's console, a script, another tool) are "changed outside
// Opfield": Opfield's records of a managed container (its access identity,
// Git source, links, availability placement, its intended state and limits)
// no longer match what runs. The daemon tells its own container operations
// apart from everyone else's and keeps the others for Opfield, which reads
// them with the external_changes container command and decides which concern
// managed containers.
//
// A container that exits on its own (a crash, an OOM kill) or that its
// restart policy restarts is not a change: only a stop, a kill signal that
// ended it, a pause, an unpause or an update sent to the Docker API count.
const (
	externalChangesCapability = "docker_external_changes_v1"
	// ownOperationGrace is how long after one of the daemon's own requests
	// ended a Docker event (by its own timestamp) still counts as the
	// daemon's. Docker emits a request's events before it answers it, so a
	// few seconds cover clock reads and slow event delivery; an outside
	// change right after the daemon's operation is still recorded.
	ownOperationGrace = 5 * time.Second
	// ownClaimRetention keeps a finished claim long enough to judge the
	// events that happened during it.
	ownClaimRetention = 2 * time.Minute
	// clockSlack allows for Docker stamping an event a little before the
	// daemon noted the start of the request that caused it.
	clockSlack = time.Second
	// externalChangeSettle lets the request that caused an event finish (and
	// record the ID a create returned) before the event is judged.
	externalChangeSettle = 3 * time.Second
	// externalStateSettle is how long a stop, kill or pause waits before it is
	// judged: when the Docker daemon itself shuts down it stops its
	// containers, and the event stream breaking within this time shows the
	// stop was Docker's own, not a change outside Opfield.
	externalStateSettle = 20 * time.Second
	// externalKillWindow is how long a kill signal may come before the exit
	// it caused (docker stop sends SIGKILL after its timeout).
	externalKillWindow  = 5 * time.Minute
	externalChangeLimit = 256
)

var (
	containerCreatePath = regexp.MustCompile(`^(?:/v[0-9.]+)?/containers/create$`)
	containerRefPath    = regexp.MustCompile(`^(?:/v[0-9.]+)?/containers/([^/]+)(?:/(rename|start|stop|kill|restart|pause|unpause|update))?$`)
	containerPrunePath  = regexp.MustCompile(`^(?:/v[0-9.]+)?/containers/prune$`)
)

// ownClaim is one of the daemon's own requests on a key: from its start
// until ownOperationGrace after it ended.
type ownClaim struct {
	from, until time.Time
}

// ownContainerOps records the containers and Compose projects the daemon is
// changing or changed, with when. A nil value records nothing and claims
// nothing.
type ownContainerOps struct {
	mu       sync.Mutex
	claims   map[string][]ownClaim
	inflight map[string][]time.Time
	now      func() time.Time
}

func newOwnContainerOps() *ownContainerOps {
	return &ownContainerOps{claims: map[string][]ownClaim{}, inflight: map[string][]time.Time{}, now: time.Now}
}

// begin marks keys as in use until the returned function is called; events
// stamped from now until ownOperationGrace after that call are the daemon's.
// more names keys learned from the answer (the ID a create returned).
func (o *ownContainerOps) begin(keys ...string) func(more ...string) {
	if o == nil {
		return func(...string) {}
	}
	o.mu.Lock()
	started := o.now()
	for _, key := range keys {
		o.inflight[key] = append(o.inflight[key], started)
	}
	o.mu.Unlock()
	return func(more ...string) {
		o.mu.Lock()
		defer o.mu.Unlock()
		claim := ownClaim{from: started, until: o.now().Add(ownOperationGrace)}
		for _, key := range keys {
			starts := o.inflight[key]
			for i, at := range starts {
				if at.Equal(started) {
					starts = append(starts[:i], starts[i+1:]...)
					break
				}
			}
			if len(starts) == 0 {
				delete(o.inflight, key)
			} else {
				o.inflight[key] = starts
			}
			o.claims[key] = append(o.claims[key], claim)
		}
		for _, key := range more {
			o.claims[key] = append(o.claims[key], claim)
		}
		o.prune()
	}
}

func (o *ownContainerOps) prune() {
	cutoff := o.now().Add(-ownClaimRetention)
	for key, claims := range o.claims {
		kept := claims[:0]
		for _, claim := range claims {
			if claim.until.After(cutoff) {
				kept = append(kept, claim)
			}
		}
		if len(kept) == 0 {
			delete(o.claims, key)
		} else {
			o.claims[key] = kept
		}
	}
}

// claimed reports whether an event stamped at was caused by one of the
// daemon's requests on key.
func (o *ownContainerOps) claimed(key string, at time.Time) bool {
	for _, started := range o.inflight[key] {
		if !at.Before(started.Add(-clockSlack)) {
			return true
		}
	}
	for _, claim := range o.claims[key] {
		if !at.Before(claim.from.Add(-clockSlack)) && !at.After(claim.until) {
			return true
		}
	}
	return false
}

func (o *ownContainerOps) keys() []string {
	keys := make([]string, 0, len(o.inflight)+len(o.claims))
	for key := range o.inflight {
		keys = append(keys, key)
	}
	for key := range o.claims {
		keys = append(keys, key)
	}
	return keys
}

// owns reports whether the daemon caused a change, happening now, of the
// container with this ID, name (or previous name) and Compose project.
func (o *ownContainerOps) owns(id string, names []string, project string) bool {
	if o == nil {
		return true
	}
	return o.ownsAt(id, names, project, o.now())
}

// ownsAt is owns for an event stamped at.
func (o *ownContainerOps) ownsAt(id string, names []string, project string, at time.Time) bool {
	if o == nil {
		return true
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.claimed("prune:", at) || (project != "" && o.claimed("project:"+project, at)) {
		return true
	}
	for _, name := range names {
		if name != "" && o.claimed("container:"+strings.TrimPrefix(name, "/"), at) {
			return true
		}
	}
	if id == "" {
		return false
	}
	for _, key := range o.keys() {
		if ref, ok := strings.CutPrefix(key, "container:"); ok && len(ref) >= 12 && strings.HasPrefix(id, ref) && o.claimed(key, at) {
			return true
		}
	}
	return false
}

// beginProject marks a Compose project the daemon's sidecar is changing.
func (o *ownContainerOps) beginProject(project string) func() {
	end := o.begin("project:" + project)
	return func() { end() }
}

// ownOpsTransport records the container creates, removals, renames, starts,
// stops, kills, restarts, pauses, unpauses, updates and prunes the daemon's
// Docker client sends.
type ownOpsTransport struct {
	base http.RoundTripper
	ops  *ownContainerOps
}

func (t *ownOpsTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	var keys []string
	create := false
	switch {
	case request.Method == http.MethodPost && containerCreatePath.MatchString(request.URL.Path):
		create = true
		if name := request.URL.Query().Get("name"); name != "" {
			keys = append(keys, "container:"+strings.TrimPrefix(name, "/"))
		}
	case request.Method == http.MethodPost && containerPrunePath.MatchString(request.URL.Path):
		keys = append(keys, "prune:")
	default:
		match := containerRefPath.FindStringSubmatch(request.URL.Path)
		if match == nil || match[1] == "create" || match[1] == "prune" || match[1] == "json" {
			return t.base.RoundTrip(request)
		}
		operation := match[2]
		if (operation != "" && request.Method != http.MethodPost) || (operation == "" && request.Method != http.MethodDelete) {
			return t.base.RoundTrip(request)
		}
		keys = append(keys, "container:"+match[1])
		if operation == "rename" {
			if name := request.URL.Query().Get("name"); name != "" {
				keys = append(keys, "container:"+strings.TrimPrefix(name, "/"))
			}
		}
	}
	end := t.ops.begin(keys...)
	response, err := t.base.RoundTrip(request)
	var created []string
	if create && err == nil && response.StatusCode == http.StatusCreated && response.Body != nil {
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		response.Body = io.NopCloser(bytes.NewReader(body))
		var document struct {
			ID string `json:"Id"`
		}
		if readErr == nil && json.Unmarshal(body, &document) == nil && document.ID != "" {
			created = append(created, "container:"+document.ID)
		}
	}
	end(created...)
	return response, err
}

// externalContainerChange is one container change Opfield did not make.
type externalContainerChange struct {
	Seq         uint64            `json:"seq"`
	At          time.Time         `json:"at"`
	Action      string            `json:"action"` // removed, created, renamed, stopped, killed, paused, unpaused or updated
	ContainerID string            `json:"containerId"`
	Name        string            `json:"name"`
	OldName     string            `json:"oldName,omitempty"`
	Image       string            `json:"image,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
}

// externalChangeLog keeps the latest changes for Opfield. It lives as long as
// the daemon process; bootID tells Opfield when a new process started over.
type externalChangeLog struct {
	mu      sync.Mutex
	bootID  string
	seq     uint64
	changes []externalContainerChange
}

func newExternalChangeLog() *externalChangeLog {
	return &externalChangeLog{bootID: time.Now().UTC().Format(time.RFC3339Nano)}
}

func (l *externalChangeLog) add(change externalContainerChange) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	change.Seq = l.seq
	l.changes = append(l.changes, change)
	if len(l.changes) > externalChangeLimit {
		l.changes = append([]externalContainerChange(nil), l.changes[len(l.changes)-externalChangeLimit:]...)
	}
}

type externalChangesPage struct {
	BootID  string                    `json:"bootId"`
	Latest  uint64                    `json:"latest"`
	Changes []externalContainerChange `json:"changes"`
}

func (l *externalChangeLog) since(after uint64) externalChangesPage {
	if l == nil {
		return externalChangesPage{Changes: []externalContainerChange{}}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	page := externalChangesPage{BootID: l.bootID, Latest: l.seq, Changes: []externalContainerChange{}}
	for _, change := range l.changes {
		if change.Seq > after {
			page.Changes = append(page.Changes, change)
		}
	}
	return page
}

// reportedLabels keeps the labels that tell Opfield which managed object a
// container was: its own and the Compose project's.
func reportedLabels(attributes map[string]string) map[string]string {
	labels := map[string]string{}
	for key, value := range attributes {
		if strings.HasPrefix(key, labelPrefix) || isLegacyLabelKey(key) || key == "com.docker.compose.project" || key == "com.docker.compose.service" {
			labels[key] = value
		}
	}
	if len(labels) == 0 {
		return nil
	}
	return labels
}

// containerSignals remembers the recent stops and kill signals per container,
// to tell a kill that ended a container (docker kill) from a stop (whose own
// kill signals come first) and from an exit nobody caused.
type containerSignals struct {
	mu    sync.Mutex
	kills map[string]time.Time
	stops map[string]time.Time
}

func (s *containerSignals) note(kind, id string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.kills == nil {
		s.kills, s.stops = map[string]time.Time{}, map[string]time.Time{}
	}
	target := s.kills
	if kind == "stop" {
		target = s.stops
	}
	target[id] = at
	for key, seen := range target {
		if at.Sub(seen) > externalKillWindow {
			delete(target, key)
		}
	}
}

// killThatEnded is the kill signal that made a container exit at exitAt, or
// zero: none came in externalKillWindow, or a stop followed (the stop is
// recorded instead).
func (s *containerSignals) killThatEnded(id string, exitAt time.Time) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if stop, ok := s.stops[id]; ok && !stop.Before(exitAt.Add(-clockSlack)) {
		return time.Time{}
	}
	kill, ok := s.kills[id]
	if !ok || kill.After(exitAt.Add(clockSlack)) || exitAt.Sub(kill) > externalKillWindow {
		return time.Time{}
	}
	return kill
}

// eventTime is when Docker stamped the event (now when it carries none).
func eventTime(message events.Message) time.Time {
	if message.TimeNano > 0 {
		return time.Unix(0, message.TimeNano)
	}
	if message.Time > 0 {
		return time.Unix(message.Time, 0)
	}
	return time.Now()
}

// observeExternalChange judges one container event once the request behind it
// had time to finish.
func (p *DockerPlugin) observeExternalChange(message events.Message) {
	if p.externalChanges == nil || p.client == nil || p.client.ownOps == nil {
		return
	}
	at := eventTime(message)
	settle := externalChangeSettle
	var action string
	switch message.Action {
	case events.ActionDestroy:
		action = "removed"
	case events.ActionCreate:
		action = "created"
	case events.ActionRename:
		action = "renamed"
	case events.ActionStop:
		p.containerSignals.note("stop", message.Actor.ID, at)
		action, settle = "stopped", externalStateSettle
	case events.ActionKill:
		// Judged with the exit it causes (die); a kill the container survives
		// (a reload signal) is no change.
		p.containerSignals.note("kill", message.Actor.ID, at)
		return
	case events.ActionDie:
		action, settle = "killed", externalStateSettle
	case events.ActionPause:
		action, settle = "paused", externalStateSettle
	case events.ActionUnPause:
		action = "unpaused"
	case events.ActionUpdate:
		action = "updated"
	default:
		return
	}
	attributes := message.Actor.Attributes
	change := externalContainerChange{
		At:          at.UTC(),
		Action:      action,
		ContainerID: message.Actor.ID,
		Name:        strings.TrimPrefix(attributes["name"], "/"),
		OldName:     strings.TrimPrefix(attributes["oldName"], "/"),
		Image:       attributes["image"],
		Labels:      reportedLabels(attributes),
	}
	project := attributes["com.docker.compose.project"]
	generation := p.containerEventsGeneration.Load()
	time.AfterFunc(settle, func() {
		judgedAt := at
		if action == "killed" {
			// An exit is a change only when a kill signal sent through the API
			// ended it; the daemon's own kill is judged by the signal's time.
			kill := p.containerSignals.killThatEnded(change.ContainerID, at)
			if kill.IsZero() {
				return
			}
			judgedAt = kill
		}
		if settle == externalStateSettle && p.containerEventsGeneration.Load() != generation {
			// The event stream broke: the Docker daemon stopped (and stopped
			// its containers) or restarted, which is not a container change.
			return
		}
		if p.client.ownOps.ownsAt(change.ContainerID, []string{change.Name, change.OldName}, project, judgedAt) {
			return
		}
		p.externalChanges.add(change)
		p.logger.Warn("container changed outside Opfield", "action", change.Action, "container", change.Name, "id", change.ContainerID)
		p.requestHealthRefresh()
	})
}
