package builder

import (
	"bytes"
	"sync"
	"time"
	"unicode/utf8"
)

// buildLogPartialLineDelay is how long an unfinished line may wait for its newline before it is sent anyway.
const buildLogPartialLineDelay = 500 * time.Millisecond

// lineBuffer sits after the redactor and makes build log chunks line-aligned and UTF-8-safe. It holds back
// output up to the last newline and sends a partial line only when it outgrows the chunk limit (cut on a rune
// boundary), when it has waited for its newline for too long, or when the stream ends. It only sees bytes the
// redactor already released, so holding them back cannot split a secret.
type lineBuffer struct {
	mu      sync.Mutex
	max     int
	delay   time.Duration
	emit    func([]byte)
	pending []byte
	timer   *time.Timer
	closed  bool
	// openLine reports that the last emitted byte was not a newline.
	openLine bool
}

func newLineBuffer(max int, delay time.Duration, emit func([]byte)) *lineBuffer {
	return &lineBuffer{max: max, delay: delay, emit: emit}
}

func (b *lineBuffer) Write(chunk []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || len(chunk) == 0 {
		return
	}
	b.pending = append(b.pending, chunk...)
	b.drainLocked()
	b.armLocked()
}

// Flush sends everything left and ends a line that the process left open, so whatever is logged next starts
// on a line of its own.
func (b *lineBuffer) Flush() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	tail := b.pending
	b.pending = nil
	if len(tail) == 0 && !b.openLine {
		return
	}
	if len(tail) == 0 || tail[len(tail)-1] != '\n' {
		tail = append(tail, '\n')
	}
	b.send(tail)
}

func (b *lineBuffer) drainLocked() {
	for len(b.pending) > 0 {
		window := b.pending
		if len(window) > b.max {
			window = window[:b.max]
		}
		if newline := bytes.LastIndexByte(window, '\n'); newline >= 0 {
			b.sendPending(newline + 1)
			continue
		}
		if len(b.pending) <= b.max {
			return
		}
		b.sendPending(runeBoundary(b.pending, b.max))
	}
}

func (b *lineBuffer) armLocked() {
	if len(b.pending) == 0 {
		if b.timer != nil {
			b.timer.Stop()
			b.timer = nil
		}
		return
	}
	if b.timer == nil {
		b.timer = time.AfterFunc(b.delay, b.onTimer)
	}
}

func (b *lineBuffer) onTimer() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.timer = nil
	// A rune that is still arriving stays behind for the next flush.
	b.sendPending(completeRunes(b.pending))
	b.armLocked()
}

func (b *lineBuffer) sendPending(length int) {
	if length <= 0 {
		return
	}
	b.send(append([]byte(nil), b.pending[:length]...))
	b.pending = b.pending[length:]
}

func (b *lineBuffer) send(chunk []byte) {
	b.openLine = chunk[len(chunk)-1] != '\n'
	b.emit(chunk)
}

// runeBoundary returns the largest cut at or below limit that does not split a UTF-8 sequence. Data that is not
// UTF-8 is cut at limit.
func runeBoundary(data []byte, limit int) int {
	cut := limit
	for steps := 0; cut > 0 && cut < len(data) && !utf8.RuneStart(data[cut]) && steps < utf8.UTFMax; steps++ {
		cut--
	}
	if cut > 0 && cut < len(data) && !utf8.RuneStart(data[cut]) {
		return limit
	}
	if cut == 0 {
		return limit
	}
	return cut
}

// completeRunes returns the length of data without an incomplete UTF-8 sequence at its end.
func completeRunes(data []byte) int {
	for back := 1; back <= utf8.UTFMax-1 && back <= len(data); back++ {
		index := len(data) - back
		if !utf8.RuneStart(data[index]) {
			continue
		}
		if utf8.FullRune(data[index:]) {
			return len(data)
		}
		return index
	}
	return len(data)
}
