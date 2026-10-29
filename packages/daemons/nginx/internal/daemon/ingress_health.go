package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// ingressGroupCapability tells Opfield this daemon answers the reserved ingress health endpoint and renders per
// member, so the node may join an ingress group (decisions S10).
const ingressGroupCapability = "ingress_group_v1"

const (
	ingressHealthSelfProbeInterval = 15 * time.Second
	ingressHealthCertCheckInterval = 12 * time.Hour
	// An observation of the generation nginx serves counts for this long (a few missed self-probes).
	ingressHealthObservationTTL = 2 * time.Minute
)

// ingressHealthStatus is what the reserved health paths (/.well-known/opfield-ingress-health and the pre-Opfield
// the legacy health path) answer: serving only while nginx runs, runs the configuration of the daemon's
// last successful reload, and — on a node that sources Secure Links — at least one relay transport is up. Everything
// is local: it keeps answering while Opfield is unreachable.
type ingressHealthStatus struct {
	Status                string    `json:"status"`
	Serving               bool      `json:"serving"`
	Reasons               []string  `json:"reasons,omitempty"`
	ConfigGeneration      uint64    `json:"configGeneration"`
	ServedGeneration      uint64    `json:"servedGeneration,omitempty"`
	GenerationVerified    bool      `json:"generationVerified"`
	NginxRunning          bool      `json:"nginxRunning"`
	ConfigApplied         bool      `json:"configApplied"`
	SecureLinkSources     int       `json:"secureLinkSources"`
	UsableRelayTransports int       `json:"usableRelayTransports"`
	CheckedAt             time.Time `json:"checkedAt"`
}

type ingressHealthInputs struct {
	nginxRunning      bool
	expected          uint64
	served            uint64
	servedKnown       bool
	secureLinkSources int
	usableTransports  int
	now               time.Time
}

func evaluateIngressHealth(in ingressHealthInputs) ingressHealthStatus {
	status := ingressHealthStatus{
		ConfigGeneration:      in.expected,
		ServedGeneration:      in.served,
		GenerationVerified:    in.servedKnown,
		NginxRunning:          in.nginxRunning,
		SecureLinkSources:     in.secureLinkSources,
		UsableRelayTransports: in.usableTransports,
		CheckedAt:             in.now.UTC(),
	}
	if !in.nginxRunning {
		status.Reasons = append(status.Reasons, "nginx is not running")
	}
	status.ConfigApplied = !in.servedKnown || in.served == in.expected
	if in.servedKnown && in.served != in.expected {
		status.Reasons = append(status.Reasons, fmt.Sprintf(
			"nginx serves config generation %d, the daemon applied generation %d (the last reload was not loaded)",
			in.served, in.expected,
		))
	}
	if in.secureLinkSources > 0 && in.usableTransports == 0 {
		status.Reasons = append(status.Reasons, fmt.Sprintf(
			"no relay transport is connected for %d Secure Link source(s)", in.secureLinkSources,
		))
	}
	status.Serving = len(status.Reasons) == 0
	if status.Serving {
		status.Status = "serving"
	} else {
		status.Status = "unavailable"
	}
	return status
}

type ingressHealthResponder struct {
	plugin   *NginxPlugin
	logger   *slog.Logger
	listener net.Listener
	// socketPath is where the responder listens (the path it started with; see socket_names.go).
	socketPath string
	keptName   string
	server     *http.Server
	cancel     context.CancelFunc

	// inputs gathers the local state a status is computed from (replaced in tests).
	inputs func(now time.Time) ingressHealthInputs

	mu            sync.Mutex
	observed      uint64
	observedAt    time.Time
	last          ingressHealthStatus
	lastSelfProbe error
}

// startIngressHealthResponder listens on the responder socket nginx proxies the reserved path to, and starts the
// self-probe (for the health report) and the certificate renewal of the reserved server.
func startIngressHealthResponder(plugin *NginxPlugin, logger *slog.Logger) (*ingressHealthResponder, error) {
	if err := os.MkdirAll(nginx.IngressHealthSocketDir(), 0o755); err != nil {
		return nil, err
	}
	// The endpoint only reports health; any local process (nginx workers run as another user) may read it. The
	// socket the previous process kept is taken over (service_sockets.go).
	socketPath := nginx.IngressHealthSocketPath()
	listener, keptName, err := listenServiceSocket(socketPath, 0o666)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	responder := &ingressHealthResponder{plugin: plugin, logger: logger, listener: listener, socketPath: socketPath, keptName: keptName, cancel: cancel}
	responder.inputs = responder.pluginInputs
	mux := http.NewServeMux()
	mux.HandleFunc("/health", responder.serveHealth)
	responder.server = &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 5 * time.Second}
	go func() {
		if err := responder.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("ingress health responder stopped", "error", err)
		}
	}()
	go responder.run(ctx)
	return responder, nil
}

func (r *ingressHealthResponder) close() {
	if r == nil {
		return
	}
	r.cancel()
	// Once the daemon handed its sockets to the next process, so does the responder.
	remove := releaseServiceSocket(r.listener, r.socketPath, r.keptName, r.plugin.socketsHandedOver())
	_ = r.server.Close()
	_ = r.listener.Close()
	remove()
}

func (r *ingressHealthResponder) pluginInputs(now time.Time) ingressHealthInputs {
	return ingressHealthInputs{
		nginxRunning:      r.plugin.mgr.IsRunning(),
		expected:          r.plugin.mgr.ConfigGeneration(),
		secureLinkSources: r.plugin.secureLinkSourceCount(),
		usableTransports:  r.plugin.usableRelayTransportCount(),
		now:               now,
	}
}

func (r *ingressHealthResponder) serveHealth(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	now := time.Now()
	in := r.inputs(now)
	value := req.Header.Get(nginx.IngressGenerationHeader)
	if value == "" {
		// legacy-name: the generation header of configs rendered for the pre-Opfield names — remove once every node reports none
		value = req.Header.Get(nginx.LegacyIngressGenerationHeader)
	}
	if value != "" {
		if served, err := strconv.ParseUint(value, 10, 64); err == nil {
			in.served, in.servedKnown = served, true
			r.mu.Lock()
			r.observed, r.observedAt = served, now
			r.mu.Unlock()
		}
	}
	status := evaluateIngressHealth(in)
	r.mu.Lock()
	r.last = status
	r.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if status.Serving {
		w.WriteHeader(http.StatusOK)
	} else {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	if req.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(status)
	}
}

// current is the status for the health report: the served generation comes from the most recent probe that went
// through nginx (the self-probe every 15 s), so a reload nginx did not load shows as not serving.
func (r *ingressHealthResponder) current() ingressHealthStatus {
	now := time.Now()
	in := r.inputs(now)
	r.mu.Lock()
	if !r.observedAt.IsZero() && now.Sub(r.observedAt) <= ingressHealthObservationTTL {
		in.served, in.servedKnown = r.observed, true
	}
	selfProbeErr := r.lastSelfProbe
	r.mu.Unlock()
	status := evaluateIngressHealth(in)
	if !in.servedKnown && selfProbeErr != nil && in.nginxRunning {
		status.Reasons = append(status.Reasons, "nginx did not answer the local health probe: "+selfProbeErr.Error())
		status.Serving = false
		status.Status = "unavailable"
	}
	return status
}

func (r *ingressHealthResponder) run(ctx context.Context) {
	probe := time.NewTicker(ingressHealthSelfProbeInterval)
	defer probe.Stop()
	certs := time.NewTicker(ingressHealthCertCheckInterval)
	defer certs.Stop()
	r.selfProbe(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-probe.C:
			r.selfProbe(ctx)
		case <-certs.C:
			r.plugin.renewIngressHealthCertificate(r.logger)
		}
	}
}

// selfProbe sends the reserved request through the local nginx, so the responder sees the generation nginx serves.
func (r *ingressHealthResponder) selfProbe(ctx context.Context) {
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(probeCtx, http.MethodGet, "http://127.0.0.1"+nginx.IngressHealthPath, nil)
	if err != nil {
		return
	}
	request.Host = nginx.IngressHealthHost()
	client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	response, err := client.Do(request)
	if err == nil {
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusServiceUnavailable {
			err = fmt.Errorf("unexpected status %d", response.StatusCode)
		}
	}
	r.mu.Lock()
	r.lastSelfProbe = err
	r.mu.Unlock()
}

// report is the HealthReport copy of the endpoint's answer.
func (r *ingressHealthResponder) report() *pb.IngressHealthReport {
	if r == nil {
		return nil
	}
	status := r.current()
	reason := ""
	for index, item := range status.Reasons {
		if index > 0 {
			reason += "; "
		}
		reason += item
	}
	return &pb.IngressHealthReport{
		Serving:               status.Serving,
		Reason:                reason,
		ConfigGeneration:      status.ConfigGeneration,
		NginxRunning:          status.NginxRunning,
		ConfigApplied:         status.ConfigApplied,
		SecureLinkSources:     uint32(status.SecureLinkSources),
		UsableRelayTransports: uint32(status.UsableRelayTransports),
		CheckedAtUnixMs:       status.CheckedAt.UnixMilli(),
	}
}

// secureLinkSourceCount is the number of proxy Secure Link sources this node serves.
func (p *NginxPlugin) secureLinkSourceCount() int {
	if p.secureLinks == nil {
		return 0
	}
	p.secureLinks.mu.Lock()
	defer p.secureLinks.mu.Unlock()
	return len(p.secureLinks.bindings)
}

// usableRelayTransportCount is the number of relays this node holds a live tunnel lane to.
func (p *NginxPlugin) usableRelayTransportCount() int {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	targets := map[string]bool{}
	for _, tunnel := range p.relayTunnels {
		if tunnel.ctx.Err() == nil {
			targets[tunnel.targetID] = true
		}
	}
	return len(targets)
}

// ensureIngressHealthConfig installs everything the reserved endpoint needs: the config generation variable, the
// reserved-hostname server with its self-signed certificate, and the health location in the installer's HTTP
// default server. Each piece stays only when nginx accepts the configuration with it. Returns whether the config
// changed (the caller reloads) and whether the generation variable is in place (without it the node cannot render
// the health location, and does not advertise ingress groups).
func (p *NginxPlugin) ensureIngressHealthConfig(logger *slog.Logger) (changed bool, ready bool) {
	written, err := p.mgr.EnsureConfigGeneration()
	if err != nil {
		logger.Warn("failed to write the ingress config generation", "error", err)
		return false, false
	}
	changed = written
	if valid, output := p.mgr.TestConfig(); !valid {
		logger.Warn("nginx configuration is invalid; ingress health is unavailable", "output", output)
		return changed, false
	}

	if _, err := nginx.EnsureIngressHealthCertificate(p.cfg.Nginx.CertsDir, time.Now()); err != nil {
		logger.Warn("failed to create the ingress health certificate", "error", err)
	} else if serverWritten, err := nginx.EnsureIngressHealthServer(p.cfg.Nginx.ConfigDir, p.cfg.Nginx.CertsDir); err != nil {
		logger.Warn("failed to write the ingress health server", "error", err)
	} else if serverWritten {
		if valid, output := p.mgr.TestConfig(); valid {
			changed = true
		} else {
			_ = nginx.RemoveFile(nginx.IngressHealthServerPath(p.cfg.Nginx.ConfigDir))
			logger.Warn("ingress health server not installed: it conflicts with this node's nginx configuration", "output", output)
		}
	}

	if path, original, patched, ok := nginx.DefaultHTTPServerHealthPatch(p.cfg.Nginx.GlobalConfig); ok {
		if err := nginx.WriteAtomic(path, patched); err != nil {
			logger.Warn("failed to add the ingress health location to the default HTTP server", "error", err)
		} else if valid, output := p.mgr.TestConfig(); valid {
			changed = true
			logger.Info("added the ingress health location to the default HTTP server", "path", path)
		} else {
			_ = nginx.WriteAtomic(path, original)
			logger.Warn("ingress health location not added to the default HTTP server", "output", output)
		}
	}
	return changed, true
}

// renewIngressHealthCertificate replaces the reserved server's certificate before it expires and reloads nginx.
func (p *NginxPlugin) renewIngressHealthCertificate(logger *slog.Logger) {
	if p.handler != nil {
		// Never between the write and the test of a command's change.
		p.handler.mutationMu.Lock()
		defer p.handler.mutationMu.Unlock()
	}
	renewed, err := nginx.EnsureIngressHealthCertificate(p.cfg.Nginx.CertsDir, time.Now())
	if err != nil {
		logger.Warn("failed to renew the ingress health certificate", "error", err)
		return
	}
	if !renewed {
		return
	}
	if valid, output := p.mgr.TestConfig(); !valid {
		logger.Warn("nginx configuration is invalid after renewing the ingress health certificate", "output", output)
		return
	}
	if err := p.mgr.Reload(); err != nil {
		logger.Warn("nginx reload after renewing the ingress health certificate failed", "error", err)
		return
	}
	logger.Info("renewed the ingress health certificate")
}
