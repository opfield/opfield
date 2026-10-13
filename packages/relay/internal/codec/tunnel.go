package codec

import (
	"fmt"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc/mem"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// ServerCodec is the relay servers' codec: protobuf messages, proxied Frames,
// and TunnelFrames carried as received. A tunnel's frames pass the relay as
// the bytes gRPC read, so the relay neither decodes nor encodes them, and
// copies and allocates nothing per frame: every frame was unmarshalled
// (copied twice) and marshalled again (copied once more), which with the
// garbage it left took about a third of the relay's CPU on a bulk stream.
type ServerCodec struct{}

func (ServerCodec) Name() string { return "proto" }

func (ServerCodec) Marshal(value any) (mem.BufferSlice, error) {
	switch message := value.(type) {
	case *TunnelFrame:
		return message.take(), nil
	case *Frame:
		return mem.BufferSlice{mem.SliceBuffer(*message)}, nil
	case proto.Message:
		data, err := proto.Marshal(message)
		if err != nil {
			return nil, err
		}
		return mem.BufferSlice{mem.SliceBuffer(data)}, nil
	default:
		return nil, fmt.Errorf("unsupported gRPC message type %T", value)
	}
}

func (ServerCodec) Unmarshal(data mem.BufferSlice, value any) error {
	switch message := value.(type) {
	case *TunnelFrame:
		message.hold(data)
		return nil
	case *Frame:
		*message = append((*message)[:0], data.Materialize()...)
		return nil
	case proto.Message:
		buffer := data.MaterializeToBuffer(mem.DefaultBufferPool())
		defer buffer.Free()
		return proto.Unmarshal(buffer.ReadOnlyData(), message)
	default:
		return fmt.Errorf("unsupported gRPC message type %T", value)
	}
}

// Tunnel frame kinds: the TunnelFrame payload field a frame holds.
const (
	KindOther     = 0
	KindData      = 4
	KindHalfClose = 5
	KindClose     = 6
	KindError     = 7
	// KindUnparsed is a frame whose bytes are not the single payload field
	// the daemons and Opfield send; Decode reads it as protobuf does.
	KindUnparsed = -1
)

// TunnelFrame is a relayv1.TunnelFrame as received: its bytes, still in
// gRPC's buffers, and what the relay needs to know about it. Sending it hands
// the bytes on; a frame that is not sent must be freed.
type TunnelFrame struct {
	buffers mem.BufferSlice
	// Kind is the payload field (KindData ... KindError), KindOther for
	// any other payload, or KindUnparsed.
	Kind int
	// DataLen is the length of a data frame's bytes.
	DataLen int
}

func (f *TunnelFrame) hold(data mem.BufferSlice) {
	f.Free()
	data.Ref()
	f.buffers = data
	f.Kind, f.DataLen = parseTunnelFrame(data)
}

func (f *TunnelFrame) take() mem.BufferSlice {
	buffers := f.buffers
	f.buffers = nil
	return buffers
}

// Free releases a frame that was not sent.
func (f *TunnelFrame) Free() {
	if f.buffers != nil {
		f.buffers.Free()
		f.buffers = nil
	}
}

// Decode reads the frame as protobuf does and frees it.
func (f *TunnelFrame) Decode() (*relayv1.TunnelFrame, error) {
	defer f.Free()
	frame := &relayv1.TunnelFrame{}
	if err := proto.Unmarshal(f.buffers.Materialize(), frame); err != nil {
		return nil, err
	}
	return frame, nil
}

// parseTunnelFrame reads the payload field of an encoded TunnelFrame: one
// length-delimited field spanning the message, and for data one bytes field
// spanning the TunnelData. Anything else, also valid protobuf (repeated or
// unknown fields), is KindUnparsed.
func parseTunnelFrame(data mem.BufferSlice) (kind, dataLen int) {
	var head [24]byte
	header := head[:data.CopyTo(head[:])]
	total := data.Len()
	number, wireType, n := protowire.ConsumeTag(header)
	if n < 0 || wireType != protowire.BytesType {
		return KindUnparsed, 0
	}
	header = header[n:]
	length, m := protowire.ConsumeVarint(header)
	if m < 0 || uint64(total) != uint64(n+m)+length {
		return KindUnparsed, 0
	}
	header = header[m:]
	switch number {
	case KindData:
		if length == 0 {
			return KindData, 0
		}
		inner, innerType, i := protowire.ConsumeTag(header)
		if i < 0 || inner != 1 || innerType != protowire.BytesType {
			return KindUnparsed, 0
		}
		size, j := protowire.ConsumeVarint(header[i:])
		if j < 0 || length != uint64(i+j)+size {
			return KindUnparsed, 0
		}
		return KindData, int(size)
	case KindHalfClose, KindClose, KindError:
		return int(number), 0
	default:
		return KindOther, 0
	}
}
