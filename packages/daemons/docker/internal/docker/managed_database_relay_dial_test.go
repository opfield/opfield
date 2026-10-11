package docker

import (
	"errors"
	"io"
	"testing"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// scriptedFrames is a relay tunnel that delivers frames, then io.EOF.
type scriptedFrames struct{ frames []*relayv1.TunnelFrame }

func (s *scriptedFrames) Send(*relayv1.TunnelFrame) error { return nil }

func (s *scriptedFrames) Recv() (*relayv1.TunnelFrame, error) {
	if len(s.frames) == 0 {
		return nil, io.EOF
	}
	frame := s.frames[0]
	s.frames = s.frames[1:]
	return frame, nil
}

func halfCloseFrame() *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}
}

func dataFrame(data []byte) *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}
}

// Stand 2.12 R-4: a relay client whose own client gave up while the tunnel opened ends it before it sends a byte.
// That is told apart from a client that broke off its startup packet, so the endpoint does not report a failed
// tunnel for it.
func TestRelayClientLeavingBeforeAnyDataIsNotATunnelFailure(t *testing.T) {
	early := &relayStreamReader{stream: &scriptedFrames{frames: []*relayv1.TunnelFrame{halfCloseFrame()}}}
	if _, err := early.readFull(4); !errors.Is(err, errRelayClientLeftEarly) {
		t.Fatalf("half-close before any data: %v, want errRelayClientLeftEarly", err)
	}
	closed := &relayStreamReader{stream: &scriptedFrames{frames: []*relayv1.TunnelFrame{{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}}}}}
	if _, err := closed.readFull(4); !errors.Is(err, errRelayClientLeftEarly) {
		t.Fatalf("close before any data: %v, want errRelayClientLeftEarly", err)
	}
	broken := &relayStreamReader{stream: &scriptedFrames{frames: []*relayv1.TunnelFrame{dataFrame([]byte{0, 0}), halfCloseFrame()}}}
	if _, err := broken.readFull(4); err == nil || errors.Is(err, errRelayClientLeftEarly) {
		t.Fatalf("half-close inside the startup packet: %v, want a failure", err)
	}
	whole := &relayStreamReader{stream: &scriptedFrames{frames: []*relayv1.TunnelFrame{dataFrame([]byte{0, 0, 0, 8, 4})}}}
	header, err := whole.readFull(4)
	if err != nil || len(header) != 4 || len(whole.pending) != 1 {
		t.Fatalf("startup packet: %v %v, pending %v", header, err, whole.pending)
	}
}
