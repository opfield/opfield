package handover

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// The relay stream counters a daemon reports (RelayStreamStats) are its
// process's. The streams an exit cuts, and what the process counted before,
// would be counted by no process at all after a restart that is no update (a
// unit restart, a launcher that crashed): the exiting process leaves its cut
// total to the next one, which goes on from it.

// streamTotalsFile is written by the exiting process for the next one.
const streamTotalsFile = "relay-stream-totals.json"

// StreamTotals are the counters a process leaves to the next one.
type StreamTotals struct {
	Cut       uint64    `json:"cut"`
	WrittenAt time.Time `json:"writtenAt"`
}

// WriteStreamTotals records the exiting process's totals for the next one.
func WriteStreamTotals(stateDir string, totals StreamTotals) error {
	if totals.WrittenAt.IsZero() {
		totals.WrittenAt = time.Now()
	}
	data, err := json.Marshal(totals)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(stateDir, streamTotalsFile), data, 0o600)
}

// streamTotalsMaxAge bounds the age of the totals a process goes on from: a
// restart starts the next process within seconds (the unit's RestartSec, the
// launcher's backoff), and a file left long ago (a release without the reader
// ran meanwhile) belongs to no restart of this one.
const streamTotalsMaxAge = 5 * time.Minute

// TakeStreamTotals returns the totals the previous process left, once: the
// file goes, so a later start does not count them twice.
func TakeStreamTotals(stateDir string) StreamTotals {
	path := filepath.Join(stateDir, streamTotalsFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return StreamTotals{}
	}
	_ = os.Remove(path)
	var totals StreamTotals
	if json.Unmarshal(data, &totals) != nil {
		return StreamTotals{}
	}
	if age := time.Since(totals.WrittenAt); age < -time.Minute || age > streamTotalsMaxAge {
		return StreamTotals{}
	}
	return totals
}
