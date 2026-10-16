package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	mobyclient "github.com/moby/moby/client"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
)

// The Docker Engine can start containers only while dockerd and the containerd
// it runs them with both answer. Running containers keep running while
// containerd is down (their shims stay), so nothing else shows it until the
// next start, deploy or restart fails: on the stand containerd crash-looped
// for a day on a damaged meta.db while the node looked fine (F-12). The daemon
// probes both in the background and the health report carries the last result
// (HealthReport.docker_engine_health).
const (
	engineHealthInterval     = 20 * time.Second
	engineHealthPingTimeout  = 5 * time.Second
	engineHealthCheckTimeout = 3 * time.Second
	// containerdAddressRefresh is how often the containerd address dockerd
	// reports is looked up again (it changes only with dockerd's config).
	containerdAddressRefresh = 10 * time.Minute

	engineComponentDockerd    = "dockerd"
	engineComponentContainerd = "containerd"
)

// defaultContainerdSockets are where containerd listens when dockerd does not
// name its address (Docker before API 1.46): the system containerd service,
// then the containerd dockerd starts itself.
var defaultContainerdSockets = []string{"/run/containerd/containerd.sock", "/var/run/docker/containerd/containerd.sock"}

// engineProbeResult is one check of the engine; component and problem are
// empty while it is available.
type engineProbeResult struct {
	available bool
	component string
	problem   string
}

// engineHealth keeps the last probe result for the health report.
type engineHealth struct {
	mu               sync.Mutex
	checked          bool
	checkedAt        time.Time
	result           engineProbeResult
	unavailableSince time.Time
}

// record keeps a probe result and reports whether availability flipped (the
// first result counts as a flip only when unavailable).
func (h *engineHealth) record(result engineProbeResult, at time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	flipped := h.checked && h.result.available != result.available || !h.checked && !result.available
	if result.available {
		h.unavailableSince = time.Time{}
	} else if h.unavailableSince.IsZero() {
		h.unavailableSince = at
	}
	h.checked = true
	h.checkedAt = at
	h.result = result
	return flipped
}

// report is the last result for the health report; nil before the first
// probe ended.
func (h *engineHealth) report() *pb.DockerEngineHealth {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.checked {
		return nil
	}
	report := &pb.DockerEngineHealth{
		Available:       h.result.available,
		Component:       h.result.component,
		Problem:         h.result.problem,
		CheckedAtUnixMs: h.checkedAt.UnixMilli(),
	}
	if !h.unavailableSince.IsZero() {
		report.UnavailableSinceUnixMs = h.unavailableSince.UnixMilli()
	}
	return report
}

// engineProber checks dockerd and containerd. Tests replace its functions.
type engineProber struct {
	dockerSocket string
	ping         func(ctx context.Context) error
	// containerdAddress is the containerd socket dockerd reports ("" when
	// it reports none).
	containerdAddress func(ctx context.Context) (string, error)
	defaultSockets    []string
	dial              func(ctx context.Context, path string) (net.Conn, error)
	pingTimeout       time.Duration
	checkTimeout      time.Duration

	address   string    // from dockerd, kept between lookups
	addressAt time.Time // when it was last looked up
	lastGood  string    // the socket that last answered
}

func newEngineProber(dockerSocket string, ping func(ctx context.Context) error, containerdAddress func(ctx context.Context) (string, error)) *engineProber {
	return &engineProber{
		dockerSocket:      dockerSocket,
		ping:              ping,
		containerdAddress: containerdAddress,
		defaultSockets:    defaultContainerdSockets,
		dial: func(ctx context.Context, path string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", path)
		},
		pingTimeout:  engineHealthPingTimeout,
		checkTimeout: engineHealthCheckTimeout,
	}
}

func (p *engineProber) probe(ctx context.Context, now time.Time) engineProbeResult {
	pingCtx, cancel := context.WithTimeout(ctx, p.pingTimeout)
	err := p.ping(pingCtx)
	cancel()
	if err != nil {
		return engineProbeResult{
			component: engineComponentDockerd,
			problem:   fmt.Sprintf("dockerd does not answer at %s (%s), so no container can be started, stopped or changed", strings.TrimPrefix(p.dockerSocket, "unix://"), describeDialError(err)),
		}
	}
	sockets, known := p.containerdSockets(ctx, now)
	if len(sockets) == 0 {
		return engineProbeResult{available: true}
	}
	// Without a known socket every usual one that exists is tried: a stale
	// socket file of a containerd no longer in use must not hide the one
	// dockerd runs with.
	var first engineProbeResult
	for i, socket := range sockets {
		result, answered := p.checkContainerd(ctx, socket, known)
		if answered {
			p.lastGood = socket
		}
		if result.available {
			return result
		}
		if i == 0 {
			first = result
		}
	}
	return first
}

// containerdSockets are the sockets to check and whether they are known to be
// containerd's (dockerd named it, or it answered before): a known socket that
// is missing means containerd is down. None when no socket is known and none
// of the usual ones exists: nothing is claimed then.
func (p *engineProber) containerdSockets(ctx context.Context, now time.Time) ([]string, bool) {
	if p.containerdAddress != nil && (p.addressAt.IsZero() || now.Sub(p.addressAt) >= containerdAddressRefresh) {
		lookupCtx, cancel := context.WithTimeout(ctx, p.pingTimeout)
		address, err := p.containerdAddress(lookupCtx)
		cancel()
		p.addressAt = now
		if err == nil {
			p.address = strings.TrimPrefix(strings.TrimSpace(address), "unix://")
		}
	}
	if p.address != "" {
		return []string{p.address}, true
	}
	if p.lastGood != "" {
		return []string{p.lastGood}, true
	}
	var existing []string
	for _, socket := range p.defaultSockets {
		if _, err := os.Stat(socket); err == nil {
			existing = append(existing, socket)
		}
	}
	return existing, false
}

// checkContainerd dials containerd's socket and asks its gRPC health service;
// answered is whether containerd answered there (whatever its status). A
// socket this daemon may not open (rootless Docker, a daemon not run as root)
// says nothing about containerd: it counts as available.
func (p *engineProber) checkContainerd(ctx context.Context, socket string, known bool) (result engineProbeResult, answered bool) {
	checkCtx, cancel := context.WithTimeout(ctx, p.checkTimeout)
	defer cancel()
	conn, err := p.dial(checkCtx, socket)
	if err != nil {
		switch {
		case errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM):
			return engineProbeResult{available: true}, false
		case errors.Is(err, syscall.ENOENT) && !known:
			return engineProbeResult{available: true}, false
		case errors.Is(err, syscall.ENOENT):
			return containerdDown(fmt.Sprintf("containerd's socket %s is gone, so containerd is not running and no new container can start", socket)), false
		}
		return containerdDown(fmt.Sprintf("containerd does not answer at %s (%s), so no new container can start", socket, describeDialError(err))), false
	}
	_ = conn.Close()

	client, err := grpc.NewClient("passthrough:///containerd",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return p.dial(ctx, socket) }),
	)
	if err != nil {
		return containerdDown(fmt.Sprintf("containerd at %s cannot be checked (%v), so new containers may not start", socket, err)), false
	}
	defer client.Close()
	response, err := healthpb.NewHealthClient(client).Check(checkCtx, &healthpb.HealthCheckRequest{})
	if err != nil {
		if status.Code(err) == codes.Unimplemented {
			// It answers, without the health service.
			return engineProbeResult{available: true}, true
		}
		return containerdDown(fmt.Sprintf("containerd does not answer its health check at %s (%s), so no new container can start", socket, describeGRPCError(err))), false
	}
	if response.GetStatus() != healthpb.HealthCheckResponse_SERVING {
		return containerdDown(fmt.Sprintf("containerd at %s reports %s, so no new container can start", socket, response.GetStatus())), true
	}
	return engineProbeResult{available: true}, true
}

func containerdDown(problem string) engineProbeResult {
	return engineProbeResult{component: engineComponentContainerd, problem: problem}
}

// describeDialError is the errno text of a failed connection ("connection
// refused"), else the error.
func describeDialError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return "no answer within the timeout"
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno.Error()
	}
	return err.Error()
}

func describeGRPCError(err error) string {
	if s, ok := status.FromError(err); ok {
		if s.Code() == codes.DeadlineExceeded {
			return "no answer within the timeout"
		}
		return s.Message()
	}
	return err.Error()
}

// runEngineHealth probes the engine for the life of the process and asks for a
// health report at once when its availability flips.
func (p *DockerPlugin) runEngineHealth(ctx context.Context) {
	prober := newEngineProber(p.cfg.Docker.Socket, p.client.Ping, p.lookupContainerdAddress)
	ticker := time.NewTicker(engineHealthInterval)
	defer ticker.Stop()
	for {
		p.observeEngineHealth(prober.probe(ctx, time.Now()), time.Now())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (p *DockerPlugin) observeEngineHealth(result engineProbeResult, at time.Time) {
	if !p.engineHealth.record(result, at) {
		return
	}
	if result.available {
		p.logger.Info("Docker Engine answers again: containers can start")
	} else {
		p.logger.Warn("Docker Engine cannot start containers", "component", result.component, "problem", result.problem)
	}
	p.requestHealthRefresh()
}

func (p *DockerPlugin) lookupContainerdAddress(ctx context.Context) (string, error) {
	if p.client == nil || p.client.cli == nil {
		return "", errors.New("no Docker client")
	}
	info, err := p.client.cli.Info(ctx, mobyclient.InfoOptions{})
	if err != nil {
		return "", err
	}
	if info.Info.Containerd == nil {
		return "", nil
	}
	return info.Info.Containerd.Address, nil
}
