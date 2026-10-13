package docker

import (
	"encoding/json"
	"sort"
	"sync"
	"time"
)

const (
	// imagePullRetention is how long a finished pull is remembered: Opfield asks for it once the node is connected
	// again, which is seconds to minutes after its answer was lost.
	imagePullRetention = time.Hour
	// imagePullRecordLimit bounds the memory a burst of pulls can hold; the oldest finished pulls go first.
	imagePullRecordLimit = 256
)

// imagePullRecord is one image pull this daemon process ran, by the Opfield command that asked for it.
type imagePullRecord struct {
	CommandID        string `json:"commandId"`
	ImageRef         string `json:"imageRef"`
	State            string `json:"state"` // running, succeeded or failed
	Error            string `json:"error,omitempty"`
	StartedAtUnixMs  int64  `json:"startedAtUnixMs"`
	FinishedAtUnixMs int64  `json:"finishedAtUnixMs,omitempty"`
}

// imagePullTracker remembers the image pulls this daemon process runs and how its recent ones ended. A pull goes on
// when the session that asked for it drops (Opfield restarted, or the control stream broke): its result can then not
// be sent, and Opfield asks for it with the pull_status image action once the node is connected again. The zero
// value is ready to use.
type imagePullTracker struct {
	mu    sync.Mutex
	pulls map[string]*imagePullRecord
	now   func() time.Time
}

func (t *imagePullTracker) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

// begin records a pull of imageRef for the command commandID and returns the function that records how it ended.
// A pull without a command ID is not recorded (nobody could ask for it).
func (t *imagePullTracker) begin(commandID, imageRef string) func(err error) {
	if commandID == "" {
		return func(error) {}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pulls == nil {
		t.pulls = make(map[string]*imagePullRecord)
	}
	now := t.clock()
	t.pruneLocked(now)
	record := &imagePullRecord{
		CommandID:       commandID,
		ImageRef:        imageRef,
		State:           "running",
		StartedAtUnixMs: now.UnixMilli(),
	}
	t.pulls[commandID] = record
	return func(err error) {
		t.mu.Lock()
		defer t.mu.Unlock()
		record.FinishedAtUnixMs = t.clock().UnixMilli()
		if err != nil {
			record.State = "failed"
			record.Error = err.Error()
		} else {
			record.State = "succeeded"
		}
	}
}

// status lists the pulls of imageRef this process remembers, oldest first.
func (t *imagePullTracker) status(imageRef string) []imagePullRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked(t.clock())
	out := []imagePullRecord{}
	for _, record := range t.pulls {
		if record.ImageRef == imageRef {
			out = append(out, *record)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAtUnixMs != out[j].StartedAtUnixMs {
			return out[i].StartedAtUnixMs < out[j].StartedAtUnixMs
		}
		return out[i].CommandID < out[j].CommandID
	})
	return out
}

// statusDetail is the pull_status answer: {"pulls":[...]} for imageRef.
func (t *imagePullTracker) statusDetail(imageRef string) (string, error) {
	data, err := json.Marshal(struct {
		Pulls []imagePullRecord `json:"pulls"`
	}{Pulls: t.status(imageRef)})
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// pruneLocked drops finished pulls past the retention and, over the limit, the oldest finished ones. Running pulls
// are always kept.
func (t *imagePullTracker) pruneLocked(now time.Time) {
	cutoff := now.Add(-imagePullRetention).UnixMilli()
	finished := make([]*imagePullRecord, 0, len(t.pulls))
	for id, record := range t.pulls {
		if record.State == "running" {
			continue
		}
		if record.FinishedAtUnixMs < cutoff {
			delete(t.pulls, id)
			continue
		}
		finished = append(finished, record)
	}
	excess := len(t.pulls) - imagePullRecordLimit
	if excess <= 0 {
		return
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].FinishedAtUnixMs < finished[j].FinishedAtUnixMs })
	for i := 0; i < excess && i < len(finished); i++ {
		delete(t.pulls, finished[i].CommandID)
	}
}
