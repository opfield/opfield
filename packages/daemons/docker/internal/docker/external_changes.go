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

// Containers removed, created or renamed by anything other than this daemon
// (a person or an agent with docker on the node's console) are "changed
// outside Opfield": Opfield's records of a managed container (its access
// identity, Git source, links, availability placement) no longer match what
// runs. The daemon tells its own container operations apart from everyone
// else's and keeps the others for Opfield, which reads them with the
// external_changes container command and decides which concern managed
// containers.
const (
	externalChangesCapability = "docker_external_changes_v1"
	// ownOperationGrace is how long after one of the daemon's own requests
	// its Docker events still count as the daemon's.
	ownOperationGrace = 2 * time.Minute
	// externalChangeSettle lets the request that caused an event finish (and
	// record the ID a create returned) before the event is judged.
	externalChangeSettle = 3 * time.Second
	externalChangeLimit  = 256
)

var (
	containerCreatePath = regexp.MustCompile(`^(?:/v[0-9.]+)?/containers/create$`)
	containerRefPath    = regexp.MustCompile(`^(?:/v[0-9.]+)?/containers/([^/]+)(/rename)?$`)
	containerPrunePath  = regexp.MustCompile(`^(?:/v[0-9.]+)?/containers/prune$`)
)

// ownContainerOps records the containers and Compose projects the daemon is
// changing or changed within ownOperationGrace. A nil value records nothing
// and claims nothing.
type ownContainerOps struct {
	mu       sync.Mutex
	refs     map[string]time.Time
	inflight map[string]int
	now      func() time.Time
}

func newOwnContainerOps() *ownContainerOps {
	return &ownContainerOps{refs: map[string]time.Time{}, inflight: map[string]int{}, now: time.Now}
}

// begin marks keys as in use until the returned function is called; they
// then stay the daemon's for ownOperationGrace.
func (o *ownContainerOps) begin(keys ...string) func(more ...string) {
	if o == nil {
		return func(...string) {}
	}
	o.mu.Lock()
	for _, key := range keys {
		o.inflight[key]++
	}
	o.mu.Unlock()
	return func(more ...string) {
		o.mu.Lock()
		defer o.mu.Unlock()
		until := o.now().Add(ownOperationGrace)
		for _, key := range keys {
			if o.inflight[key]--; o.inflight[key] <= 0 {
				delete(o.inflight, key)
			}
			o.refs[key] = until
		}
		for _, key := range more {
			o.refs[key] = until
		}
		o.prune()
	}
}

func (o *ownContainerOps) prune() {
	now := o.now()
	for key, until := range o.refs {
		if now.After(until) {
			delete(o.refs, key)
		}
	}
}

func (o *ownContainerOps) claimed(key string) bool {
	if _, ok := o.inflight[key]; ok {
		return true
	}
	until, ok := o.refs[key]
	return ok && !o.now().After(until)
}

// owns reports whether the daemon caused a change of the container with
// this ID, name (or previous name) and Compose project.
func (o *ownContainerOps) owns(id string, names []string, project string) bool {
	if o == nil {
		return true
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.claimed("prune:") || (project != "" && o.claimed("project:"+project)) {
		return true
	}
	for _, name := range names {
		if name != "" && o.claimed("container:"+strings.TrimPrefix(name, "/")) {
			return true
		}
	}
	if id == "" {
		return false
	}
	for key := range o.inflight {
		if ref, ok := strings.CutPrefix(key, "container:"); ok && len(ref) >= 12 && strings.HasPrefix(id, ref) {
			return true
		}
	}
	for key := range o.refs {
		if ref, ok := strings.CutPrefix(key, "container:"); ok && len(ref) >= 12 && strings.HasPrefix(id, ref) && o.claimed(key) {
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

// ownOpsTransport records the container creates, removals, renames and
// prunes the daemon's Docker client sends.
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
		rename := match[2] != ""
		if (rename && request.Method != http.MethodPost) || (!rename && request.Method != http.MethodDelete) {
			return t.base.RoundTrip(request)
		}
		keys = append(keys, "container:"+match[1])
		if rename {
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
	Action      string            `json:"action"` // removed, created or renamed
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

// observeExternalChange judges one container event once the request behind it
// had time to finish.
func (p *DockerPlugin) observeExternalChange(message events.Message) {
	if p.externalChanges == nil || p.client == nil || p.client.ownOps == nil {
		return
	}
	var action string
	switch message.Action {
	case events.ActionDestroy:
		action = "removed"
	case events.ActionCreate:
		action = "created"
	case events.ActionRename:
		action = "renamed"
	default:
		return
	}
	attributes := message.Actor.Attributes
	change := externalContainerChange{
		At:          time.Now().UTC(),
		Action:      action,
		ContainerID: message.Actor.ID,
		Name:        strings.TrimPrefix(attributes["name"], "/"),
		OldName:     strings.TrimPrefix(attributes["oldName"], "/"),
		Image:       attributes["image"],
		Labels:      reportedLabels(attributes),
	}
	project := attributes["com.docker.compose.project"]
	time.AfterFunc(externalChangeSettle, func() {
		if p.client.ownOps.owns(change.ContainerID, []string{change.Name, change.OldName}, project) {
			return
		}
		p.externalChanges.add(change)
		p.logger.Warn("container changed outside Opfield", "action", change.Action, "container", change.Name, "id", change.ContainerID)
		p.requestHealthRefresh()
	})
}
