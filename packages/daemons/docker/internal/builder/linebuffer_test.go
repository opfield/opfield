package builder

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

type chunkRecorder struct {
	mu     sync.Mutex
	chunks [][]byte
}

func (r *chunkRecorder) emit(chunk []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.chunks = append(r.chunks, append([]byte(nil), chunk...))
}

func (r *chunkRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.chunks))
	for i, chunk := range r.chunks {
		out[i] = string(chunk)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestLineBufferHoldsPartialLineUntilNewline(t *testing.T) {
	recorder := &chunkRecorder{}
	lines := newLineBuffer(1024, time.Hour, recorder.emit)
	lines.Write([]byte("#13 16.5"))
	if got := recorder.snapshot(); len(got) != 0 {
		t.Fatalf("a partial line was emitted early: %q", got)
	}
	lines.Write([]byte("4 go: downloading x\n#13 16.6 y"))
	if got, want := recorder.snapshot(), []string{"#13 16.54 go: downloading x\n"}; !equalStrings(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	lines.Flush()
	if got, want := recorder.snapshot(), []string{"#13 16.54 go: downloading x\n", "#13 16.6 y\n"}; !equalStrings(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLineBufferNeverSplitsARune(t *testing.T) {
	recorder := &chunkRecorder{}
	lines := newLineBuffer(8, time.Hour, recorder.emit)
	// "é" is two bytes: the limit of 8 falls inside the first one.
	lines.Write([]byte("aaaaaaaé"))
	lines.Write([]byte("éé"))
	lines.Flush()
	var joined bytes.Buffer
	for _, chunk := range recorder.snapshot() {
		if !utf8.ValidString(chunk) {
			t.Fatalf("chunk %q is not valid UTF-8", chunk)
		}
		joined.WriteString(chunk)
	}
	if want := "aaaaaaaééé\n"; joined.String() != want {
		t.Fatalf("got %q, want %q", joined.String(), want)
	}
}

func TestLineBufferFlushesPartialLineAfterDelayWithoutCuttingARune(t *testing.T) {
	recorder := &chunkRecorder{}
	lines := newLineBuffer(1024, 20*time.Millisecond, recorder.emit)
	euro := []byte("€")
	lines.Write(append([]byte("price "), euro[:2]...))
	deadline := time.Now().Add(2 * time.Second)
	for len(recorder.snapshot()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got, want := recorder.snapshot(), []string{"price "}; !equalStrings(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	lines.Write(append(append([]byte(nil), euro[2:]...), '\n'))
	if got, want := recorder.snapshot(), []string{"price ", "€\n"}; !equalStrings(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	lines.Flush()
	if got := recorder.snapshot(); len(got) != 2 {
		t.Fatalf("a finished line was ended twice: %q", got)
	}
}

func TestLineBufferKeepsRedactionAcrossChunkBoundaries(t *testing.T) {
	recorder := &chunkRecorder{}
	lines := newLineBuffer(1024, time.Hour, recorder.emit)
	redactor := newStreamRedactor([]string{"hunter2-secret"}, lines.Write)
	for _, part := range []string{"token=hunt", "er2-sec", "ret and more\nnext li", "ne\n"} {
		_, _ = redactor.Write([]byte(part))
	}
	redactor.Flush()
	lines.Flush()
	got := strings.Join(recorder.snapshot(), "")
	if strings.Contains(got, "hunter2") {
		t.Fatalf("secret leaked: %q", got)
	}
	if want := "token=[REDACTED] and more\nnext line\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	for _, chunk := range recorder.snapshot() {
		if !strings.HasSuffix(chunk, "\n") {
			t.Fatalf("chunk %q is not line-aligned", chunk)
		}
	}
}
