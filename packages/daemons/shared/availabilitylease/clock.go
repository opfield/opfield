package availabilitylease

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"strings"
	"sync"
	"time"
)

// Clock is a monotonic clock that keeps counting while the host is suspended
// (CLOCK_BOOTTIME on Linux). Values are durations since an arbitrary origin and
// are never restored from disk (A3). Peers only compare them as offsets over
// time, per origin (D4, freeze.go).
type Clock interface {
	Now() time.Duration
}

// ClockOrigin is implemented by clocks that can name their origin. Two
// readings are comparable only when they have the same origin; batches carry
// it so a receiver restarts its offset tracking when a sender's clock may have
// jumped (host reboot, a container started on another host). A clock without
// it gets a random origin per node.
type ClockOrigin interface {
	Origin() uint64
}

// SystemClock returns the host BOOTTIME clock where available and the Go
// monotonic clock elsewhere.
func SystemClock() Clock { return systemClock{} }

type systemClock struct{}

func (systemClock) Origin() uint64 { return BootOrigin() }

var (
	bootOriginOnce  sync.Once
	bootOriginValue uint64
)

// BootOrigin identifies the origin of the host's lease clock: a hash of the
// kernel boot id, which changes on every boot (and, under LXC, on every
// container start), or a random value per process where there is none.
// CLOCK_BOOTTIME is continuous across process restarts within one boot, so a
// relay or daemon restart keeps its peers' offset tracking valid.
func BootOrigin() uint64 {
	bootOriginOnce.Do(func() {
		if id := strings.TrimSpace(readBootID()); id != "" {
			sum := sha256.Sum256([]byte(legacycompat.AvailabilityLeaseDomain + "/clock-origin/v1\x00" + id))
			bootOriginValue = binary.BigEndian.Uint64(sum[:8])
		}
		for bootOriginValue == 0 {
			var buf [8]byte
			_, _ = rand.Read(buf[:])
			bootOriginValue = binary.BigEndian.Uint64(buf[:])
		}
	})
	return bootOriginValue
}
