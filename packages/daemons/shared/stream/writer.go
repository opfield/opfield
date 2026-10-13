package stream

import (
	"sync"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// Writer serializes concurrent Send calls on a gRPC client stream.
type Writer struct {
	Stream pb.NodeControl_CommandStreamClient
	mu     sync.Mutex
}

func NewWriter(stream pb.NodeControl_CommandStreamClient) *Writer {
	return &Writer{Stream: stream}
}

// Send writes msg to the stream. Every string field is first made valid UTF-8
// (see SanitizeUTF8): this is the single send path for the daemon session, and
// a marshal failure here would end the whole session rather than one message.
func (w *Writer) Send(msg *pb.DaemonMessage) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	SanitizeUTF8(msg)
	return w.Stream.Send(msg)
}

// LogStreamWriter serializes concurrent Send calls on a LogStream client.
type LogStreamWriter struct {
	Stream pb.LogStream_StreamLogsClient
	mu     sync.Mutex
}

func NewLogStreamWriter(stream pb.LogStream_StreamLogsClient) *LogStreamWriter {
	return &LogStreamWriter{Stream: stream}
}

func (w *LogStreamWriter) Send(msg *pb.LogStreamMessage) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	SanitizeUTF8(msg)
	return w.Stream.Send(msg)
}

func (w *LogStreamWriter) Recv() (*pb.LogStreamControl, error) {
	return w.Stream.Recv()
}
