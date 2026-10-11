package pgha

import (
	"fmt"
	"strconv"
	"strings"
)

// LSN is a Postgres write-ahead log position.
type LSN uint64

// ParseLSN reads the "X/Y" text form Postgres prints. An empty string (a SQL
// NULL) is 0.
func ParseLSN(text string) (LSN, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, nil
	}
	high, low, ok := strings.Cut(text, "/")
	if !ok {
		return 0, fmt.Errorf("invalid LSN %q", text)
	}
	hi, err := strconv.ParseUint(high, 16, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid LSN %q", text)
	}
	lo, err := strconv.ParseUint(low, 16, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid LSN %q", text)
	}
	return LSN(hi<<32 | lo), nil
}

// MustLSN is ParseLSN for constants in tests.
func MustLSN(text string) LSN {
	lsn, err := ParseLSN(text)
	if err != nil {
		panic(err)
	}
	return lsn
}

func (l LSN) String() string { return fmt.Sprintf("%X/%X", uint64(l)>>32, uint64(l)&0xffffffff) }

func maxLSN(values ...LSN) LSN {
	var out LSN
	for _, value := range values {
		if value > out {
			out = value
		}
	}
	return out
}

// walSegmentSize is the default Postgres WAL segment size; managed databases
// never change it.
const walSegmentSize = 16 << 20

// WALSegmentName is the file name of the segment holding lsn on timeline.
func WALSegmentName(timeline uint32, lsn LSN) string {
	segment := uint64(lsn) / walSegmentSize
	perID := uint64(0x100000000) / walSegmentSize
	return fmt.Sprintf("%08X%08X%08X", timeline, segment/perID, segment%perID)
}

// ParseWALSegmentName returns the timeline and the first LSN of a segment
// file name (24 hex digits).
func ParseWALSegmentName(name string) (uint32, LSN, bool) {
	if len(name) != 24 {
		return 0, 0, false
	}
	timeline, err1 := strconv.ParseUint(name[0:8], 16, 32)
	log, err2 := strconv.ParseUint(name[8:16], 16, 32)
	seg, err3 := strconv.ParseUint(name[16:24], 16, 32)
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, false
	}
	perID := uint64(0x100000000) / walSegmentSize
	return uint32(timeline), LSN((log*perID + seg) * walSegmentSize), true
}
