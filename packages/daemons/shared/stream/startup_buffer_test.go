package stream

import (
	"fmt"
	"testing"
)

func TestStartupBufferKeepsOnlyTheNewestEntries(t *testing.T) {
	ResetStartupBuffer()
	t.Cleanup(ResetStartupBuffer)
	for i := range startupBufferLimit + 250 {
		BufferStartupLog("warn", "daemon", fmt.Sprintf("line %d", i), nil)
	}
	startupBuffer.mu.Lock()
	defer startupBuffer.mu.Unlock()
	if len(startupBuffer.entries) != startupBufferLimit || startupBuffer.dropped != 250 {
		t.Fatalf("kept %d, dropped %d", len(startupBuffer.entries), startupBuffer.dropped)
	}
	if first := startupBuffer.entries[0].Message; first != "line 250" {
		t.Fatalf("oldest kept entry = %q", first)
	}
	if last := startupBuffer.entries[startupBufferLimit-1].Message; last != fmt.Sprintf("line %d", startupBufferLimit+249) {
		t.Fatalf("newest kept entry = %q", last)
	}
}
