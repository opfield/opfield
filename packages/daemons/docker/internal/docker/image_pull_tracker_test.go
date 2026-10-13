package docker

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/client"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// blockingPullDocker is a Docker Engine API whose image pull streams until the test releases it, then ends with
// the given error message in the progress stream (none: the pull succeeded).
func blockingPullDocker(t *testing.T, release <-chan string) *Client {
	t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if !strings.HasSuffix(request.URL.Path, "/images/create") {
				t.Errorf("unexpected Docker request %s %s", request.Method, request.URL.Path)
				return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(`{}`)), Request: request}, nil
			}
			body, stream := io.Pipe()
			go func() {
				_, _ = stream.Write([]byte(`{"status":"Pulling fs layer"}` + "\n"))
				if message := <-release; message != "" {
					_, _ = stream.Write([]byte(`{"error":"` + message + `"}` + "\n"))
				}
				_ = stream.Close()
			}()
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}},
				Body: body, Request: request}, nil
		})}))
	if err != nil {
		t.Fatal(err)
	}
	return &Client{cli: cli}
}

func pullStatus(t *testing.T, p *DockerPlugin, imageRef string) []imagePullRecord {
	t.Helper()
	result := &pb.CommandResult{CommandId: "status", Success: true}
	p.handleImageCommand(&pb.DockerImageCommand{Action: "pull_status", ImageRef: imageRef}, result)
	if !result.Success {
		t.Fatalf("pull_status failed: %s", result.Error)
	}
	var answer struct {
		Pulls []imagePullRecord `json:"pulls"`
	}
	if err := json.Unmarshal([]byte(result.Detail), &answer); err != nil {
		t.Fatalf("pull_status detail %q: %v", result.Detail, err)
	}
	return answer.Pulls
}

func waitForPullState(t *testing.T, p *DockerPlugin, imageRef, commandID, state string) imagePullRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, pull := range pullStatus(t, p, imageRef) {
			if pull.CommandID == commandID && pull.State == state {
				return pull
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("pull %s of %s never reached %s: %+v", commandID, imageRef, state, pullStatus(t, p, imageRef))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestPullStatusTellsHowALostPullEnded: Opfield lost the answer of a pull (it restarted while the pull ran on); it
// asks with pull_status by image and finds its pull by command ID: running while it runs, then how it ended.
func TestPullStatusTellsHowALostPullEnded(t *testing.T) {
	release := make(chan string)
	p := &DockerPlugin{cfg: nil, client: blockingPullDocker(t, release)}
	const ref = "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime"

	done := make(chan *pb.CommandResult, 1)
	go func() {
		result := &pb.CommandResult{CommandId: "cmd-1", Success: true}
		p.handleImageCommand(&pb.DockerImageCommand{Action: "pull", ImageRef: ref}, result)
		done <- result
	}()
	running := waitForPullState(t, p, ref, "cmd-1", "running")
	if running.StartedAtUnixMs == 0 || running.FinishedAtUnixMs != 0 {
		t.Fatalf("running pull %+v", running)
	}
	if other := pullStatus(t, p, "alpine:3.20"); len(other) != 0 {
		t.Fatalf("pulls of another image: %+v", other)
	}

	release <- ""
	if result := <-done; !result.Success {
		t.Fatalf("pull failed: %s", result.Error)
	}
	succeeded := waitForPullState(t, p, ref, "cmd-1", "succeeded")
	if succeeded.FinishedAtUnixMs == 0 || succeeded.Error != "" {
		t.Fatalf("succeeded pull %+v", succeeded)
	}

	go func() {
		result := &pb.CommandResult{CommandId: "cmd-2", Success: true}
		p.handleImageCommand(&pb.DockerImageCommand{Action: "pull", ImageRef: ref}, result)
		done <- result
	}()
	waitForPullState(t, p, ref, "cmd-2", "running")
	release <- "toomanyrequests: rate limit"
	if result := <-done; result.Success {
		t.Fatal("pull with an error in its stream succeeded")
	}
	failed := waitForPullState(t, p, ref, "cmd-2", "failed")
	if !strings.Contains(failed.Error, "toomanyrequests") {
		t.Fatalf("failed pull %+v", failed)
	}
	// Both pulls of the image are listed, oldest first.
	if pulls := pullStatus(t, p, ref); len(pulls) != 2 || pulls[0].CommandID != "cmd-1" || pulls[1].CommandID != "cmd-2" {
		t.Fatalf("pulls %+v", pulls)
	}
}

func TestPullStatusRequiresAnImage(t *testing.T) {
	p := &DockerPlugin{}
	result := &pb.CommandResult{Success: true}
	p.handleImageCommand(&pb.DockerImageCommand{Action: "pull_status"}, result)
	if result.Success || !strings.Contains(result.Error, "image_ref is required") {
		t.Fatalf("result %+v", result)
	}
}

// TestImagePullTrackerForgetsOldFinishedPulls: finished pulls are kept an hour and at most imagePullRecordLimit of
// them; running pulls are never dropped.
func TestImagePullTrackerForgetsOldFinishedPulls(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	tracker := &imagePullTracker{now: func() time.Time { return now }}
	finishOld := tracker.begin("old", "img:1")
	finishOld(nil)
	stillRunning := tracker.begin("running", "img:1")
	defer stillRunning(nil)
	now = now.Add(imagePullRetention + time.Minute)
	pulls := tracker.status("img:1")
	if len(pulls) != 1 || pulls[0].CommandID != "running" {
		t.Fatalf("after the retention: %+v", pulls)
	}

	for i := 0; i < imagePullRecordLimit+10; i++ {
		now = now.Add(time.Millisecond)
		tracker.begin("c"+strings.Repeat("x", i%3)+time.Duration(i).String(), "img:2")(errors.New("boom"))
	}
	if total := len(tracker.status("img:1")) + len(tracker.status("img:2")); total > imagePullRecordLimit+1 {
		t.Fatalf("%d pulls kept", total)
	}
	if pulls := tracker.status("img:1"); len(pulls) != 1 || pulls[0].State != "running" {
		t.Fatalf("running pull dropped: %+v", pulls)
	}

	// A pull without a command ID is not recorded.
	tracker.begin("", "img:3")(nil)
	if pulls := tracker.status("img:3"); len(pulls) != 0 {
		t.Fatalf("pull without command: %+v", pulls)
	}
}
