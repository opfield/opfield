package docker

import (
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
		httptest.NewRequest(http.MethodPost, "/v1.47/containers/web/start", nil),
	} {
		if _, err := transport.RoundTrip(request); err != nil {
			t.Fatal(err)
		}
	}
	if ops.owns("", []string{"web"}, "") {
		t.Fatal("reads and starts must not claim the container")
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
		"name":                       "web",
		"net.opfield.deployment.id":  "d1",
		"wiolett.gateway.managed":    "true",
		"com.docker.compose.project": "shop",
		"org.example":                "x",
	})
	if len(labels) != 3 || labels["org.example"] != "" || labels["com.docker.compose.project"] != "shop" {
		t.Fatalf("labels = %v", labels)
	}
}
