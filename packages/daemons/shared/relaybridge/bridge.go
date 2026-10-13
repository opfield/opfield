package relaybridge

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/bits"
	"net"
	"sync"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/encoding/protowire"
)

const (
	MaxChunkBytes     = 1024 * 1024
	DefaultChunkBytes = 32 * 1024
)

// readBufferPools[i] holds read buffers of 1<<i bytes, up to MaxChunkBytes: a
// configured read chunk other than the default reuses buffers too.
var readBufferPools [21]sync.Pool

func init() {
	for class := range readBufferPools {
		size := 1 << class
		readBufferPools[class].New = func() any {
			buffer := make([]byte, size)
			return &buffer
		}
	}
}

// DataLimit is the largest Data payload whose TunnelFrame message is at most
// message bytes. gRPC takes message buffers from size tiers (16 KiB, 32 KiB,
// 1 MiB) and clears the whole buffer on every use: a 32 KiB read made a
// 32776-byte message, which took and cleared a 1 MiB buffer for every frame
// on both daemons. Reads of DataLimit(32 KiB) stay in the 32 KiB tier.
func DataLimit(message int) int {
	n := message - 2
	for n > 0 && n+2+protowire.SizeVarint(uint64(n))+protowire.SizeVarint(uint64(n+1+protowire.SizeVarint(uint64(n)))) > message {
		n--
	}
	return max(n, 1)
}

type FrameStream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

type result struct {
	local    bool
	terminal bool
	err      error
}

// Bridge copies opaque TCP bytes between a local connection and a relay
// stream. It deliberately has no idle deadline: lifecycle is controlled by
// TCP close, half-close, relay revocation, or the supplied context.
func Bridge(ctx context.Context, connection net.Conn, stream FrameStream, maxFrame int, cancel context.CancelFunc) error {
	return BridgeWithChunk(ctx, connection, stream, maxFrame, DefaultChunkBytes, cancel)
}

func BridgeWithChunk(ctx context.Context, connection net.Conn, stream FrameStream, maxFrame, readChunk int, cancel context.CancelFunc) error {
	if maxFrame <= 0 || maxFrame > MaxChunkBytes {
		maxFrame = MaxChunkBytes
	}
	if readChunk <= 0 {
		readChunk = DefaultChunkBytes
	}
	// A frame never exceeds the relay's limit, also when the default chunk is
	// above a route's smaller one: the peer ends the tunnel on a bigger frame.
	// Its message stays within the read size (see DataLimit).
	readChunk = min(DataLimit(readChunk), maxFrame)
	completed := make(chan result, 2)
	go sendLocal(connection, stream, readChunk, completed)
	go receiveRemote(connection, stream, maxFrame, completed)

	var localDone, remoteDone, terminated bool
	var bridgeErr error
	// done is cleared once it fired: a closed channel stays ready, and the loop
	// would spin until both copies returned.
	done := ctx.Done()
	for !localDone || !remoteDone {
		select {
		case <-done:
			done = nil
			if !terminated {
				terminated = true
				cancel()
				_ = connection.Close()
			}
		case item := <-completed:
			if item.local {
				localDone = true
			} else {
				remoteDone = true
			}
			if item.err != nil && bridgeErr == nil {
				bridgeErr = item.err
			}
			if (item.terminal || item.err != nil) && !terminated {
				terminated = true
				cancel()
				_ = connection.Close()
			}
		}
	}
	if !terminated {
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
		AwaitEnd(stream, CloseFlushTimeout)
		cancel()
		_ = connection.Close()
	}
	return bridgeErr
}

// CloseFlushTimeout bounds how long a finished tunnel waits for the relay to
// end it before it is cancelled.
const CloseFlushTimeout = 10 * time.Second

// AwaitEnd lets the last frames of a client stream leave before the caller
// cancels it: Send only queues a frame, and cancelling the stream drops what
// HTTP/2 flow control still holds (the tail of a download whose client had
// half-closed first, and its FIN). The relay ends the tunnel once it read the
// Close, which ends the stream here. A stream that is not a client stream,
// or one that does not end within timeout, is left to the caller's cancel.
func AwaitEnd(stream FrameStream, timeout time.Duration) {
	closer, ok := stream.(interface{ CloseSend() error })
	if !ok {
		return
	}
	_ = closer.CloseSend()
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		for {
			if _, err := stream.Recv(); err != nil {
				return
			}
		}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ended:
	case <-timer.C:
	}
}

func sendLocal(connection net.Conn, stream FrameStream, readChunk int, completed chan<- result) {
	// The smallest power of two that holds readChunk (1 to MaxChunkBytes).
	pool := &readBufferPools[bits.Len(uint(readChunk-1))]
	pooled := pool.Get().(*[]byte)
	defer pool.Put(pooled)
	buffer := (*pooled)[:readChunk]
	for {
		n, err := connection.Read(buffer)
		if n > 0 {
			frame := append([]byte(nil), buffer[:n]...)
			if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: frame}}}); sendErr != nil {
				completed <- result{local: true, terminal: true, err: sendErr}
				return
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if sendErr := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}); sendErr != nil {
					completed <- result{local: true, terminal: true, err: sendErr}
					return
				}
				completed <- result{local: true}
				return
			}
			completed <- result{local: true, terminal: true, err: err}
			return
		}
	}
}

func receiveRemote(connection net.Conn, stream FrameStream, maxFrame int, completed chan<- result) {
	for {
		frame, err := stream.Recv()
		if err != nil {
			completed <- result{terminal: true, err: err}
			return
		}
		switch {
		case frame.GetData() != nil:
			data := frame.GetData().Data
			if len(data) == 0 || len(data) > maxFrame {
				completed <- result{terminal: true, err: errors.New("invalid relay frame size")}
				return
			}
			for len(data) > 0 {
				n, writeErr := connection.Write(data)
				if writeErr != nil {
					completed <- result{terminal: true, err: writeErr}
					return
				}
				data = data[n:]
			}
		case frame.GetHalfClose() != nil:
			if closer, ok := connection.(interface{ CloseWrite() error }); ok {
				_ = closer.CloseWrite()
			}
			completed <- result{}
			return
		case frame.GetClose() != nil:
			completed <- result{terminal: true}
			return
		case frame.GetError() != nil:
			completed <- result{terminal: true, err: fmt.Errorf("relay tunnel error: %s", frame.GetError().Code)}
			return
		default:
			completed <- result{terminal: true, err: errors.New("unexpected relay tunnel frame")}
			return
		}
	}
}
