package broker

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/codec"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type tunnelStream interface {
	tunnelReceiver
	tunnelSender
}

func bridge(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, disableIdleTimeout, reapHalfClosed bool, metrics *routeMetrics) error {
	idleTimeout := IdleTimeout
	halfCloseTimeout := time.Duration(0)
	if disableIdleTimeout {
		idleTimeout = 0
	}
	if reapHalfClosed {
		halfCloseTimeout = ProxyHalfCloseTimeout
	}
	return bridgeWithTimeouts(left, right, maxFrame, stopped, idleTimeout, halfCloseTimeout, metrics)
}

func bridgeWithIdleTimeout(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, idleTimeout time.Duration, metrics *routeMetrics) error {
	return bridgeWithTimeouts(left, right, maxFrame, stopped, idleTimeout, 0, metrics)
}

func bridgeWithTimeouts(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, idleTimeout, halfCloseTimeout time.Duration, metrics *routeMetrics) error {
	results := make(chan pumpResult, 2)
	activity := make(chan struct{}, 1)
	bridgeDone := make(chan struct{})
	defer close(bridgeDone)
	go func() {
		terminal, err := pumpEither(right, left, maxFrame, activity, bridgeDone, func(bytes uint64) {
			if metrics == nil {
				return
			}
			metrics.sourceToTargetBytes.Add(bytes)
			metrics.touch()
		})
		results <- pumpResult{terminal: terminal, err: err, direction: pumpSourceToTarget}
	}()
	go func() {
		terminal, err := pumpEither(left, right, maxFrame, activity, bridgeDone, func(bytes uint64) {
			if metrics == nil {
				return
			}
			metrics.targetToSourceBytes.Add(bytes)
			metrics.touch()
		})
		results <- pumpResult{terminal: terminal, err: err, direction: pumpTargetToSource}
	}()
	var timer *time.Timer
	var idle <-chan time.Time
	if idleTimeout > 0 {
		timer = time.NewTimer(idleTimeout)
		idle = timer.C
		defer timer.Stop()
	}
	var halfCloseTimer *time.Timer
	var halfCloseDeadline <-chan time.Time
	defer func() {
		if halfCloseTimer != nil {
			halfCloseTimer.Stop()
		}
	}()
	completedDirections := 0
	for {
		select {
		case result := <-results:
			if err := normalizeBridgeError(result.err); err != nil {
				return err
			}
			if result.terminal {
				return nil
			}
			completedDirections++
			if completedDirections == 2 {
				return nil
			}
			if halfCloseTimeout > 0 && result.direction == pumpTargetToSource && halfCloseTimer == nil {
				halfCloseTimer = time.NewTimer(halfCloseTimeout)
				halfCloseDeadline = halfCloseTimer.C
			}
		case <-activity:
			if halfCloseTimer != nil {
				if !halfCloseTimer.Stop() {
					select {
					case <-halfCloseTimer.C:
					default:
					}
				}
				halfCloseTimer.Reset(halfCloseTimeout)
			}
			if timer == nil {
				continue
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(idleTimeout)
		case <-idle:
			return status.Error(codes.DeadlineExceeded, "tunnel idle timeout reached")
		case <-halfCloseDeadline:
			// Activity and the deadline can become ready in the same scheduler turn.
			// Prefer already-observed traffic over reaping the bridge so a busy
			// half-closed connection is not terminated just because the event loop
			// was briefly descheduled at the deadline boundary.
			select {
			case <-activity:
				halfCloseTimer.Reset(halfCloseTimeout)
				if timer != nil {
					if !timer.Stop() {
						select {
						case <-timer.C:
						default:
						}
					}
					timer.Reset(idleTimeout)
				}
				continue
			default:
				return status.Error(codes.DeadlineExceeded, "tunnel half-close timeout reached")
			}
		case <-stopped:
			// The caller replaces it with the status the tunnel was closed
			// with (activeTunnel.bridgeResult).
			return errTunnelRevoked
		}
	}
}

type tunnelReceiver interface {
	Recv() (*relayv1.TunnelFrame, error)
}
type tunnelSender interface {
	Send(*relayv1.TunnelFrame) error
}

// localServiceReadChunk bounds the read buffer of a local service stream: the
// negotiated frame size is an upper bound, and a buffer of up to 1 MiB kept
// for every registry tunnel's lifetime cost a megabyte per concurrent pull
// (F10). Reads larger than this only saved syscalls.
const localServiceReadChunk = 64 * 1024

type connectionTunnelStream struct {
	connection net.Conn
	maxFrame   int
	// readBuffer is reused by every Recv; only one pump reads a stream.
	readBuffer []byte
	writeMu    sync.Mutex
}

func (s *connectionTunnelStream) Recv() (*relayv1.TunnelFrame, error) {
	if size := min(s.maxFrame, localServiceReadChunk); len(s.readBuffer) != size {
		s.readBuffer = make([]byte, size)
	}
	count, err := s.connection.Read(s.readBuffer)
	if count > 0 {
		// A sent message must not change afterwards, so each frame gets its own
		// copy sized to what was read rather than a fresh full-size frame.
		data := make([]byte, count)
		copy(data, s.readBuffer[:count])
		return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}, nil
	}
	return nil, err
}

func (s *connectionTunnelStream) Send(frame *relayv1.TunnelFrame) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	switch payload := frame.Payload.(type) {
	case *relayv1.TunnelFrame_Data:
		for remaining := payload.Data.Data; len(remaining) > 0; {
			written, err := s.connection.Write(remaining)
			if err != nil {
				return err
			}
			remaining = remaining[written:]
		}
		return nil
	case *relayv1.TunnelFrame_HalfClose:
		if tcp, ok := s.connection.(*net.TCPConn); ok {
			return tcp.CloseWrite()
		}
		return nil
	case *relayv1.TunnelFrame_Close:
		return s.connection.Close()
	case *relayv1.TunnelFrame_Error:
		_ = s.connection.Close()
		return fmt.Errorf("tunnel peer error: %s", payload.Error.Message)
	default:
		return status.Error(codes.InvalidArgument, "unexpected tunnel frame for local service")
	}
}

type pumpResult struct {
	terminal  bool
	err       error
	direction pumpDirection
}

type pumpDirection uint8

const (
	pumpSourceToTarget pumpDirection = iota
	pumpTargetToSource
)

func pump(destination tunnelSender, source tunnelReceiver, maxFrame int, activity chan<- struct{}, recordBytes func(uint64)) (bool, error) {
	return pumpUntil(destination, source, maxFrame, activity, nil, recordBytes)
}

func pumpUntil(destination tunnelSender, source tunnelReceiver, maxFrame int, activity chan<- struct{}, stopped <-chan struct{}, recordBytes func(uint64)) (bool, error) {
	for {
		frame, err := source.Recv()
		if err != nil {
			if err == io.EOF {
				if channelClosed(stopped) {
					return true, nil
				}
				return false, destination.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
			}
			// A cancelled or failed gRPC stream is a terminal transport event, not
			// a TCP half-close. Mark it terminal even when normalizeBridgeError
			// later suppresses the expected Canceled status; otherwise the bridge
			// waits forever for the peer direction and leaks session capacity.
			return true, err
		}
		dataBytes := 0
		switch payload := frame.Payload.(type) {
		case *relayv1.TunnelFrame_Data:
			if len(payload.Data.Data) == 0 || len(payload.Data.Data) > maxFrame {
				return false, status.Error(codes.InvalidArgument, "tunnel data frame exceeds negotiated limit")
			}
			dataBytes = len(payload.Data.Data)
		case *relayv1.TunnelFrame_HalfClose, *relayv1.TunnelFrame_Close, *relayv1.TunnelFrame_Error:
		default:
			return false, status.Error(codes.InvalidArgument, "unexpected tunnel frame")
		}
		if channelClosed(stopped) {
			return true, nil
		}
		if err := destination.Send(frame); err != nil {
			return false, err
		}
		if dataBytes > 0 && recordBytes != nil {
			recordBytes(uint64(dataBytes))
		}
		select {
		case activity <- struct{}{}:
		default:
		}
		if frame.GetClose() != nil || frame.GetError() != nil {
			return true, nil
		}
		if frame.GetHalfClose() != nil {
			return false, nil
		}
	}
}

// rawTunnelStream is a gRPC stream of the relay's servers: it receives and
// sends codec.TunnelFrames, a tunnel's frames as the bytes gRPC read.
type rawTunnelStream interface {
	RecvMsg(any) error
	SendMsg(any) error
}

// pumpEither carries frames from source to destination as received when both
// are gRPC streams, and decoded otherwise (a built-in local service).
func pumpEither(destination tunnelSender, source tunnelReceiver, maxFrame int, activity chan<- struct{}, stopped <-chan struct{}, recordBytes func(uint64)) (bool, error) {
	rawDestination, destinationOK := destination.(rawTunnelStream)
	rawSource, sourceOK := source.(rawTunnelStream)
	if destinationOK && sourceOK {
		return pumpRaw(rawDestination, rawSource, maxFrame, activity, stopped, recordBytes)
	}
	return pumpUntil(destination, source, maxFrame, activity, stopped, recordBytes)
}

// pumpRaw is pumpUntil for frames the relay passes on without decoding them:
// it checks what pumpUntil checks (the payload kind and the data size) from
// the frame's encoded header.
func pumpRaw(destination, source rawTunnelStream, maxFrame int, activity chan<- struct{}, stopped <-chan struct{}, recordBytes func(uint64)) (bool, error) {
	for {
		var frame codec.TunnelFrame
		if err := source.RecvMsg(&frame); err != nil {
			if err == io.EOF {
				if channelClosed(stopped) {
					return true, nil
				}
				return false, destination.SendMsg(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
			}
			return true, err
		}
		if frame.Kind == codec.KindUnparsed {
			decoded, err := frame.Decode()
			if err != nil {
				return true, status.Error(codes.Internal, "grpc: failed to unmarshal the received message: "+err.Error())
			}
			terminal, done, err := pumpOne(destination.SendMsg, decoded, maxFrame, activity, stopped, recordBytes)
			if done {
				return terminal, err
			}
			continue
		}
		dataBytes := 0
		switch frame.Kind {
		case codec.KindData:
			if frame.DataLen == 0 || frame.DataLen > maxFrame {
				frame.Free()
				return false, status.Error(codes.InvalidArgument, "tunnel data frame exceeds negotiated limit")
			}
			dataBytes = frame.DataLen
		case codec.KindHalfClose, codec.KindClose, codec.KindError:
		default:
			frame.Free()
			return false, status.Error(codes.InvalidArgument, "unexpected tunnel frame")
		}
		if channelClosed(stopped) {
			frame.Free()
			return true, nil
		}
		kind := frame.Kind
		if err := destination.SendMsg(&frame); err != nil {
			frame.Free()
			return false, err
		}
		if dataBytes > 0 && recordBytes != nil {
			recordBytes(uint64(dataBytes))
		}
		select {
		case activity <- struct{}{}:
		default:
		}
		if kind == codec.KindClose || kind == codec.KindError {
			return true, nil
		}
		if kind == codec.KindHalfClose {
			return false, nil
		}
	}
}

// pumpOne passes one decoded frame on as pumpUntil does; done reports that
// the pump ends with terminal and err.
func pumpOne(send func(any) error, frame *relayv1.TunnelFrame, maxFrame int, activity chan<- struct{}, stopped <-chan struct{}, recordBytes func(uint64)) (terminal, done bool, err error) {
	dataBytes := 0
	switch payload := frame.Payload.(type) {
	case *relayv1.TunnelFrame_Data:
		if len(payload.Data.Data) == 0 || len(payload.Data.Data) > maxFrame {
			return false, true, status.Error(codes.InvalidArgument, "tunnel data frame exceeds negotiated limit")
		}
		dataBytes = len(payload.Data.Data)
	case *relayv1.TunnelFrame_HalfClose, *relayv1.TunnelFrame_Close, *relayv1.TunnelFrame_Error:
	default:
		return false, true, status.Error(codes.InvalidArgument, "unexpected tunnel frame")
	}
	if channelClosed(stopped) {
		return true, true, nil
	}
	if err := send(frame); err != nil {
		return false, true, err
	}
	if dataBytes > 0 && recordBytes != nil {
		recordBytes(uint64(dataBytes))
	}
	select {
	case activity <- struct{}{}:
	default:
	}
	if frame.GetClose() != nil || frame.GetError() != nil {
		return true, true, nil
	}
	if frame.GetHalfClose() != nil {
		return false, true, nil
	}
	return false, false, nil
}

func channelClosed(channel <-chan struct{}) bool {
	if channel == nil {
		return false
	}
	select {
	case <-channel:
		return true
	default:
		return false
	}
}

func normalizeBridgeError(err error) error {
	if err == nil || err == io.EOF || status.Code(err) == codes.Canceled {
		return nil
	}
	return err
}

func readyFrame(maxFrame int) *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: uint32(maxFrame)}}}
}

func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func minNonZero(fallback int, values ...int) int {
	result := fallback
	for _, value := range values {
		if value > 0 && value < result {
			result = value
		}
	}
	return result
}
