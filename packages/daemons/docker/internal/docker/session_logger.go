package docker

import (
	"context"
	"log/slog"
	"sync/atomic"
)

// sessionLogHandler is the handler of the plugin's logger: each record goes to the handler of the current control
// session, which forwards it to Opfield (node logs) and writes it to the journal. Components built at Init keep
// the logger they were handed then; before the first session it buffers for Opfield, after it the session's
// handler takes over. Without this a component's lines (the host listener's refused connections among them) stayed
// in the journal once the session replaced the startup logger.
type sessionLogHandler struct {
	current *atomic.Pointer[slog.Handler]
	// derive replays WithAttrs and WithGroup on whichever handler is current.
	derive []func(slog.Handler) slog.Handler
}

func newSessionLogHandler(initial slog.Handler) *sessionLogHandler {
	handler := &sessionLogHandler{current: &atomic.Pointer[slog.Handler]{}}
	handler.current.Store(&initial)
	return handler
}

// follow sends every later record, of this handler and those derived from it, to next.
func (h *sessionLogHandler) follow(next slog.Handler) {
	h.current.Store(&next)
}

func (h *sessionLogHandler) handler() slog.Handler {
	handler := *h.current.Load()
	for _, derive := range h.derive {
		handler = derive(handler)
	}
	return handler
}

func (h *sessionLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return (*h.current.Load()).Enabled(ctx, level)
}

func (h *sessionLogHandler) Handle(ctx context.Context, record slog.Record) error {
	return h.handler().Handle(ctx, record)
}

func (h *sessionLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	return h.with(func(handler slog.Handler) slog.Handler { return handler.WithAttrs(attrs) })
}

func (h *sessionLogHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	return h.with(func(handler slog.Handler) slog.Handler { return handler.WithGroup(name) })
}

func (h *sessionLogHandler) with(derive func(slog.Handler) slog.Handler) *sessionLogHandler {
	return &sessionLogHandler{current: h.current, derive: append(append([]func(slog.Handler) slog.Handler(nil), h.derive...), derive)}
}
