package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Every visitor of every route can read the health path: it answers the status alone, never the node's details.
func TestIngressHealthAnswersTheStatusAlone(t *testing.T) {
	responder := &ingressHealthResponder{inputs: func(now time.Time) ingressHealthInputs {
		return ingressHealthInputs{nginxRunning: true, expected: 7, served: 7, servedKnown: true, secureLinkSources: 2, usableTransports: 1, now: now}
	}}
	recorder := httptest.NewRecorder()
	responder.serveHealth(recorder, httptest.NewRequest(http.MethodGet, "/.well-known/opfield-ingress-health", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 1 || body["status"] != "serving" {
		t.Fatalf("body = %v, want only the status", body)
	}
}
