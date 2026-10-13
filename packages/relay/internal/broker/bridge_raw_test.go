package broker

import (
	"bytes"
	"io"
	"testing"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/codec"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/mem"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// rawStream is a gRPC stream of the relay's servers as the pumps see it:
// messages go through codec.ServerCodec as gRPC hands them over.
type rawStream struct {
	in  [][]byte
	out [][]byte
}

func (s *rawStream) RecvMsg(m any) error {
	if len(s.in) == 0 {
		return io.EOF
	}
	data := s.in[0]
	s.in = s.in[1:]
	return codec.ServerCodec{}.Unmarshal(mem.BufferSlice{mem.SliceBuffer(data)}, m)
}

func (s *rawStream) SendMsg(m any) error {
	data, err := codec.ServerCodec{}.Marshal(m)
	if err != nil {
		return err
	}
	s.out = append(s.out, data.Materialize())
	data.Free()
	return nil
}

func (s *rawStream) Recv() (*relayv1.TunnelFrame, error) { panic("decoded receive on a raw stream") }
func (s *rawStream) Send(*relayv1.TunnelFrame) error     { panic("decoded send on a raw stream") }

func marshalFrame(t *testing.T, frame *relayv1.TunnelFrame) []byte {
	t.Helper()
	data, err := proto.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func dataFrame(data []byte) *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}
}

func TestRawPumpPassesFramesOnUnchanged(t *testing.T) {
	data := marshalFrame(t, dataFrame(bytes.Repeat([]byte{3}, 32*1024)))
	halfClose := marshalFrame(t, &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
	source := &rawStream{in: [][]byte{data, data, halfClose}}
	destination := &rawStream{}
	var recorded uint64
	terminal, err := pumpEither(destination, source, DefaultMaxFrameBytes, make(chan struct{}, 1), nil, func(n uint64) { recorded += n })
	if err != nil || terminal {
		t.Fatalf("terminal=%v err=%v", terminal, err)
	}
	if len(destination.out) != 3 || !bytes.Equal(destination.out[0], data) || !bytes.Equal(destination.out[1], data) || !bytes.Equal(destination.out[2], halfClose) {
		t.Fatalf("forwarded %d frames, not the received bytes", len(destination.out))
	}
	if recorded != 2*32*1024 {
		t.Fatalf("recorded %d data bytes", recorded)
	}
}

func TestRawPumpHalfClosesOnEOF(t *testing.T) {
	destination := &rawStream{}
	terminal, err := pumpEither(destination, &rawStream{}, DefaultMaxFrameBytes, make(chan struct{}, 1), nil, nil)
	if err != nil || terminal {
		t.Fatalf("terminal=%v err=%v", terminal, err)
	}
	var frame relayv1.TunnelFrame
	if len(destination.out) != 1 || proto.Unmarshal(destination.out[0], &frame) != nil || frame.GetHalfClose() == nil {
		t.Fatal("EOF did not become a half-close")
	}
}

func TestRawPumpRefusesWhatThePumpRefuses(t *testing.T) {
	cases := map[string][]byte{
		"oversized data": marshalFrame(t, dataFrame(make([]byte, 2048))),
		"empty data":     marshalFrame(t, &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{}}}),
		"ready":          marshalFrame(t, readyFrame(1024)),
		"empty frame":    {},
	}
	for name, frame := range cases {
		destination := &rawStream{}
		_, err := pumpEither(destination, &rawStream{in: [][]byte{frame}}, 1024, make(chan struct{}, 1), nil, nil)
		if status.Code(err) != codes.InvalidArgument || len(destination.out) != 0 {
			t.Fatalf("%s: err=%v forwarded=%d", name, err, len(destination.out))
		}
	}
}

func TestRawPumpDecodesFramesItCannotParse(t *testing.T) {
	// Valid protobuf the daemons never send: the same field twice (the last
	// one counts).
	twice := append(marshalFrame(t, dataFrame([]byte("old"))), marshalFrame(t, dataFrame([]byte("new")))...)
	closeFrame := marshalFrame(t, &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
	destination := &rawStream{}
	terminal, err := pumpEither(destination, &rawStream{in: [][]byte{twice, closeFrame}}, DefaultMaxFrameBytes, make(chan struct{}, 1), nil, nil)
	if err != nil || !terminal {
		t.Fatalf("terminal=%v err=%v", terminal, err)
	}
	var frame relayv1.TunnelFrame
	if len(destination.out) != 2 || proto.Unmarshal(destination.out[0], &frame) != nil || string(frame.GetData().GetData()) != "new" {
		t.Fatal("an unparsed frame was not passed on as protobuf reads it")
	}
	if !bytes.Equal(destination.out[1], closeFrame) {
		t.Fatal("close was not passed on")
	}
}
