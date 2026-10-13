package codec

import (
	"bytes"
	"testing"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/mem"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

func encoded(t *testing.T, frame *relayv1.TunnelFrame) []byte {
	t.Helper()
	data, err := proto.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// split cuts data into buffers of at most size bytes, as gRPC hands over a
// message read in several pieces.
func split(data []byte, size int) mem.BufferSlice {
	var slice mem.BufferSlice
	for len(data) > 0 {
		n := min(size, len(data))
		slice = append(slice, mem.SliceBuffer(bytes.Clone(data[:n])))
		data = data[n:]
	}
	return slice
}

func TestServerCodecCarriesTunnelFramesAsReceived(t *testing.T) {
	payload := bytes.Repeat([]byte{7}, 32*1024)
	cases := []struct {
		name    string
		frame   *relayv1.TunnelFrame
		kind    int
		dataLen int
	}{
		{"data", &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: payload}}}, KindData, len(payload)},
		{"small data", &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte{1}}}}, KindData, 1},
		{"empty data", &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{}}}, KindData, 0},
		{"half close", &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}, KindHalfClose, 0},
		{"close", &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}}, KindClose, 0},
		{"error", &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Error{Error: &relayv1.RelayError{Code: "x", Message: "y"}}}, KindError, 0},
		{"ready", &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 9}}}, KindOther, 0},
		{"empty", &relayv1.TunnelFrame{}, KindUnparsed, 0},
	}
	for _, c := range cases {
		data := encoded(t, c.frame)
		for _, size := range []int{1, 3, 16 * 1024, len(data) + 1} {
			var frame TunnelFrame
			if err := (ServerCodec{}).Unmarshal(split(data, size), &frame); err != nil {
				t.Fatal(err)
			}
			if frame.Kind != c.kind || frame.DataLen != c.dataLen {
				t.Fatalf("%s in %d-byte buffers: kind %d data %d, want %d %d", c.name, size, frame.Kind, frame.DataLen, c.kind, c.dataLen)
			}
			sent, err := (ServerCodec{}).Marshal(&frame)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(sent.Materialize(), data) {
				t.Fatalf("%s: sent bytes differ from the received ones", c.name)
			}
			sent.Free()
		}
		// The proxy's codec carries them too, in the copy gRPC made.
		var frame TunnelFrame
		if err := (Codec{}).Unmarshal(bytes.Clone(data), &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Kind != c.kind || frame.DataLen != c.dataLen {
			t.Fatalf("%s through Codec: kind %d data %d, want %d %d", c.name, frame.Kind, frame.DataLen, c.kind, c.dataLen)
		}
		if sent, err := (Codec{}).Marshal(&frame); err != nil || !bytes.Equal(sent, data) {
			t.Fatalf("%s through Codec: sent bytes differ (%v)", c.name, err)
		}
	}
}

func TestServerCodecDecodesFramesItCannotParse(t *testing.T) {
	data := encoded(t, &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("abc")}}})
	// The same data frame twice: valid protobuf (the last one counts), not
	// one field spanning the message.
	twice := append(bytes.Clone(data), data...)
	// A data frame whose TunnelData carries an unknown field after its bytes.
	unknown := protowire.AppendTag(nil, 4, protowire.BytesType)
	inner := protowire.AppendBytes(protowire.AppendTag(nil, 1, protowire.BytesType), []byte("abc"))
	inner = protowire.AppendVarint(protowire.AppendTag(inner, 9, protowire.VarintType), 1)
	unknown = protowire.AppendBytes(unknown, inner)
	for _, raw := range [][]byte{twice, unknown} {
		var frame TunnelFrame
		if err := (ServerCodec{}).Unmarshal(split(raw, 2), &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Kind != KindUnparsed {
			t.Fatalf("kind %d, want unparsed", frame.Kind)
		}
		decoded, err := frame.Decode()
		if err != nil {
			t.Fatal(err)
		}
		if string(decoded.GetData().GetData()) != "abc" {
			t.Fatalf("decoded %q", decoded.GetData().GetData())
		}
	}
}
