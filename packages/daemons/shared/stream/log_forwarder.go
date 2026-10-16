package stream

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// logForwarder captures slog records and sends them as DaemonLogEntry
// messages on the gRPC command stream when log streaming is enabled.
type logForwarder struct {
	writer *Writer
}

func newLogForwarder(writer *Writer) *logForwarder {
	return &logForwarder{writer: writer}
}

// forward sends a log entry if daemon log streaming is enabled and the
// level meets the minimum threshold.
func (lf *logForwarder) forward(level, component, message string, fields map[string]string) {
	if !GetDaemonLogEnabled() {
		return
	}

	if !meetsMinLevel(level, GetDaemonLogMinLevel()) {
		return
	}

	entry := &pb.DaemonLogEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Level:     level,
		Message:   message,
		Component: component,
		Fields:    fields,
	}

	lf.writer.Send(&pb.DaemonMessage{
		Payload: &pb.DaemonMessage_DaemonLog{DaemonLog: entry},
	})
}

// StartupLogHandler is an slog.Handler that buffers logs before the gRPC session.
type StartupLogHandler struct {
	inner slog.Handler
}

func NewStartupLogHandler(inner slog.Handler) *StartupLogHandler {
	return &StartupLogHandler{inner: inner}
}

func (h *StartupLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *StartupLogHandler) Handle(ctx context.Context, r slog.Record) error {
	level := strings.ToLower(r.Level.String())
	fields := make(map[string]string)
	var component string
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "component" {
			component = a.Value.String()
		} else {
			fields[a.Key] = a.Value.String()
		}
		return true
	})
	BufferStartupLog(level, component, r.Message, fields)
	return h.inner.Handle(ctx, r)
}

func (h *StartupLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &StartupLogHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *StartupLogHandler) WithGroup(name string) slog.Handler {
	return &StartupLogHandler{inner: h.inner.WithGroup(name)}
}

// GrpcLogHandler is an slog.Handler that forwards logs to the gRPC stream.
type GrpcLogHandler struct {
	forwarder *logForwarder
	inner     slog.Handler
	component string
	attrs     []slog.Attr
}

// NewGrpcLogHandler creates a new GrpcLogHandler that forwards log records
// to the gRPC stream and delegates to the inner handler for local logging.
// Deprecated: use NewGrpcLogHandlerWithWriter for thread-safe sends.
func NewGrpcLogHandler(stream pb.NodeControl_CommandStreamClient, inner slog.Handler) *GrpcLogHandler {
	return &GrpcLogHandler{
		forwarder: newLogForwarder(NewWriter(stream)),
		inner:     inner,
	}
}

// NewGrpcLogHandlerWithWriter creates a GrpcLogHandler using a thread-safe Writer.
// It also flushes any buffered startup logs.
func NewGrpcLogHandlerWithWriter(writer *Writer, inner slog.Handler) *GrpcLogHandler {
	flushStartupBuffer(writer)
	return &GrpcLogHandler{
		forwarder: newLogForwarder(writer),
		inner:     inner,
	}
}

func (h *GrpcLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *GrpcLogHandler) Handle(ctx context.Context, r slog.Record) error {
	// Forward to gRPC stream
	level := strings.ToLower(r.Level.String())
	component := h.component
	fields := make(map[string]string)

	// Collect record attributes
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "component" {
			component = a.Value.String()
		} else {
			fields[a.Key] = a.Value.String()
		}
		return true
	})

	// Include pre-set attrs
	for _, a := range h.attrs {
		if a.Key == "component" {
			component = a.Value.String()
		} else {
			fields[a.Key] = a.Value.String()
		}
	}

	h.forwarder.forward(level, component, r.Message, fields)

	// Also pass to the inner handler (console/file logging)
	return h.inner.Handle(ctx, r)
}

func (h *GrpcLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	newAttrs := make([]slog.Attr, len(h.attrs)+len(attrs))
	copy(newAttrs, h.attrs)
	copy(newAttrs[len(h.attrs):], attrs)
	return &GrpcLogHandler{
		forwarder: h.forwarder,
		inner:     h.inner.WithAttrs(attrs),
		component: h.component,
		attrs:     newAttrs,
	}
}

func (h *GrpcLogHandler) WithGroup(name string) slog.Handler {
	return &GrpcLogHandler{
		forwarder: h.forwarder,
		inner:     h.inner.WithGroup(name),
		component: h.component,
		attrs:     h.attrs,
	}
}

func meetsMinLevel(level, minLevel string) bool {
	levelOrder := map[string]int{
		"debug": 0,
		"info":  1,
		"warn":  2,
		"error": 3,
	}
	l, ok1 := levelOrder[strings.ToLower(level)]
	m, ok2 := levelOrder[strings.ToLower(minLevel)]
	if !ok1 || !ok2 {
		return true // forward unknown levels
	}
	return l >= m
}

// daemonLogState holds the daemon log streaming state with proper synchronization.
var daemonLogState struct {
	enabled  atomic.Bool
	mu       sync.RWMutex
	minLevel string
}

func init() {
	daemonLogState.minLevel = "info"
}

// startupBufferLimit bounds the entries kept before the first session: a
// daemon that cannot reach Opfield for days keeps logging (relay retries), and
// only the newest lines are worth replaying.
const startupBufferLimit = 500

// startupBuffer holds log entries generated before the gRPC handler is installed.
var startupBuffer struct {
	mu      sync.Mutex
	entries []*pb.DaemonLogEntry
	dropped int
	flushed bool
}

// BufferStartupLog stores a log entry for later replay once the gRPC handler is ready.
func BufferStartupLog(level, component, message string, fields map[string]string) {
	startupBuffer.mu.Lock()
	defer startupBuffer.mu.Unlock()
	if startupBuffer.flushed {
		return
	}
	if len(startupBuffer.entries) >= startupBufferLimit {
		copy(startupBuffer.entries, startupBuffer.entries[1:])
		startupBuffer.entries = startupBuffer.entries[:len(startupBuffer.entries)-1]
		startupBuffer.dropped++
	}
	startupBuffer.entries = append(startupBuffer.entries, &pb.DaemonLogEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Level:     level,
		Message:   message,
		Component: component,
		Fields:    fields,
	})
}

// flushStartupBuffer sends all buffered startup logs through the writer.
func flushStartupBuffer(writer *Writer) {
	startupBuffer.mu.Lock()
	defer startupBuffer.mu.Unlock()
	if startupBuffer.flushed {
		return
	}
	startupBuffer.flushed = true
	if startupBuffer.dropped > 0 {
		writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_DaemonLog{DaemonLog: &pb.DaemonLogEntry{
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Level:     "info",
			Message:   fmt.Sprintf("%d earlier log lines from before the session are not replayed", startupBuffer.dropped),
			Component: "daemon",
		}}})
		startupBuffer.dropped = 0
	}
	for _, entry := range startupBuffer.entries {
		writer.Send(&pb.DaemonMessage{
			Payload: &pb.DaemonMessage_DaemonLog{DaemonLog: entry},
		})
	}
	startupBuffer.entries = nil
}

// ResetStartupBuffer clears the buffer for a new session.
func ResetStartupBuffer() {
	startupBuffer.mu.Lock()
	defer startupBuffer.mu.Unlock()
	startupBuffer.entries = nil
	startupBuffer.dropped = 0
	startupBuffer.flushed = false
}

// SetDaemonLogStreaming atomically updates the log streaming state.
func SetDaemonLogStreaming(enabled bool, minLevel string) {
	daemonLogState.enabled.Store(enabled)
	daemonLogState.mu.Lock()
	daemonLogState.minLevel = minLevel
	daemonLogState.mu.Unlock()
}

// GetDaemonLogEnabled returns the current log streaming enabled state.
func GetDaemonLogEnabled() bool {
	return daemonLogState.enabled.Load()
}

// GetDaemonLogMinLevel returns the current minimum log level.
func GetDaemonLogMinLevel() string {
	daemonLogState.mu.RLock()
	defer daemonLogState.mu.RUnlock()
	return daemonLogState.minLevel
}
