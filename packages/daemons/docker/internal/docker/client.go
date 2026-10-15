package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/gpu"
)

const (
	defaultContainerStopTimeoutSeconds = 20
	maxDockerLogReadBytes              = 8 * 1024 * 1024
	maxDockerLogLineBytes              = 1024 * 1024
	opfieldGPUGroupIDsLabel            = "net.opfield.gpu.group-ids"
	opfieldGPUGroupIDsVersionLabel     = "net.opfield.gpu.group-ids-version"
	opfieldGPUGroupIDsVersion          = "1"
)

var errDockerLogsTooLarge = errors.New("docker logs response exceeds safety limit")

var detailedContainerTopArgs = []string{"-eo", "pid,user,%cpu,%mem,vsz,rss,tty,stat,start,time,comm"}

// Client wraps the Docker SDK client with convenience methods.
type Client struct {
	cli    *client.Client
	logger *slog.Logger
	// beforeStart gates every user-workload start (availability lease A5,
	// A12.1); nil outside lease-capable daemons.
	beforeStart              func(ctx context.Context, containerID string) error
	gpuInventory             gpuInventory
	recreateStateDirectory   string
	runscHealthy             atomic.Bool
	managedVolumeCreateMutex sync.Mutex
	// defaultLogDriver caches the Docker daemon's default logging driver,
	// detected once at startup; nil means unknown (treated as json-file).
	defaultLogDriver atomic.Pointer[string]
	listeningPorts   listeningPortCache
	// databaseLinkOnConnector reports a database link network whose binding the shared connector serves (C6, F4);
	// nil without secure links.
	databaseLinkOnConnector func(networkName string) bool
	// ownOps records the container changes this client makes, so Docker
	// events of anyone else's read as changes outside Opfield; nil records
	// nothing.
	ownOps *ownContainerOps
}

func (c *Client) SetRunscHealthy(healthy bool) {
	c.runscHealthy.Store(healthy)
}

type gpuInventory interface {
	Collect(context.Context) []gpu.Device
	Resolve(context.Context, []string) ([]gpu.Device, error)
}

type HTTPProbeConfig struct {
	Scheme         string `json:"scheme"`
	HostPort       uint16 `json:"hostPort"`
	Path           string `json:"path"`
	StatusMin      int    `json:"statusMin"`
	StatusMax      int    `json:"statusMax"`
	ExpectedBody   string `json:"expectedBody"`
	BodyMatchMode  string `json:"bodyMatchMode"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	SlowThreshold  int64  `json:"slowThreshold"`
}

type HTTPProbeResult struct {
	OK         bool   `json:"ok"`
	Status     string `json:"status"`
	HTTPStatus int    `json:"httpStatus,omitempty"`
	ResponseMs int64  `json:"responseMs,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ContainerInfo holds summary information about a container.
type ContainerInfo struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	ImageID string            `json:"imageId,omitempty"`
	State   string            `json:"state"`
	Status  string            `json:"status"`
	Created int64             `json:"created"`
	Ports   []PortInfo        `json:"ports"`
	Labels  map[string]string `json:"labels,omitempty"`
	// ListeningPorts are the TCP ports the running container listens on; null when unknown.
	ListeningPorts []uint16 `json:"listeningPorts"`
}

// PortInfo describes a port mapping on a container.
type PortInfo struct {
	PrivatePort uint16 `json:"privatePort"`
	PublicPort  uint16 `json:"publicPort,omitempty"`
	Type        string `json:"type"`
	IP          string `json:"ip,omitempty"`
}

// NewClient creates a Docker SDK client connected to the given socket path.
func NewClient(socketPath string, stateDir string, logger *slog.Logger) (*Client, error) {
	httpClient, err := labelHTTPClient(socketPath)
	if err != nil {
		return nil, fmt.Errorf("create docker client: %w", err)
	}
	ownOps := newOwnContainerOps()
	httpClient.Transport = &ownOpsTransport{base: httpClient.Transport, ops: ownOps}
	cli, err := client.NewClientWithOpts(
		client.WithHost(socketPath),
		// After WithHost, which configures only a plain *http.Transport: the
		// label transport carries its own, configured for the same host.
		client.WithHTTPClient(httpClient),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("create docker client: %w", err)
	}
	return &Client{
		cli:                    cli,
		logger:                 logger,
		gpuInventory:           gpu.NewCollector(logger),
		recreateStateDirectory: filepath.Join(stateDir, "recreate-state"),
		ownOps:                 ownOps,
	}, nil
}

// Close releases the underlying Docker client resources.
func (c *Client) Close() error {
	return c.cli.Close()
}

// Ping checks connectivity to the Docker daemon.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.cli.Ping(ctx, client.PingOptions{})
	if err != nil {
		return fmt.Errorf("docker ping: %w", err)
	}
	return nil
}

// GetVersion returns the Docker engine version string.
func (c *Client) GetVersion(ctx context.Context) (string, error) {
	ver, err := c.cli.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return "", fmt.Errorf("docker version: %w", err)
	}
	return ver.Version, nil
}

// CountContainers returns the number of running, stopped, and total containers.
func (c *Client) CountContainers(ctx context.Context) (running, stopped, total int, err error) {
	result, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return 0, 0, 0, fmt.Errorf("container list: %w", err)
	}
	total = len(result.Items)
	for _, ctr := range result.Items {
		if string(ctr.State) == "running" {
			running++
		} else {
			stopped++
		}
	}
	return running, stopped, total, nil
}

// ListContainers returns summary info for all containers (running and stopped).
func (c *Client) ListContainers(ctx context.Context) ([]ContainerInfo, error) {
	result, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("container list: %w", err)
	}

	containers := make([]ContainerInfo, 0, len(result.Items))
	for _, ctr := range result.Items {
		name := ""
		if len(ctr.Names) > 0 {
			name = strings.TrimPrefix(ctr.Names[0], "/")
		}

		ports := make([]PortInfo, 0, len(ctr.Ports))
		for _, p := range ctr.Ports {
			pi := PortInfo{
				PrivatePort: p.PrivatePort,
				PublicPort:  p.PublicPort,
				Type:        p.Type,
			}
			if p.IP.IsValid() {
				pi.IP = p.IP.String()
			}
			ports = append(ports, pi)
		}

		containers = append(containers, ContainerInfo{
			ID:      ctr.ID,
			Name:    name,
			Image:   ctr.Image,
			ImageID: ctr.ImageID,
			State:   string(ctr.State),
			Status:  ctr.Status,
			Created: ctr.Created,
			Ports:   ports,
			Labels:  ctr.Labels,
		})
	}
	return containers, nil
}

// InspectContainer returns the full inspect JSON for a container.
func (c *Client) InspectContainer(ctx context.Context, id string) (json.RawMessage, error) {
	result, err := c.cli.ContainerInspect(ctx, id, client.ContainerInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("container inspect: %w", err)
	}
	data, err := json.Marshal(result.Container)
	if err != nil {
		return nil, fmt.Errorf("marshal inspect: %w", err)
	}
	return data, nil
}

// StartContainer starts a stopped container.
func (c *Client) StartContainer(ctx context.Context, id string) error {
	if err := c.gateStart(ctx, id); err != nil {
		return err
	}
	if _, err := c.cli.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("container start: %w", err)
	}
	return nil
}

// StopContainer stops a running container with a timeout in seconds.
func (c *Client) StopContainer(ctx context.Context, id string, timeoutSec int) error {
	if _, err := c.cli.ContainerStop(ctx, id, client.ContainerStopOptions{Timeout: &timeoutSec}); err != nil {
		return fmt.Errorf("container stop: %w", err)
	}
	return nil
}

// RestartContainer restarts a container with a timeout in seconds.
func (c *Client) RestartContainer(ctx context.Context, id string, timeoutSec int) error {
	if err := c.gateStart(ctx, id); err != nil {
		return err
	}
	if _, err := c.cli.ContainerRestart(ctx, id, client.ContainerRestartOptions{Timeout: &timeoutSec}); err != nil {
		return fmt.Errorf("container restart: %w", err)
	}
	return nil
}

// KillContainer sends a signal to a container.
func (c *Client) KillContainer(ctx context.Context, id string, signal string) error {
	if _, err := c.cli.ContainerKill(ctx, id, client.ContainerKillOptions{Signal: signal}); err != nil {
		return fmt.Errorf("container kill: %w", err)
	}
	return nil
}

// RemoveContainer removes a container, optionally with force.
func (c *Client) RemoveContainer(ctx context.Context, id string, force bool) error {
	if _, err := c.cli.ContainerRemove(ctx, id, client.ContainerRemoveOptions{Force: force}); err != nil {
		return fmt.Errorf("container remove: %w", err)
	}
	return nil
}

// RenameContainer renames a container.
func (c *Client) RenameContainer(ctx context.Context, id string, newName string) error {
	if _, err := c.cli.ContainerRename(ctx, id, client.ContainerRenameOptions{NewName: newName}); err != nil {
		return fmt.Errorf("container rename: %w", err)
	}
	return nil
}

// ContainerStatsOnce fetches a one-shot stats snapshot for a container.
func (c *Client) ContainerStatsOnce(ctx context.Context, id string) (json.RawMessage, error) {
	result, err := c.cli.ContainerStats(ctx, id, client.ContainerStatsOptions{
		Stream:                false,
		IncludePreviousSample: true,
	})
	if err != nil {
		return nil, fmt.Errorf("container stats: %w", err)
	}
	defer result.Body.Close()
	body, err := io.ReadAll(result.Body)
	if err != nil {
		return nil, fmt.Errorf("read stats body: %w", err)
	}
	return json.RawMessage(body), nil
}

// ContainerTop returns the running processes inside a container (like docker top).
func (c *Client) ContainerTop(ctx context.Context, id string) (json.RawMessage, error) {
	top, err := c.cli.ContainerTop(ctx, id, client.ContainerTopOptions{Arguments: detailedContainerTopArgs})
	if err != nil {
		fallbackTop, fallbackErr := c.cli.ContainerTop(ctx, id, client.ContainerTopOptions{})
		if fallbackErr != nil {
			return nil, fmt.Errorf("container top: detailed ps args failed: %w; fallback without ps_args failed: %v", err, fallbackErr)
		}
		top = fallbackTop
	}
	data, err := json.Marshal(top)
	if err != nil {
		return nil, fmt.Errorf("marshal top: %w", err)
	}
	return data, nil
}

// ContainerLogs retrieves the last `tail` lines of logs from a container.
// It strips the 8-byte Docker multiplexed log header from each frame.
// Optional since/until parameters filter by RFC3339 timestamp range.
func (c *Client) ContainerLogs(ctx context.Context, id string, tail int, timestamps bool, since string, until string) ([]string, error) {
	// Docker quirk: --tail + --until don't work together correctly.
	// When until is set, use expanding time windows to find enough lines efficiently.
	if until != "" && tail > 0 {
		return c.containerLogsWithUntil(ctx, id, tail, timestamps, since, until)
	}

	tailStr := "all"
	if tail > 0 {
		tailStr = strconv.Itoa(tail)
	}

	opts := client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Tail:       tailStr,
		Timestamps: timestamps,
	}
	if since != "" {
		opts.Since = since
	}
	if until != "" {
		opts.Until = until
	}

	reader, err := c.cli.ContainerLogs(ctx, id, opts)
	if err != nil {
		return nil, fmt.Errorf("container logs: %w", err)
	}
	defer reader.Close()

	return parseDockerLogsBounded(reader, tail, maxDockerLogReadBytes)
}

// containerLogsWithUntil fetches the last `tail` lines before `until` using expanding time windows.
// Docker's --tail + --until don't work together, so we use --since + --until in expanding windows.
func (c *Client) containerLogsWithUntil(ctx context.Context, id string, tail int, timestamps bool, since string, until string) ([]string, error) {
	untilTime, err := time.Parse(time.RFC3339Nano, until)
	if err != nil {
		return nil, fmt.Errorf("invalid docker logs until timestamp: %w", err)
	}

	// Try expanding time windows. Start small so busy containers do not require
	// parsing an hour of logs just to return the previous page.
	windows := []time.Duration{
		30 * time.Second,
		2 * time.Minute,
		10 * time.Minute,
		1 * time.Hour,
		6 * time.Hour,
		24 * time.Hour,
		7 * 24 * time.Hour,
		30 * 24 * time.Hour,
		90 * 24 * time.Hour,
		365 * 24 * time.Hour,
		10 * 365 * 24 * time.Hour,
	}

	var lastLines []string
	for _, window := range windows {
		windowSince := untilTime.Add(-window).Format(time.RFC3339Nano)
		if since != "" {
			// Don't go before the explicit since
			sinceTime, _ := time.Parse(time.RFC3339Nano, since)
			if untilTime.Add(-window).Before(sinceTime) {
				windowSince = since
			}
		}

		opts := client.ContainerLogsOptions{
			ShowStdout: true,
			ShowStderr: true,
			Tail:       "all",
			Timestamps: timestamps,
			Since:      windowSince,
			Until:      until,
		}

		reader, err := c.cli.ContainerLogs(ctx, id, opts)
		if err != nil {
			return nil, fmt.Errorf("container logs: %w", err)
		}

		lines, err := parseDockerLogsBounded(reader, tail, maxDockerLogReadBytes)
		reader.Close()
		if err != nil {
			if errors.Is(err, errDockerLogsTooLarge) {
				return nil, fmt.Errorf("container logs history window is too large; narrow the range or reduce log volume")
			}
			return nil, err
		}

		if len(lines) >= tail {
			// Got enough — return the last `tail` lines
			return lines[len(lines)-tail:], nil
		}
		if len(lines) > 0 {
			lastLines = lines
		}

		// If we got some lines but not enough, and since was limiting us, return what we have
		if since != "" && windowSince == since {
			return lines, nil
		}
	}

	if len(lastLines) > 0 {
		return lastLines, nil
	}
	return []string{}, nil
}

// ContainerLogsFollow opens a follow-mode log stream for a container.
// It returns the io.ReadCloser and the caller is responsible for closing it.
// The stream will continue until the context is cancelled or the container stops.
// Optional since parameter starts streaming from the given RFC3339 timestamp.
func (c *Client) ContainerLogsFollow(ctx context.Context, id string, tail int, timestamps bool, since string) (io.ReadCloser, error) {
	tailStr := "0"
	if tail > 0 {
		tailStr = strconv.Itoa(tail)
	}

	opts := client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Tail:       tailStr,
		Timestamps: timestamps,
	}
	if since != "" {
		opts.Since = since
	}

	reader, err := c.cli.ContainerLogs(ctx, id, opts)
	if err != nil {
		return nil, fmt.Errorf("container logs follow: %w", err)
	}

	return reader, nil
}

// ── Container Create / Duplicate / Update ─────────────────────────

// ContainerCreateConfig is the JSON structure accepted by CreateContainer.
// It maps closely to the Docker API container creation parameters.
