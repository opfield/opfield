package handover

import (
	"os"
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

// Keeper holds what a handover passes to the next process: the launcher's
// keeper (listenerkeep) in a daemon.
type Keeper interface {
	// HandsOver reports a keeper that passes what it keeps to the next process.
	HandsOver() bool
	Keep(name string, file *os.File) error
	Drop(name string) error
	Take(name string) (*os.File, bool)
	Inherited(prefix string) []string
	// Flush waits until the keeper took every message sent so far.
	Flush(timeout time.Duration) error
	// EnvBytes estimates the keeper's description of what it passes on, with
	// names more (listenerkeep.MaxEnvBytes bounds it).
	EnvBytes(names []string) int
}

// Names a handover keeps under: KeptConnPrefix and a number for each socket,
// KeptSnapshotName for the snapshot, which a keeper takes last (the commit
// point: the handover commits when Keep of it succeeds).
const (
	KeptConnPrefix   = connPrefix
	KeptSnapshotName = stateName
)

// UnboundedKeeper is a keeper that passes on any number of descriptors (not
// through one environment variable, as the launcher's does): EnvBytes does not
// bound a handover through it.
type UnboundedKeeper interface {
	Unbounded() bool
}

// LauncherKeeper is the daemon launcher's keeper.
var LauncherKeeper Keeper = launcherKeeper{}

type launcherKeeper struct{}

// HandsOver asks the running launcher each time: a launcher that updated
// itself in place may have gained the keeper since.
func (launcherKeeper) HandsOver() bool {
	return lifecycle.LauncherFeatures().Has(lifecycle.LauncherFeatureListenerKeep) && listenerkeep.HandsOver()
}
func (launcherKeeper) Keep(name string, file *os.File) error { return listenerkeep.Keep(name, file) }
func (launcherKeeper) Drop(name string) error                { return listenerkeep.Drop(name) }
func (launcherKeeper) Take(name string) (*os.File, bool)     { return listenerkeep.Take(name) }
func (launcherKeeper) Inherited(prefix string) []string      { return listenerkeep.Inherited(prefix) }
func (launcherKeeper) Flush(timeout time.Duration) error     { return listenerkeep.Flush(timeout) }
func (launcherKeeper) EnvBytes(names []string) int           { return listenerkeep.EnvBytes(names) }
