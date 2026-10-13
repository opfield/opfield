package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

func healthCommand(t *testing.T, request availabilityHealthRequest) *pb.DockerAvailabilityCommand {
	t.Helper()
	config, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return &pb.DockerAvailabilityCommand{
		Action: availabilityActionHealth, PolicyId: "policy-1", PlacementId: "placement-1",
		ResourceKind: "container", ResourceId: "app", ConfigJson: string(config),
	}
}

func applyHealth(t *testing.T, h *availabilityHealth, request availabilityHealthRequest) availabilityHealthDetail {
	t.Helper()
	raw, err := h.apply(healthCommand(t, request))
	if err != nil {
		t.Fatal(err)
	}
	var detail availabilityHealthDetail
	if err := json.Unmarshal([]byte(raw), &detail); err != nil {
		t.Fatal(err)
	}
	return detail
}

type healthTestClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *healthTestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *healthTestClock) Add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// healthTestProbe counts probes and returns the current outcome.
type healthTestProbe struct {
	mu      sync.Mutex
	probes  int
	outcome availabilityHealthOutcome
}

func (p *healthTestProbe) probe(context.Context, availabilityHealthCheckSpec) availabilityHealthOutcome {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.probes++
	return p.outcome
}

func (p *healthTestProbe) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.probes
}

func (p *healthTestProbe) set(outcome availabilityHealthOutcome) {
	p.mu.Lock()
	p.outcome = outcome
	p.mu.Unlock()
}

// waitProbed steps the checker, a check interval at a time, until n probes ran
// and none is in flight.
func waitProbed(t *testing.T, h *availabilityHealth, clock *healthTestClock, probe *healthTestProbe, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.mu.Lock()
		running := false
		for _, policy := range h.policies {
			for _, state := range policy.checks {
				running = running || state.running
			}
		}
		h.mu.Unlock()
		if !running && probe.count() >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("checker ran %d of %d probes", probe.count(), n)
		}
		if !running {
			h.step(context.Background())
			clock.Add(availabilityHealthMinInterval)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestAvailabilityHealthCountsFailuresPerInstanceAndHoldsTheCopyOut(t *testing.T) {
	clock := &healthTestClock{now: time.Unix(1_800_000_000, 0)}
	probe := &healthTestProbe{outcome: availabilityHealthOutcome{known: true, ok: false, status: 503, err: "unexpected status 503", instance: "c1@t1"}}
	h := newAvailabilityHealth(probe.probe)
	h.now = clock.Now
	var dormantChanges []bool
	h.onDormant = func(_ string, dormant bool) { dormantChanges = append(dormantChanges, dormant) }
	var released []string
	h.release = func(policyID, reason string) bool { released = append(released, policyID+": "+reason); return true }

	check := availabilityHealthCheckSpec{ID: "route:r1", Container: "app", Port: 8080, Path: "/healthz", IntervalSeconds: 5}
	detail := applyHealth(t, h, availabilityHealthRequest{TTLSeconds: 60, Checks: []availabilityHealthCheckSpec{check}})
	if len(detail.Checks) != 1 || detail.Checks[0].State != "pending" || detail.Dormant {
		t.Fatalf("first apply: %+v", detail)
	}
	waitProbed(t, h, clock, probe, 2)
	detail = applyHealth(t, h, availabilityHealthRequest{TTLSeconds: 60, Checks: []availabilityHealthCheckSpec{check}})
	if got := detail.Checks[0]; got.State != "failing" || got.ConsecutiveFailures != 2 || got.HTTPStatus != 503 {
		t.Fatalf("after two failed probes: %+v", got)
	}

	// Opfield takes the copy out and asks for a health release.
	detail = applyHealth(t, h, availabilityHealthRequest{TTLSeconds: 60, Checks: []availabilityHealthCheckSpec{check}, Dormant: true, Release: true, Reason: "GET /healthz answered 503"})
	if !detail.Dormant || !detail.Released || !h.dormant("policy-1") {
		t.Fatalf("dormant apply: %+v", detail)
	}
	if len(released) != 1 || !strings.Contains(released[0], "503") || fmt.Sprint(dormantChanges) != "[true]" {
		t.Fatalf("released %v, dormant changes %v", released, dormantChanges)
	}

	// The copy restarts (another instance) and answers: the counters start over.
	probe.set(availabilityHealthOutcome{known: true, ok: true, status: 200, instance: "c1@t2"})
	waitProbed(t, h, clock, probe, 3)
	detail = applyHealth(t, h, availabilityHealthRequest{TTLSeconds: 60, Checks: []availabilityHealthCheckSpec{check}, Dormant: true})
	if got := detail.Checks[0]; got.State != "passing" || got.ConsecutiveSuccesses != 1 || got.ConsecutiveFailures != 0 || got.Instance != "c1@t2" {
		t.Fatalf("after the restart: %+v", got)
	}
	if len(released) != 1 {
		t.Fatal("a dormant renewal without release asked for another release")
	}

	// Opfield puts it back.
	applyHealth(t, h, availabilityHealthRequest{TTLSeconds: 60, Checks: []availabilityHealthCheckSpec{check}})
	if h.dormant("policy-1") || fmt.Sprint(dormantChanges) != "[true false]" {
		t.Fatalf("put back: dormant=%v changes %v", h.dormant("policy-1"), dormantChanges)
	}
}

func TestAvailabilityHealthExpiresWithoutOpfield(t *testing.T) {
	clock := &healthTestClock{now: time.Unix(1_800_000_000, 0)}
	h := newAvailabilityHealth((&healthTestProbe{outcome: availabilityHealthOutcome{known: true, instance: "c1@t1"}}).probe)
	h.now = clock.Now
	var dormantChanges []bool
	h.onDormant = func(_ string, dormant bool) { dormantChanges = append(dormantChanges, dormant) }
	check := availabilityHealthCheckSpec{ID: "route:r1", Container: "app", Port: 8080, Path: "/"}
	applyHealth(t, h, availabilityHealthRequest{TTLSeconds: 30, Checks: []availabilityHealthCheckSpec{check}, Dormant: true})
	clock.Add(31 * time.Second)
	h.step(context.Background())
	if h.dormant("policy-1") || fmt.Sprint(dormantChanges) != "[true false]" {
		t.Fatalf("a hold Gateway stopped renewing must lapse: dormant=%v changes %v", h.dormant("policy-1"), dormantChanges)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.policies) != 0 {
		t.Fatal("expired checks keep running")
	}
}

func TestAvailabilityHealthStartupGraceAndUnknownProbes(t *testing.T) {
	spec := availabilityHealthCheckSpec{StartupGraceSeconds: 30}
	now := time.Unix(1_800_000_000, 0)
	starting := nextAvailabilityHealthResult(spec, availabilityHealthCheckResult{State: "pending"},
		availabilityHealthOutcome{known: true, instance: "c@1", startedAt: now.Add(-10 * time.Second)}, now)
	if starting.State != "starting" || starting.ConsecutiveFailures != 0 {
		t.Fatalf("a failure inside the startup grace counted: %+v", starting)
	}
	failing := nextAvailabilityHealthResult(spec, starting,
		availabilityHealthOutcome{known: true, instance: "c@1", startedAt: now.Add(-40 * time.Second)}, now)
	if failing.State != "failing" || failing.ConsecutiveFailures != 1 {
		t.Fatalf("a failure after the grace: %+v", failing)
	}
	if unknown := nextAvailabilityHealthResult(spec, failing, availabilityHealthOutcome{}, now); unknown != failing {
		t.Fatalf("a probe dockerd did not answer changed the result: %+v", unknown)
	}
}

func TestAvailabilityHealthRejectsInvalidChecks(t *testing.T) {
	h := newAvailabilityHealth(nil)
	for name, check := range map[string]availabilityHealthCheckSpec{
		"no target": {ID: "a", Port: 80, Path: "/"},
		"bad port":  {ID: "a", Container: "app", Port: 0, Path: "/"},
		"bad path":  {ID: "a", Container: "app", Port: 80, Path: "healthz"},
		"scheme":    {ID: "a", Container: "app", Port: 80, Path: "/", Scheme: "ftp"},
	} {
		if _, err := h.apply(healthCommand(t, availabilityHealthRequest{Checks: []availabilityHealthCheckSpec{check}})); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
}

func TestAvailabilityHealthHTTPMatchesStatusAndBody(t *testing.T) {
	status, body := http.StatusOK, `{"db":"ok"}`
	var host string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host = r.Host
		if r.URL.Path == "/moved" {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	address := strings.TrimPrefix(server.URL, "http://")
	if _, _, err := net.SplitHostPort(address); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		spec   availabilityHealthCheckSpec
		status int
		body   string
		ok     bool
	}{
		{"2xx by default", availabilityHealthCheckSpec{Path: "/healthz"}, 200, body, true},
		{"503 fails", availabilityHealthCheckSpec{Path: "/healthz"}, 503, body, false},
		{"exact status", availabilityHealthCheckSpec{Path: "/healthz", ExpectedStatus: 204}, 200, body, false},
		{"deployment range", availabilityHealthCheckSpec{Path: "/healthz", StatusMin: 200, StatusMax: 399}, 302, body, true},
		{"body includes", availabilityHealthCheckSpec{Path: "/healthz", ExpectedBody: `"db":"ok"`, BodyMatchMode: "includes"}, 200, body, true},
		{"body exact mismatch", availabilityHealthCheckSpec{Path: "/healthz", ExpectedBody: "ok", BodyMatchMode: "exact"}, 200, body, false},
		{"redirect is the answer", availabilityHealthCheckSpec{Path: "/moved"}, 200, body, false},
	}
	for _, tc := range cases {
		status, body = tc.status, tc.body
		ok, _, reason := availabilityHealthHTTP(context.Background(), tc.spec, address)
		if ok != tc.ok {
			t.Fatalf("%s: ok=%v (%s)", tc.name, ok, reason)
		}
	}
	availabilityHealthHTTP(context.Background(), availabilityHealthCheckSpec{Path: "/", Host: "secure-link.internal"}, address)
	if host != "secure-link.internal" {
		t.Fatalf("Host header %q", host)
	}
}
