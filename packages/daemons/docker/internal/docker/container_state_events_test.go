package docker

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// fakeStateDocker is a Docker Engine API with one container "app" whose state the test sets, and an event stream the
// test writes to.
type fakeStateDocker struct {
	mu     sync.Mutex
	state  string
	events *io.PipeReader
	// onStats runs when a metrics pass samples the container.
	onStats func()
}

func (d *fakeStateDocker) setState(state string) {
	d.mu.Lock()
	d.state = state
	d.mu.Unlock()
}

func (d *fakeStateDocker) client(t *testing.T) *Client {
	t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			reply := func(body io.ReadCloser) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}},
					Body: body, Request: request}, nil
			}
			path := request.URL.Path
			switch {
			case strings.HasSuffix(path, "/events"):
				return reply(d.events)
			case strings.HasSuffix(path, "/containers/json"):
				d.mu.Lock()
				state := d.state
				d.mu.Unlock()
				return reply(io.NopCloser(strings.NewReader(`[{"Id":"c1","Names":["/app"],"Image":"img","State":"` + state + `"}]`)))
			case strings.HasSuffix(path, "/containers/c1/stats"):
				if d.onStats != nil {
					d.onStats()
				}
				return reply(io.NopCloser(strings.NewReader(`{"cpu_stats":{},"memory_stats":{"usage":1048576}}`)))
			case strings.HasSuffix(path, "/containers/c1/json"):
				return reply(io.NopCloser(strings.NewReader(`{"Id":"c1","Name":"/app","State":{"Status":"running"}}`)))
			}
			t.Errorf("unexpected Docker request %s %s", request.Method, path)
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(`{}`)), Request: request}, nil
		})}))
	if err != nil {
		t.Fatal(err)
	}
	return &Client{cli: cli}
}

func stateOf(collector *StatsCollector, id string) string {
	for _, stats := range collector.GetStats() {
		if stats.ContainerId == id {
			return stats.State
		}
	}
	return ""
}

// TestContainerExitSendsAHealthReportAtOnce: a container that exits on its own reaches Gateway with the next health
// report, sent at once, instead of up to a minute later with the periodic one.
func TestContainerExitSendsAHealthReportAtOnce(t *testing.T) {
	events, stream := io.Pipe()
	t.Cleanup(func() { _ = stream.Close() })
	docker := &fakeStateDocker{state: "running", events: events}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := &DockerPlugin{client: docker.client(t), logger: logger, healthRefresh: make(chan struct{}, 1)}
	collector := NewStatsCollector(p.client, NewAllowlistChecker([]string{"*"}), logger)
	collector.stats = map[string]*pb.ContainerStats{
		"c1": {ContainerId: "c1", Name: "app", Image: "img", State: "running", CpuPercent: 5},
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go p.followContainerStates(ctx, collector)

	docker.setState("exited")
	if _, err := stream.Write([]byte(`{"Type":"container","Action":"die","Actor":{"ID":"c1"},"time":1700000000}` + "\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.HealthRefreshRequested():
	case <-time.After(5 * time.Second):
		t.Fatal("no health report was requested after the container exited")
	}
	if state := stateOf(collector, "c1"); state != "exited" {
		t.Fatalf("the requested report carries state %q, want exited", state)
	}
}

// TestMetricsPassKeepsTheStatesOfANewerRefresh: a metrics pass that sampled a container before it exited does not
// bring its old running state back over the state an event refreshed meanwhile.
func TestMetricsPassKeepsTheStatesOfANewerRefresh(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	docker := &fakeStateDocker{state: "running"}
	collector := NewStatsCollector(docker.client(t), NewAllowlistChecker([]string{"*"}), logger)
	docker.onStats = func() {
		docker.onStats = nil
		docker.setState("exited")
		if changed, err := collector.refreshStates(context.Background()); err != nil || !changed {
			t.Errorf("refresh during the metrics pass: changed=%v err=%v", changed, err)
		}
	}
	collector.collect(context.Background())
	if state := stateOf(collector, "c1"); state != "exited" {
		t.Fatalf("after the metrics pass the container is %q, want exited", state)
	}
}
