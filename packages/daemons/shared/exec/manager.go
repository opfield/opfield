package exec

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/stream"
)

// Manager manages persistent exec sessions with ring-buffered output
// and gRPC forwarding. It is process-agnostic — the actual process
// creation (PTY, Docker exec, etc.) is handled by callers that provide
// an io.Reader for output and an io.WriteCloser for input.
type Manager struct {
	logger   *slog.Logger
	writer   *stream.Writer
	mu       sync.Mutex
	sessions map[string]*Session // keyed by Session.Key
}

// NewManager creates a new exec session manager.
func NewManager(logger *slog.Logger, writer *stream.Writer) *Manager {
	return &Manager{
		logger:   logger,
		writer:   writer,
		sessions: make(map[string]*Session),
	}
}

// HandleInput writes data to an exec session's stdin.
func (m *Manager) HandleInput(execID string, data []byte) {
	m.mu.Lock()
	var session *Session
	for _, s := range m.sessions {
		if s.ID == execID {
			session = s
			break
		}
	}
	m.mu.Unlock()

	if session == nil {
		return
	}

	session.touch()
	session.stdin.Write(data)
}

// HasSession returns true if the manager owns a session with the given execID.
func (m *Manager) HasSession(execID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		if s.ID == execID {
			return true
		}
	}
	return false
}

// Resize resizes the TTY for a session.
func (m *Manager) Resize(execID string, rows, cols int) error {
	m.mu.Lock()
	var session *Session
	for _, s := range m.sessions {
		if s.ID == execID {
			session = s
			break
		}
	}
	m.mu.Unlock()

	if session == nil || session.resizeFn == nil {
		return nil
	}

	session.touch()
	return session.resizeFn(rows, cols)
}

// GetBufferBase64 returns buffered output as base64-encoded chunks.
func (m *Manager) GetBufferBase64(key string) []string {
	m.mu.Lock()
	session, ok := m.sessions[key]
	m.mu.Unlock()
	if !ok {
		return nil
	}
	return session.getBufferBase64()
}

// GetBufferJSON returns the buffer as a JSON detail string for command results.
func (m *Manager) GetBufferJSON(key string) string {
	buf := m.GetBufferBase64(key)
	if len(buf) == 0 {
		return ""
	}
	data, _ := json.Marshal(map[string]interface{}{"buffer": buf})
	return string(data)
}

// GetSessionByKey returns the session for a given key, or nil.
func (m *Manager) GetSessionByKey(key string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[key]
}

// CloseAll closes all sessions.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	for _, s := range sessions {
		s.cancel()
		s.stdin.Close()
	}
}

// readOutput reads from the session's reader, buffers, and forwards to gRPC.
func (m *Manager) readOutput(ctx context.Context, session *Session, reader readCloser) {
	buf := make([]byte, 4096)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, err := reader.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])

			session.bufferOutput(data)

			if m.writer != nil {
				m.writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_ExecOutput{
						ExecOutput: &pb.ExecOutput{
							ExecId: session.ID,
							Data:   data,
						},
					},
				})
			}
		}

		if err != nil {
			exitCode := int32(0)
			if session.onExit != nil {
				exitCode = session.onExit()
			}

			if m.writer != nil {
				m.writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_ExecOutput{
						ExecOutput: &pb.ExecOutput{
							ExecId:   session.ID,
							Exited:   true,
							ExitCode: exitCode,
						},
					},
				})
			}

			m.mu.Lock()
			if m.sessions[session.Key] == session {
				delete(m.sessions, session.Key)
			}
			m.mu.Unlock()

			reader.Close()

			m.logger.Info("exec session ended", "exec_id", session.ID, "key", session.Key, "exit_code", exitCode)
			return
		}
	}
}

// readCloser is a minimal interface for reading session output.
type readCloser interface {
	Read(p []byte) (n int, err error)
	Close() error
}
