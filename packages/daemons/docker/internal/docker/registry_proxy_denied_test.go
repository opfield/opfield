package docker

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// rc.3 stand R-O-7: pulling a build image the node holds no grant for answered "503 Service Unavailable", which reads
// as an outage. It is a refusal: 403 with a registry DENIED error.
func TestRegistryProxyRefusesARepositoryWithoutGrant(t *testing.T) {
	manager := &dockerRegistryProxyManager{bindings: map[string]*registryProxyBinding{
		"own": {
			id:         "own",
			repository: "gateway/builds/own",
			actions:    map[string]struct{}{"pull": {}},
			expiresAt:  time.Now().Add(time.Second),
		},
	}}

	recorder := httptest.NewRecorder()
	manager.serveHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/gateway/builds/other/manifests/sha256:abc", nil))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	var body struct {
		Errors []struct{ Code, Message string } `json:"errors"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || len(body.Errors) != 1 || body.Errors[0].Code != "DENIED" ||
		!strings.Contains(body.Errors[0].Message, "no pull grant for gateway/builds/other") {
		t.Fatalf("body = %s (%v)", recorder.Body.String(), err)
	}

	// The node holds the grant, but it is about to be renewed: wait for authorization, not a refusal.
	recorder = httptest.NewRecorder()
	manager.serveHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v2/gateway/builds/own/manifests/sha256:abc", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expiring grant: status = %d, want 503", recorder.Code)
	}
}
