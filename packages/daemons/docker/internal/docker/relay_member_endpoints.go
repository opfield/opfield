package docker

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	mobyclient "github.com/moby/moby/client"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// Availability member endpoints (D6, D7).
//
// Every Secure Link endpoint of an availability member registers on every
// relay it is assigned to, whether this node serves the member or not. The
// registration says whether it takes traffic: DORMANT for a standby, for a
// holder that released or fenced, and for a holder whose workload is not ready
// yet; SERVING once the node serves the policy (the lease holder, or any member
// outside lease mode) and the workload is ready. A successor is therefore
// already registered on every relay at a takeover and only flips its state,
// and no member receives traffic before its workload answers.
//
// Ready means: the target container runs and, when its image has a health
// check, is healthy; otherwise its port accepts connections. A deployment is
// ready once its router reaches the active colour's app (an app health check,
// when it has one, must pass as well). Readiness is probed in the background
// (never on the data path) and a probe that cannot reach dockerd is no evidence
// either way: the last result stands. A copy Gateway took out for failing its
// HTTP health check is not ready until Gateway puts it back
// (availability_http_health.go).

var errMemberEndpointDormant = errors.New("availability member endpoint is dormant")

const (
	memberReadinessInterval = 500 * time.Millisecond
	// A ready member is re-checked this often, cheaply: only whether its
	// containers were restarted or replaced (then it is probed again).
	memberReadinessRecheck = 5 * time.Second
	memberProbeDockerWait  = 2 * time.Second
	memberProbeDialWait    = time.Second
	// A running container's closed port refuses at once; a connection the
	// target accepted stays open this long without a byte from us.
	memberProbeTCPSettle = 300 * time.Millisecond
	memberProbeHTTPWait  = 3 * time.Second
	// memberProbeRestoreEvery bounds the binding restores a probe starts for a
	// serving member whose link is not bound yet.
	memberProbeRestoreEvery = 5 * time.Second
	// memberReadinessFullRecheck is how often a ready member is probed in full;
	// memberReadinessMisses failed full re-checks in a row make it not ready.
	memberReadinessFullRecheck = 30 * time.Second
	memberReadinessMisses      = 2
	// deploymentRouterUnavailableHeader marks a response the deployment router
	// generated itself because it could not reach the active slot.
	deploymentRouterUnavailableHeader = "X-Opfield-Deployment-Router"
	// legacy-name: X-Gateway-Deployment-Router of routers rendered before Opfield (re-rendered on their next deploy) — remove once every node reports none
	legacyDeploymentRouterUnavailableHeader = "X-Gateway-Deployment-Router"
)

// memberProbeResult is one readiness probe of a policy's member links on this
// node. known is false when dockerd did not answer: no evidence either way.
type memberProbeResult struct {
	ready       bool
	fingerprint string
	known       bool
}

// availabilityLinkPolicy is the availability policy a Secure Link target on
// this node belongs to, or "" for a link that is not an availability member.
func (p *DockerPlugin) availabilityLinkPolicy(linkID string) string {
	if p.secureLinkState == nil {
		return ""
	}
	// Per relayed connection: one binding, not a copy of all of them (B-22).
	return p.secureLinkState.Binding(linkID, "target").GetAvailabilityPolicyId()
}

// secureLinkTargets are the Secure Link targets this node serves.
func (p *DockerPlugin) secureLinkTargets() map[string]bool {
	result := map[string]bool{}
	if p.secureLinkState == nil {
		return result
	}
	for _, binding := range p.secureLinkState.Get().GetBindings() {
		if binding.GetRole() == "target" {
			result[binding.GetLinkId()] = true
		}
	}
	return result
}

// availabilityMemberLinks groups this node's availability member targets by
// policy.
func (p *DockerPlugin) availabilityMemberLinks() map[string][]string {
	result := map[string][]string{}
	if p.secureLinkState == nil {
		return result
	}
	for _, binding := range p.secureLinkState.Get().GetBindings() {
		if binding.GetRole() != "target" || binding.GetAvailabilityPolicyId() == "" {
			continue
		}
		result[binding.GetAvailabilityPolicyId()] = append(result[binding.GetAvailabilityPolicyId()], binding.GetLinkId())
	}
	for _, links := range result {
		sort.Strings(links)
	}
	return result
}

// memberEndpointState is the serving state a proxy Secure Link endpoint
// registers with: UNSPECIFIED for a link that is not an availability member
// (it registers as it always did), SERVING for a member this node serves whose
// workload is ready, DORMANT for every other member (D6, D7).
func (p *DockerPlugin) memberEndpointState(linkID string) relayv1.EndpointServingState {
	return p.memberReadiness.recordState(linkID, p.decideMemberEndpointState(linkID))
}

// decideMemberEndpointState flips a link only on evidence (B-12b): DORMANT when
// this node does not serve the member (lease released, fenced, standby) or a
// probe found its workload not ready. A link whose readiness is not known yet
// keeps taking traffic if it took traffic until now: a plain link of a policy
// that just entered lease mode (its binding only now names the policy), or a
// member whose readiness was forgotten while its copy kept serving. Flipping
// it dormant first would reset every established connection through it and
// refuse new ones while the same copy serves; the probe that follows decides.
func (p *DockerPlugin) decideMemberEndpointState(linkID string) relayv1.EndpointServingState {
	policyID := p.availabilityLinkPolicy(linkID)
	if policyID == "" {
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
	}
	if !p.lease.endpointAllowed(linkID) {
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	}
	if p.availabilityHealth.dormant(policyID) {
		// Gateway took the copy out: it fails its HTTP health check while
		// another copy serves.
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	}
	if entry, known := p.memberReadiness.entry(policyID); known {
		if entry.ready {
			return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
		}
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	}
	// Not probed by this process yet: a link that took traffic until now
	// (B-12b) and a copy recovered serving after a same-boot daemon restart
	// (B-13) keep serving; the first probe decides.
	if p.memberReadiness.tookTraffic(linkID) || p.lease.recoveredUnprobed(policyID, false) {
		return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
	}
	return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
}

// runMemberReadiness keeps the readiness of the members this node serves
// current and re-registers their endpoints when it changes.
func (p *DockerPlugin) runMemberReadiness(ctx context.Context) {
	ticker := time.NewTicker(memberReadinessInterval)
	defer ticker.Stop()
	for {
		if p.refreshMemberReadiness(ctx, time.Now()) {
			p.reconcileRelayRegistrations()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-p.memberReadiness.wake:
		}
	}
}

// refreshMemberReadiness probes the members that serve here and are not known
// ready, re-checks the ready ones, and reports whether any readiness changed.
func (p *DockerPlugin) refreshMemberReadiness(ctx context.Context, now time.Time) bool {
	policies := p.availabilityMemberLinks()
	changed := p.memberReadiness.keepOnly(policies)
	p.memberReadiness.keepLinks(p.secureLinkTargets())
	for policyID, links := range policies {
		if len(links) == 0 || !p.lease.endpointAllowed(links[0]) || p.availabilityHealth.dormant(policyID) {
			if p.memberReadiness.reset(policyID) {
				changed = true
			}
			continue
		}
		entry, known := p.memberReadiness.entry(policyID)
		if known && entry.ready && now.Sub(entry.checkedAt) < memberReadinessRecheck {
			continue
		}
		probe := p.memberProbe
		if probe == nil {
			probe = p.probeMemberLinks
		}
		// A ready member only needs its containers to be the ones probed, but is
		// probed in full every memberReadinessFullRecheck: an application that
		// hung or lost its listener in a container that still runs, without an
		// image health check, otherwise kept the member serving.
		cheap := known && entry.ready && entry.misses == 0 && now.Sub(entry.fullAt) < memberReadinessFullRecheck
		result := probe(ctx, links, cheap)
		if !result.known {
			continue
		}
		ready, full := result.ready, !cheap
		if cheap && ready && result.fingerprint != entry.fingerprint {
			// Restarted or replaced since it was probed: probe it in full.
			result = probe(ctx, links, false)
			if !result.known {
				continue
			}
			ready, full = result.ready, true
		}
		next := memberReadinessEntry{ready: ready, fingerprint: result.fingerprint, checkedAt: now, fullAt: entry.fullAt}
		if full {
			next.fullAt = now
		}
		if known && entry.ready && full && !ready && result.fingerprint == entry.fingerprint && entry.misses+1 < memberReadinessMisses {
			// The same containers failed a full re-check: confirmed by the next
			// one before the member stops taking traffic, so one slow accept
			// under load does not fail it over.
			next.ready, next.misses = true, entry.misses+1
		}
		if p.memberReadiness.set(policyID, next) {
			changed = true
			p.logger.Info("availability member readiness changed", "policy_id", policyID, "ready", ready)
		}
	}
	return changed
}

// probeMemberLinks probes every member link of a policy on this node. With
// cheap set, a link is only inspected (for a ready member's re-check).
func (p *DockerPlugin) probeMemberLinks(ctx context.Context, links []string, cheap bool) memberProbeResult {
	if p.secureLinks == nil || p.client == nil {
		return memberProbeResult{known: true}
	}
	fingerprints := make([]string, 0, len(links))
	ready := true
	for _, linkID := range links {
		result := p.secureLinks.probeMemberTarget(ctx, linkID, cheap)
		if !result.known {
			return result
		}
		fingerprints = append(fingerprints, result.fingerprint)
		ready = ready && result.ready
	}
	return memberProbeResult{ready: ready, fingerprint: strings.Join(fingerprints, ","), known: true}
}

// probeMemberTarget reports whether one member link's target takes traffic.
func (m *dockerSecureLinkManager) probeMemberTarget(ctx context.Context, linkID string, cheap bool) memberProbeResult {
	binding, bound, _, host := m.dialState(linkID)
	if !bound || host == "" || binding.port == 0 {
		// A standby's link is left unbound until its container runs; bind it
		// now that this node serves it (coalesced with other restores, and at
		// most every memberProbeRestoreEvery from here).
		now := time.Now().UnixNano()
		if last := m.probeRestoreAt.Load(); now-last >= int64(memberProbeRestoreEvery) && m.probeRestoreAt.CompareAndSwap(last, now) {
			_ = m.restoreBindingsCoalesced(false)
		}
		return memberProbeResult{known: true}
	}
	inspectCtx, cancel := context.WithTimeout(ctx, memberProbeDockerWait)
	defer cancel()
	inspect, err := m.plugin.client.cli.ContainerInspect(inspectCtx, binding.targetContainer, mobyclient.ContainerInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return memberProbeResult{known: true}
		}
		return memberProbeResult{}
	}
	current := inspect.Container
	if current.State == nil || !current.State.Running {
		return memberProbeResult{known: true}
	}
	fingerprint := current.ID + "@" + current.State.StartedAt
	var labels map[string]string
	if current.Config != nil {
		labels = current.Config.Labels
	}
	if labels[deploymentRoleLabel] == "router" && labels[deploymentIDLabel] != "" {
		apps, appsKnown := m.deploymentAppsReady(inspectCtx, labels[deploymentIDLabel])
		if !appsKnown {
			return memberProbeResult{}
		}
		fingerprint += "|" + apps.fingerprint
		if !apps.ready {
			return memberProbeResult{fingerprint: fingerprint, known: true}
		}
		if cheap {
			return memberProbeResult{ready: true, fingerprint: fingerprint, known: true}
		}
		address := net.JoinHostPort(host, fmt.Sprintf("%d", binding.port))
		return memberProbeResult{ready: probeDeploymentRouter(ctx, address), fingerprint: fingerprint, known: true}
	}
	if current.State.Health != nil && current.State.Health.Status != "" && current.State.Health.Status != "none" {
		// The image's health check decides.
		return memberProbeResult{ready: current.State.Health.Status == "healthy", fingerprint: fingerprint, known: true}
	}
	if cheap {
		return memberProbeResult{ready: true, fingerprint: fingerprint, known: true}
	}
	address := net.JoinHostPort(host, fmt.Sprintf("%d", binding.port))
	return memberProbeResult{ready: probeTCPThroughConnector(ctx, address), fingerprint: fingerprint, known: true}
}

// deploymentAppsReady checks the running app slots of a deployment: an app
// whose image has a health check must be healthy. The fingerprint names the
// running slots and their starts, so a restarted or switched app is probed
// again.
func (m *dockerSecureLinkManager) deploymentAppsReady(ctx context.Context, deploymentID string) (memberProbeResult, bool) {
	containers, err := m.plugin.client.ListContainers(ctx)
	if err != nil {
		return memberProbeResult{}, false
	}
	var parts []string
	ready := false
	for _, ctr := range containers {
		if ctr.Labels[deploymentIDLabel] != deploymentID || ctr.Labels[deploymentManagedLabel] != "true" || ctr.Labels[deploymentRoleLabel] != "app" || ctr.State != "running" {
			continue
		}
		inspect, err := m.plugin.client.cli.ContainerInspect(ctx, ctr.ID, mobyclient.ContainerInspectOptions{})
		if err != nil {
			if isNotFoundErr(err) {
				continue
			}
			return memberProbeResult{}, false
		}
		state := inspect.Container.State
		if state == nil || !state.Running {
			continue
		}
		parts = append(parts, ctr.ID+"@"+state.StartedAt)
		if state.Health != nil && state.Health.Status != "" && state.Health.Status != "none" && state.Health.Status != "healthy" {
			// A slot still starting or failing its health check. During a
			// switch the other slot may be the served one; the router probe
			// decides then, so only a sole running slot blocks here.
			continue
		}
		ready = true
	}
	sort.Strings(parts)
	return memberProbeResult{ready: ready, fingerprint: strings.Join(parts, ","), known: true}, true
}

// probeTCPThroughConnector reports whether the target port accepts a
// connection. The connector accepts first and dials the target after; a port
// that refuses makes it close our connection at once.
func probeTCPThroughConnector(ctx context.Context, address string) bool {
	connection, err := (&net.Dialer{Timeout: memberProbeDialWait}).DialContext(ctx, "tcp", address)
	if err != nil {
		return false
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(memberProbeTCPSettle))
	buffer := make([]byte, 1)
	_, err = connection.Read(buffer)
	if err == nil {
		// A server that speaks first.
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// probeDeploymentRouter asks the deployment router for "/" and reports
// whether the active slot answered: any response the app itself sent. The
// router marks responses it generated because the slot was unreachable; a 502
// or 504 counts as unreachable for a router whose config predates the mark.
func probeDeploymentRouter(ctx context.Context, address string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, memberProbeHTTPWait)
	defer cancel()
	connection, err := (&net.Dialer{Timeout: memberProbeDialWait}).DialContext(probeCtx, "tcp", address)
	if err != nil {
		return false
	}
	defer connection.Close()
	deadline, _ := probeCtx.Deadline()
	_ = connection.SetDeadline(deadline)
	request := "GET / HTTP/1.1\r\nHost: opfield-readiness\r\nUser-Agent: opfield-readiness\r\nAccept: */*\r\nConnection: close\r\n\r\n"
	if _, err := connection.Write([]byte(request)); err != nil {
		return false
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		return false
	}
	_ = response.Body.Close()
	if response.Header.Get(deploymentRouterUnavailableHeader) != "" || response.Header.Get(legacyDeploymentRouterUnavailableHeader) != "" {
		return false
	}
	return response.StatusCode != http.StatusBadGateway && response.StatusCode != http.StatusGatewayTimeout
}

// memberEndpointIDs are the relay endpoint ids of a policy's member links on
// this node.
func (p *DockerPlugin) memberEndpointIDs(policyID string) map[string]bool {
	links := map[string]bool{}
	for _, linkID := range p.availabilityMemberLinks()[policyID] {
		links[linkID] = true
	}
	result := map[string]bool{}
	if p.relayGrants == nil {
		return result
	}
	for _, assignment := range p.relayGrants.get().GetGrants() {
		if assignment.GetRole() == "endpoint" && isConnectorIngressOwnerKind(assignment.GetOwnerKind()) && links[assignment.GetOwnerId()] && assignment.GetEndpointId() != "" {
			result[assignment.GetEndpointId()] = true
		}
	}
	return result
}

// closeMemberTunnels ends the relay tunnels this node accepted for the given
// endpoints and returns channels that close once each has ended.
func (p *DockerPlugin) closeMemberTunnels(endpointIDs map[string]bool) []chan struct{} {
	if len(endpointIDs) == 0 {
		return nil
	}
	p.relayTunnelMu.Lock()
	routers := make([]*relayTunnelRouter, 0, len(p.relayTunnels))
	for _, router := range p.relayTunnels {
		if router != nil {
			routers = append(routers, router)
		}
	}
	p.relayTunnelMu.Unlock()
	var closing []chan struct{}
	for _, router := range routers {
		router.mu.Lock()
		for tunnel := range router.accepted {
			if !endpointIDs[tunnel.endpointID] {
				continue
			}
			tunnel.cancel()
			if tunnel.done != nil {
				closing = append(closing, tunnel.done)
			}
		}
		router.mu.Unlock()
	}
	return closing
}
