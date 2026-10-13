package docker

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// Availability HTTP health.
//
// Gateway's health watch hands this node the HTTP health checks of the
// Availability copy it runs: the health check of every Route that serves the
// workload, and a blue/green deployment's own health check. The node probes
// the copy directly (the container's address, as a deployment's readiness
// check does) at each check's interval, in the background, so the command
// that sets the checks returns at once with the latest results.
//
// Gateway decides from the results, because only it sees every copy of the
// policy: it never takes out the last copy that serves. When it takes one out
// it sets the policy dormant here (its member endpoints register dormant and
// their tunnels end, so the Route stops sending requests) and, in lease mode,
// asks the holder to release its slot for health (lease.ReleaseUnhealthy):
// the copy is restarted, or a standby takes over. It stays dormant until
// Gateway sees the check pass again and lifts it.
//
// Every check and the dormant state expire unless Gateway renews them: with
// Gateway down the copy is judged by its Docker state alone, as without an
// HTTP health check.

const (
	availabilityActionHealth         = "health"
	availabilityHTTPHealthCapability = "availability_http_health_v1"

	availabilityHealthTick           = time.Second
	availabilityHealthMaxProbes      = 4
	availabilityHealthMaxChecks      = 16
	availabilityHealthMinInterval    = 5 * time.Second
	availabilityHealthMaxInterval    = 5 * time.Minute
	availabilityHealthDefaultTimeout = 5 * time.Second
	availabilityHealthMaxTimeout     = 30 * time.Second
	availabilityHealthDefaultTTL     = 90 * time.Second
	availabilityHealthMinTTL         = 10 * time.Second
	availabilityHealthMaxTTL         = 10 * time.Minute
	availabilityHealthBodyLimit      = 1 << 20
	availabilityHealthDockerWait     = 2 * time.Second
	availabilityHealthUserAgent      = "opfield-availability-health"
)

// availabilityHealthCheckSpec is one HTTP health check of a copy. The target
// is a container by name or ID, or the container of a Compose service; the
// address is the container's on network when it is attached there, else its
// first address.
type availabilityHealthCheckSpec struct {
	ID                  string `json:"id"`
	Container           string `json:"container,omitempty"`
	ComposeProject      string `json:"composeProject,omitempty"`
	ComposeService      string `json:"composeService,omitempty"`
	Network             string `json:"network,omitempty"`
	Port                int    `json:"port"`
	Scheme              string `json:"scheme,omitempty"`
	Host                string `json:"host,omitempty"`
	Path                string `json:"path"`
	ExpectedStatus      int    `json:"expectedStatus,omitempty"`
	StatusMin           int    `json:"statusMin,omitempty"`
	StatusMax           int    `json:"statusMax,omitempty"`
	ExpectedBody        string `json:"expectedBody,omitempty"`
	BodyMatchMode       string `json:"bodyMatchMode,omitempty"`
	TimeoutSeconds      int    `json:"timeoutSeconds,omitempty"`
	IntervalSeconds     int    `json:"intervalSeconds,omitempty"`
	StartupGraceSeconds int    `json:"startupGraceSeconds,omitempty"`
}

type availabilityHealthRequest struct {
	TTLSeconds int                           `json:"ttlSeconds"`
	Checks     []availabilityHealthCheckSpec `json:"checks"`
	Dormant    bool                          `json:"dormant"`
	Release    bool                          `json:"release"`
	Reason     string                        `json:"reason"`
}

// availabilityHealthCheckResult is what a check observed so far. State is
// "pending" before the first probe, "starting" while a failure falls into the
// startup grace, then "passing" or "failing". The counters restart when the
// container is replaced or restarted (another instance).
type availabilityHealthCheckResult struct {
	ID                   string `json:"id"`
	State                string `json:"state"`
	ConsecutiveFailures  int    `json:"consecutiveFailures"`
	ConsecutiveSuccesses int    `json:"consecutiveSuccesses"`
	HTTPStatus           int    `json:"httpStatus,omitempty"`
	Error                string `json:"error,omitempty"`
	CheckedAtUnixMs      int64  `json:"checkedAtUnixMs,omitempty"`
	Instance             string `json:"instance,omitempty"`
	// ContainerRunning is false when the last probe found the container
	// stopped or gone: a Docker state problem, not an HTTP one.
	ContainerRunning bool `json:"containerRunning"`
}

type availabilityHealthDetail struct {
	PolicyID    string                          `json:"policyId"`
	PlacementID string                          `json:"placementId"`
	Checks      []availabilityHealthCheckResult `json:"checks"`
	Dormant     bool                            `json:"dormant"`
	Released    bool                            `json:"released"`
}

// availabilityHealthOutcome is one probe. known is false when dockerd did not
// answer: no evidence either way.
type availabilityHealthOutcome struct {
	known     bool
	running   bool
	ok        bool
	status    int
	err       string
	instance  string
	startedAt time.Time
}

type availabilityHealthCheckState struct {
	spec    availabilityHealthCheckSpec
	key     string
	running bool
	nextAt  time.Time
	result  availabilityHealthCheckResult
}

type availabilityHealthPolicy struct {
	placementID  string
	expiresAt    time.Time
	dormantUntil time.Time
	// dormantOn is the dormant state last announced (onDormant).
	dormantOn bool
	checks    map[string]*availabilityHealthCheckState
}

type availabilityHealth struct {
	mu       sync.Mutex
	policies map[string]*availabilityHealthPolicy
	wake     chan struct{}
	slots    chan struct{}
	now      func() time.Time
	probe    func(ctx context.Context, spec availabilityHealthCheckSpec) availabilityHealthOutcome
	// onDormant is told when a policy's copy is taken out or put back; it
	// runs outside the lock.
	onDormant func(policyID string, dormant bool)
	// release asks the lease holder to release its slot for health.
	release func(policyID, reason string) bool
}

func newAvailabilityHealth(probe func(context.Context, availabilityHealthCheckSpec) availabilityHealthOutcome) *availabilityHealth {
	return &availabilityHealth{
		policies: map[string]*availabilityHealthPolicy{},
		wake:     make(chan struct{}, 1),
		slots:    make(chan struct{}, availabilityHealthMaxProbes),
		now:      time.Now,
		probe:    probe,
	}
}

// dormant reports whether Gateway took the policy's copy on this node out.
func (h *availabilityHealth) dormant(policyID string) bool {
	if h == nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	policy := h.policies[policyID]
	return policy != nil && h.now().Before(policy.dormantUntil)
}

func (h *availabilityHealth) signal() {
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

// apply sets the checks and the dormant state of a policy's copy and returns
// the latest results. It never waits on Docker or the network.
func (h *availabilityHealth) apply(cmd *pb.DockerAvailabilityCommand) (string, error) {
	if strings.TrimSpace(cmd.GetPolicyId()) == "" || strings.TrimSpace(cmd.GetPlacementId()) == "" {
		return "", errors.New("availability health needs a policy and a placement")
	}
	var request availabilityHealthRequest
	if raw := strings.TrimSpace(cmd.GetConfigJson()); raw != "" {
		if err := json.Unmarshal([]byte(raw), &request); err != nil {
			return "", fmt.Errorf("availability health config_json: %w", err)
		}
	}
	if err := validateAvailabilityHealthChecks(request.Checks); err != nil {
		return "", err
	}
	ttl := availabilityHealthDefaultTTL
	if request.TTLSeconds > 0 {
		ttl = min(max(time.Duration(request.TTLSeconds)*time.Second, availabilityHealthMinTTL), availabilityHealthMaxTTL)
	}
	policyID := cmd.GetPolicyId()
	now := h.now()

	h.mu.Lock()
	policy := h.policies[policyID]
	if policy == nil || policy.placementID != cmd.GetPlacementId() {
		dormantOn := policy != nil && policy.dormantOn
		policy = &availabilityHealthPolicy{placementID: cmd.GetPlacementId(), checks: map[string]*availabilityHealthCheckState{}, dormantOn: dormantOn}
		h.policies[policyID] = policy
	}
	policy.expiresAt = now.Add(ttl)
	keep := map[string]bool{}
	for _, spec := range request.Checks {
		keep[spec.ID] = true
		key := availabilityHealthSpecKey(spec)
		if state := policy.checks[spec.ID]; state != nil && state.key == key {
			continue
		}
		policy.checks[spec.ID] = &availabilityHealthCheckState{
			spec: spec, key: key, nextAt: now,
			result: availabilityHealthCheckResult{ID: spec.ID, State: "pending"},
		}
	}
	for id := range policy.checks {
		if !keep[id] {
			delete(policy.checks, id)
		}
	}
	if request.Dormant {
		policy.dormantUntil = now.Add(ttl)
	} else {
		policy.dormantUntil = time.Time{}
	}
	detail := availabilityHealthDetail{PolicyID: policyID, PlacementID: policy.placementID, Dormant: request.Dormant}
	ids := make([]string, 0, len(policy.checks))
	for id := range policy.checks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		detail.Checks = append(detail.Checks, policy.checks[id].result)
	}
	changed := policy.dormantOn != request.Dormant
	policy.dormantOn = request.Dormant
	if len(policy.checks) == 0 && !request.Dormant {
		delete(h.policies, policyID)
	}
	h.mu.Unlock()

	if changed && h.onDormant != nil {
		h.onDormant(policyID, request.Dormant)
	}
	if request.Release && h.release != nil {
		reason := strings.TrimSpace(request.Reason)
		if reason == "" {
			reason = "the copy fails its HTTP health check"
		}
		detail.Released = h.release(policyID, reason)
	}
	h.signal()
	data, err := json.Marshal(detail)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func validateAvailabilityHealthChecks(checks []availabilityHealthCheckSpec) error {
	if len(checks) > availabilityHealthMaxChecks {
		return fmt.Errorf("availability health accepts at most %d checks", availabilityHealthMaxChecks)
	}
	seen := map[string]bool{}
	for _, spec := range checks {
		switch {
		case strings.TrimSpace(spec.ID) == "" || seen[spec.ID]:
			return errors.New("every availability health check needs a unique id")
		case spec.Container == "" && (spec.ComposeProject == "" || spec.ComposeService == ""):
			return fmt.Errorf("availability health check %s needs a container or a Compose service", spec.ID)
		case spec.Port < 1 || spec.Port > 65535:
			return fmt.Errorf("availability health check %s has an invalid port", spec.ID)
		case !strings.HasPrefix(spec.Path, "/"):
			return fmt.Errorf("availability health check %s path must start with /", spec.ID)
		case spec.Scheme != "" && spec.Scheme != "http" && spec.Scheme != "https":
			return fmt.Errorf("availability health check %s has an unsupported scheme", spec.ID)
		}
		seen[spec.ID] = true
	}
	return nil
}

func availabilityHealthSpecKey(spec availabilityHealthCheckSpec) string {
	data, _ := json.Marshal(spec)
	return string(data)
}

// run probes the due checks until ctx ends and drops the policies Gateway
// stopped renewing.
func (h *availabilityHealth) run(ctx context.Context) {
	ticker := time.NewTicker(availabilityHealthTick)
	defer ticker.Stop()
	for {
		h.step(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-h.wake:
		}
	}
}

func (h *availabilityHealth) step(ctx context.Context) {
	now := h.now()
	type due struct {
		policyID string
		state    *availabilityHealthCheckState
	}
	var start []due
	var lifted []string
	h.mu.Lock()
	for policyID, policy := range h.policies {
		if policy.dormantOn && !now.Before(policy.dormantUntil) {
			policy.dormantOn = false
			lifted = append(lifted, policyID)
		}
		if !now.Before(policy.expiresAt) {
			delete(h.policies, policyID)
			continue
		}
		for _, state := range policy.checks {
			if !state.running && !now.Before(state.nextAt) {
				start = append(start, due{policyID: policyID, state: state})
			}
		}
	}
	for _, item := range start {
		select {
		case h.slots <- struct{}{}:
		default:
			// Every probe slot is busy: the check stays due for the next tick.
			continue
		}
		item.state.running = true
		go h.runProbe(ctx, item.policyID, item.state)
	}
	h.mu.Unlock()
	if h.onDormant != nil {
		for _, policyID := range lifted {
			h.onDormant(policyID, false)
		}
	}
}

func (h *availabilityHealth) runProbe(ctx context.Context, policyID string, state *availabilityHealthCheckState) {
	defer func() { <-h.slots }()
	outcome := h.probe(ctx, state.spec)
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	state.running = false
	state.nextAt = now.Add(availabilityHealthInterval(state.spec))
	state.result = nextAvailabilityHealthResult(state.spec, state.result, outcome, now)
}

// nextAvailabilityHealthResult folds one probe into a check's result.
func nextAvailabilityHealthResult(spec availabilityHealthCheckSpec, previous availabilityHealthCheckResult, outcome availabilityHealthOutcome, now time.Time) availabilityHealthCheckResult {
	if !outcome.known {
		return previous
	}
	next := previous
	if outcome.instance != previous.Instance {
		next.ConsecutiveFailures, next.ConsecutiveSuccesses = 0, 0
		next.Instance = outcome.instance
	}
	next.HTTPStatus, next.Error, next.CheckedAtUnixMs = outcome.status, outcome.err, now.UnixMilli()
	next.ContainerRunning = outcome.running
	if outcome.ok {
		next.State = "passing"
		next.ConsecutiveSuccesses++
		next.ConsecutiveFailures = 0
		return next
	}
	next.ConsecutiveSuccesses = 0
	grace := time.Duration(spec.StartupGraceSeconds) * time.Second
	if grace > 0 && !outcome.startedAt.IsZero() && now.Sub(outcome.startedAt) < grace {
		next.State = "starting"
		return next
	}
	next.State = "failing"
	next.ConsecutiveFailures++
	return next
}

func availabilityHealthInterval(spec availabilityHealthCheckSpec) time.Duration {
	interval := time.Duration(spec.IntervalSeconds) * time.Second
	return min(max(interval, availabilityHealthMinInterval), availabilityHealthMaxInterval)
}

func availabilityHealthTimeout(spec availabilityHealthCheckSpec) time.Duration {
	if spec.TimeoutSeconds <= 0 {
		return availabilityHealthDefaultTimeout
	}
	return min(time.Duration(spec.TimeoutSeconds)*time.Second, availabilityHealthMaxTimeout)
}

// availabilityHealthStatusPasses applies the expected status: an exact one,
// a range, or any 2xx.
func availabilityHealthStatusPasses(spec availabilityHealthCheckSpec, status int) bool {
	if spec.ExpectedStatus > 0 {
		return status == spec.ExpectedStatus
	}
	if spec.StatusMin > 0 || spec.StatusMax > 0 {
		low, high := spec.StatusMin, spec.StatusMax
		if low <= 0 {
			low = 100
		}
		if high <= 0 {
			high = 599
		}
		return status >= low && status <= high
	}
	return status >= 200 && status < 300
}

// availabilityHealthBodyPasses matches the expected body as a Route health
// check does.
func availabilityHealthBodyPasses(spec availabilityHealthCheckSpec, body string) bool {
	if spec.ExpectedBody == "" {
		return true
	}
	switch spec.BodyMatchMode {
	case "exact":
		return body == spec.ExpectedBody
	case "starts_with":
		return strings.HasPrefix(body, spec.ExpectedBody)
	case "ends_with":
		return strings.HasSuffix(body, spec.ExpectedBody)
	default:
		return strings.Contains(body, spec.ExpectedBody)
	}
}

// probeAvailabilityHealth runs one check against the copy's container.
func (p *DockerPlugin) probeAvailabilityHealth(ctx context.Context, spec availabilityHealthCheckSpec) availabilityHealthOutcome {
	if p.client == nil {
		return availabilityHealthOutcome{}
	}
	dockerCtx, cancel := context.WithTimeout(ctx, availabilityHealthDockerWait)
	defer cancel()
	target := spec.Container
	if target == "" {
		found, known := p.composeServiceContainer(dockerCtx, spec.ComposeProject, spec.ComposeService)
		if !known {
			return availabilityHealthOutcome{}
		}
		if found == "" {
			return availabilityHealthOutcome{known: true, err: "the Compose service has no container"}
		}
		target = found
	}
	inspect, err := p.client.cli.ContainerInspect(dockerCtx, target, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return availabilityHealthOutcome{known: true, err: "the container does not exist"}
		}
		return availabilityHealthOutcome{}
	}
	current := inspect.Container
	if current.State == nil || !current.State.Running {
		return availabilityHealthOutcome{known: true, err: "the container is not running"}
	}
	outcome := availabilityHealthOutcome{known: true, running: true, instance: current.ID + "@" + current.State.StartedAt}
	outcome.startedAt, _ = time.Parse(time.RFC3339Nano, current.State.StartedAt)
	address := availabilityHealthAddress(current, spec.Network)
	if address == "" {
		outcome.err = "the container has no address to probe"
		return outcome
	}
	outcome.ok, outcome.status, outcome.err = availabilityHealthHTTP(ctx, spec, net.JoinHostPort(address, strconv.Itoa(spec.Port)))
	return outcome
}

// composeServiceContainer is the container of a Compose service, a running one
// first. known is false when dockerd did not answer.
func (p *DockerPlugin) composeServiceContainer(ctx context.Context, project, service string) (string, bool) {
	containers, err := p.client.ListContainers(ctx)
	if err != nil {
		return "", false
	}
	var candidates []ContainerInfo
	for _, ctr := range containers {
		if ctr.Labels["com.docker.compose.project"] == project && ctr.Labels["com.docker.compose.service"] == service {
			candidates = append(candidates, ctr)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if (candidates[i].State == "running") != (candidates[j].State == "running") {
			return candidates[i].State == "running"
		}
		return candidates[i].Name < candidates[j].Name
	})
	if len(candidates) == 0 {
		return "", true
	}
	return candidates[0].ID, true
}

// availabilityHealthAddress is the container's address on network, else its
// first address by network name; loopback for a host-network container.
func availabilityHealthAddress(inspect container.InspectResponse, network string) string {
	if settings := inspect.NetworkSettings; settings != nil {
		if network != "" {
			if endpoint := settings.Networks[network]; endpoint != nil && endpoint.IPAddress.IsValid() {
				return endpoint.IPAddress.String()
			}
		}
		names := make([]string, 0, len(settings.Networks))
		for name := range settings.Networks {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if endpoint := settings.Networks[name]; endpoint != nil && endpoint.IPAddress.IsValid() {
				return endpoint.IPAddress.String()
			}
		}
	}
	if inspect.HostConfig != nil && inspect.HostConfig.NetworkMode.IsHost() {
		return "127.0.0.1"
	}
	return ""
}

// availabilityHealthHTTP sends the check's request to address. Redirects are
// not followed: a 3xx is the answer.
func availabilityHealthHTTP(ctx context.Context, spec availabilityHealthCheckSpec, address string) (bool, int, string) {
	timeout := availabilityHealthTimeout(spec)
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	scheme := spec.Scheme
	if scheme == "" {
		scheme = "http"
	}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, scheme+"://"+address+spec.Path, nil)
	if err != nil {
		return false, 0, err.Error()
	}
	if spec.Host != "" {
		request.Host = spec.Host
	}
	request.Header.Set("User-Agent", availabilityHealthUserAgent)
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext:       (&net.Dialer{Timeout: timeout}).DialContext,
		// The copy's own certificate is not what is checked here.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport:     transport,
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return false, 0, err.Error()
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, availabilityHealthBodyLimit))
	if err != nil {
		return false, response.StatusCode, err.Error()
	}
	if !availabilityHealthStatusPasses(spec, response.StatusCode) {
		return false, response.StatusCode, fmt.Sprintf("unexpected status %d", response.StatusCode)
	}
	if !availabilityHealthBodyPasses(spec, string(body)) {
		return false, response.StatusCode, "the response body does not match"
	}
	return true, response.StatusCode, ""
}

// initAvailabilityHealth starts the HTTP health probes of Availability copies.
func (p *DockerPlugin) initAvailabilityHealth() {
	health := newAvailabilityHealth(p.probeAvailabilityHealth)
	health.onDormant = p.availabilityHealthDormantChanged
	health.release = func(policyID, reason string) bool {
		if p.lease == nil || p.lease.runtime == nil {
			return false
		}
		return p.lease.runtime.ReleaseUnhealthy(policyID, reason)
	}
	p.availabilityHealth = health
	go health.run(context.Background())
}

// availabilityHealthDormantChanged re-registers the policy's member endpoints:
// dormant ends the tunnels nginx holds to the copy, so requests on kept-alive
// connections stop as well; put back, the copy is probed for readiness again.
func (p *DockerPlugin) availabilityHealthDormantChanged(policyID string, dormant bool) {
	if p.logger != nil {
		if dormant {
			p.logger.Warn("availability copy fails its HTTP health check; Opfield took it out of its routes", "policy_id", policyID)
		} else {
			p.logger.Info("availability copy is back in its routes", "policy_id", policyID)
		}
	}
	p.memberReadiness.reset(policyID)
	go func() {
		p.reconcileRelayRegistrations()
		if dormant {
			p.closeMemberTunnels(p.memberEndpointIDs(policyID))
			return
		}
		p.memberReadiness.signal()
	}()
}

func (p *DockerPlugin) handleAvailabilityHealth(cmd *pb.DockerAvailabilityCommand, result *pb.CommandResult) {
	if p.availabilityHealth == nil {
		result.Success = false
		result.Error = "availability health checks are not initialized"
		return
	}
	detail, err := p.availabilityHealth.apply(cmd)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	result.Detail = detail
}
