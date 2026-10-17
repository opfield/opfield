package docker

import (
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type recordingRoundTripper struct {
	status int
	body   string
}

func (r recordingRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: r.status, Body: io.NopCloser(strings.NewReader(r.body)), Request: request, Header: http.Header{}}, nil
}

func ownOpsAt(now *time.Time) *ownContainerOps {
	ops := newOwnContainerOps()
	ops.now = func() time.Time { return *now }
	return ops
}

func TestOwnOpsTransportClaimsTheDaemonsContainerChanges(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ops := ownOpsAt(&now)
	id := "4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b"
	create := &ownOpsTransport{base: recordingRoundTripper{status: http.StatusCreated, body: `{"Id":"` + id + `"}`}, ops: ops}
	response, err := create.RoundTrip(httptest.NewRequest(http.MethodPost, "/v1.47/containers/create?name=web-recreate-1", nil))
	if err != nil {
		t.Fatal(err)
	}
	if body, _ := io.ReadAll(response.Body); !strings.Contains(string(body), id) {
		t.Fatalf("create response body was not kept: %q", body)
	}
	remove := &ownOpsTransport{base: recordingRoundTripper{status: http.StatusNoContent}, ops: ops}
	if _, err := remove.RoundTrip(httptest.NewRequest(http.MethodDelete, "/v1.47/containers/web?force=1", nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := remove.RoundTrip(httptest.NewRequest(http.MethodPost, "/v1.47/containers/"+id[:12]+"/rename?name=web", nil)); err != nil {
		t.Fatal(err)
	}

	if !ops.owns(id, []string{"web-recreate-1"}, "") {
		t.Fatal("the container the daemon created is not its own")
	}
	if !ops.owns("0123456789ab0123", []string{"web"}, "") {
		t.Fatal("the container the daemon removed by name is not its own")
	}
	if ops.owns("feedfacecafe0000", []string{"other"}, "") {
		t.Fatal("a container the daemon never touched counts as its own")
	}
	now = now.Add(ownOperationGrace + time.Second)
	if ops.owns(id, []string{"web"}, "") {
		t.Fatal("the daemon's claim outlived its grace period")
	}
}

func TestOwnOpsTransportPassesOtherRequestsThrough(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ops := ownOpsAt(&now)
	transport := &ownOpsTransport{base: recordingRoundTripper{status: http.StatusOK, body: "[]"}, ops: ops}
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/v1.47/containers/json?all=1", nil),
		httptest.NewRequest(http.MethodGet, "/v1.47/containers/web/json", nil),
		httptest.NewRequest(http.MethodGet, "/v1.47/containers/web/logs", nil),
		httptest.NewRequest(http.MethodPost, "/v1.47/containers/web/exec", nil),
	} {
		if _, err := transport.RoundTrip(request); err != nil {
			t.Fatal(err)
		}
	}
	if ops.owns("", []string{"web"}, "") {
		t.Fatal("reads and execs must not claim the container")
	}
}

// The daemon's own stops, kills, pauses and updates are its own; the same
// operations by anyone else are not.
func TestOwnOpsTransportClaimsStateChanges(t *testing.T) {
	for _, operation := range []string{"start", "stop", "kill", "restart", "pause", "unpause", "update"} {
		now := time.Unix(1_700_000_000, 0)
		ops := ownOpsAt(&now)
		transport := &ownOpsTransport{base: recordingRoundTripper{status: http.StatusNoContent}, ops: ops}
		if _, err := transport.RoundTrip(httptest.NewRequest(http.MethodPost, "/v1.47/containers/web/"+operation, nil)); err != nil {
			t.Fatal(err)
		}
		if !ops.owns("", []string{"web"}, "") {
			t.Fatalf("the daemon's own %s is not its own", operation)
		}
		if ops.owns("", []string{"db"}, "") {
			t.Fatalf("a %s of web claims db", operation)
		}
	}
}

// An outside change soon after one of the daemon's own operations on the same
// container is still recorded: only events stamped during the daemon's request
// (and a few seconds after it) are the daemon's (rc.3 GO-4: a rename 97 s
// after Opfield created the container was ignored).
func TestOwnOpsClaimCoversOnlyTheRequestsEvents(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ops := ownOpsAt(&now)
	created := now
	transport := &ownOpsTransport{base: recordingRoundTripper{status: http.StatusCreated, body: `{"Id":"4f3c2b1a0e9d8c7b6a5f4e3d"}`}, ops: ops}
	if _, err := transport.RoundTrip(httptest.NewRequest(http.MethodPost, "/v1.47/containers/create?name=web", nil)); err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	if !ops.ownsAt("4f3c2b1a0e9d8c7b6a5f4e3d", []string{"web"}, "", created) {
		t.Fatal("the create event of the daemon's own request, judged later, is not its own")
	}
	if ops.ownsAt("4f3c2b1a0e9d8c7b6a5f4e3d", []string{"web"}, "", now) {
		t.Fatal("a change 30 s after the daemon's create is taken for the daemon's")
	}
	if ops.ownsAt("4f3c2b1a0e9d8c7b6a5f4e3d", []string{"web"}, "", created.Add(-time.Minute)) {
		t.Fatal("a change before the daemon's request is taken for the daemon's")
	}
}

func TestContainerSignalsTellKillsFromStopsAndExits(t *testing.T) {
	var signals containerSignals
	at := time.Unix(1_700_000_000, 0)
	// docker kill: kill, then die.
	signals.note("kill", "a", at)
	if got := signals.killThatEnded("a", at.Add(50*time.Millisecond)); !got.Equal(at) {
		t.Fatalf("docker kill: kill = %v", got)
	}
	// docker stop: kill (SIGTERM), die, stop: the stop is recorded instead.
	signals.note("kill", "b", at)
	signals.note("stop", "b", at.Add(60*time.Millisecond))
	if got := signals.killThatEnded("b", at.Add(50*time.Millisecond)); !got.IsZero() {
		t.Fatalf("docker stop counted as a kill: %v", got)
	}
	// A crash: die without a kill signal.
	if got := signals.killThatEnded("c", at); !got.IsZero() {
		t.Fatalf("an exit nobody caused counted as a kill: %v", got)
	}
	// A kill long before the exit did not cause it.
	signals.note("kill", "d", at)
	if got := signals.killThatEnded("d", at.Add(externalKillWindow+time.Minute)); !got.IsZero() {
		t.Fatalf("an old kill signal counted: %v", got)
	}
}

func TestOwnOpsComposeProjectAndPrune(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ops := ownOpsAt(&now)
	done := ops.beginProject("shop")
	if !ops.owns("", []string{"shop-api-1"}, "shop") {
		t.Fatal("a running compose operation does not claim its project's containers")
	}
	done()
	now = now.Add(ownOperationGrace + time.Second)
	if ops.owns("", []string{"shop-api-1"}, "shop") {
		t.Fatal("the compose claim outlived its grace period")
	}
	prune := &ownOpsTransport{base: recordingRoundTripper{status: http.StatusOK, body: "{}"}, ops: ops}
	if _, err := prune.RoundTrip(httptest.NewRequest(http.MethodPost, "/v1.47/containers/prune", nil)); err != nil {
		t.Fatal(err)
	}
	if !ops.owns("", []string{"anything"}, "") {
		t.Fatal("a prune by the daemon does not claim the containers it removes")
	}
	var nilOps *ownContainerOps
	if !nilOps.owns("", []string{"web"}, "") {
		t.Fatal("without a ledger nothing may be reported as changed outside Opfield")
	}
}

func TestExternalChangeLogPagesAfterACursor(t *testing.T) {
	log := newExternalChangeLog()
	for i := 0; i < externalChangeLimit+5; i++ {
		log.add(externalContainerChange{Action: "removed", Name: "web"})
	}
	page := log.since(0)
	if len(page.Changes) != externalChangeLimit || page.Latest != uint64(externalChangeLimit+5) {
		t.Fatalf("page has %d changes, latest %d", len(page.Changes), page.Latest)
	}
	if next := log.since(page.Latest - 1); len(next.Changes) != 1 || next.Changes[0].Seq != page.Latest {
		t.Fatalf("cursor page = %+v", next.Changes)
	}
	var none *externalChangeLog
	if empty := none.since(0); empty.Changes == nil || len(empty.Changes) != 0 {
		t.Fatal("a daemon without a change log answers an empty list")
	}
}

func TestReportedLabelsKeepOpfieldAndComposeKeys(t *testing.T) {
	labels := reportedLabels(map[string]string{
		"name":                               "web",
		"net.opfield.deployment.id":          "d1",
		legacycompat.LabelPrefix + "managed": "true",
		"com.docker.compose.project":         "shop",
		"org.example":                        "x",
	})
	if len(labels) != 3 || labels["org.example"] != "" || labels["com.docker.compose.project"] != "shop" {
		t.Fatalf("labels = %v", labels)
	}
}
