// Package controlpath lets a daemon reach Opfield through a relay that
// predates the opfield.v1 service names.
//
// Daemons call the opfield.v1 services. Opfield answers them under both the
// opfield.v1 and the gateway.v1 names, but every daemon connects through the
// local relay, and a relay of 2.12.0 forwards only gateway.v1 paths: it answers
// any other path with Unimplemented before anything reaches Opfield. Relays are
// updated separately from Opfield and its daemons, so a 2.12.1 daemon can meet
// such a relay. The interceptors here send a call again under its gateway.v1
// name when its opfield.v1 name was refused with Unimplemented; nothing reached
// Opfield in that case, so the retry repeats no work.
package controlpath

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const (
	// Prefix is the path prefix of the opfield.v1 services.
	Prefix = "/opfield.v1."
	// LegacyPrefix is the same services' path prefix in 2.12.0.
	// legacy-name: gateway.v1 method paths, the only ones 2.12.0 relays forward — remove once every relay reports none
	LegacyPrefix = "/gateway.v1."
)

// LegacyMethod returns the gateway.v1 path of an opfield.v1 method.
func LegacyMethod(method string) (string, bool) {
	rest, ok := strings.CutPrefix(method, Prefix)
	if !ok {
		return "", false
	}
	return LegacyPrefix + rest, true
}

func refused(err error) bool { return status.Code(err) == codes.Unimplemented }

// DialOptions installs the fallback on a client connection.
func DialOptions() []grpc.DialOption {
	return []grpc.DialOption{
		grpc.WithChainUnaryInterceptor(UnaryInterceptor),
		grpc.WithChainStreamInterceptor(StreamInterceptor),
	}
}

// UnaryInterceptor sends a refused opfield.v1 call again under its gateway.v1
// name.
func UnaryInterceptor(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	err := invoker(ctx, method, req, reply, cc, opts...)
	if legacy, ok := LegacyMethod(method); ok && refused(err) {
		return invoker(ctx, legacy, req, reply, cc, opts...)
	}
	return err
}

// StreamInterceptor opens opfield.v1 streams that reopen under their gateway.v1
// name when the first answer is Unimplemented. Until the stream received its
// first message, what was sent on it is kept and sent again on the reopened
// stream.
func StreamInterceptor(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
	legacy, ok := LegacyMethod(method)
	stream, err := streamer(ctx, desc, cc, method, opts...)
	if !ok {
		return stream, err
	}
	if err != nil {
		if refused(err) {
			return streamer(ctx, desc, cc, legacy, opts...)
		}
		return nil, err
	}
	return &fallbackStream{
		current: stream,
		reopen:  func() (grpc.ClientStream, error) { return streamer(ctx, desc, cc, legacy, opts...) },
	}, nil
}

type fallbackStream struct {
	reopen func() (grpc.ClientStream, error)

	mu      sync.Mutex
	current grpc.ClientStream
	// settled: the stream received a message or was reopened; nothing is kept
	// any more.
	settled bool
	// sent are the messages sent before the stream settled, in order.
	sent []any
	// sendClosed: CloseSend was called before the stream settled.
	sendClosed bool
}

func (s *fallbackStream) stream() grpc.ClientStream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

func (s *fallbackStream) SendMsg(m any) error {
	s.mu.Lock()
	stream, settled := s.current, s.settled
	if !settled {
		kept := m
		if message, ok := m.(proto.Message); ok {
			kept = proto.Clone(message)
		}
		s.sent = append(s.sent, kept)
	}
	s.mu.Unlock()
	err := stream.SendMsg(m)
	if !settled && errors.Is(err, io.EOF) {
		// The stream ended; RecvMsg tells why, and reopens it when the
		// relay refused the name. The message is kept for that.
		return nil
	}
	return err
}

func (s *fallbackStream) CloseSend() error {
	s.mu.Lock()
	stream := s.current
	if !s.settled {
		s.sendClosed = true
	}
	s.mu.Unlock()
	return stream.CloseSend()
}

func (s *fallbackStream) RecvMsg(m any) error {
	stream := s.stream()
	err := stream.RecvMsg(m)
	// gRPC allows one RecvMsg at a time, so only this call reopens the stream.
	s.mu.Lock()
	if s.settled {
		s.mu.Unlock()
		return err
	}
	if !refused(err) {
		if err == nil {
			s.settled, s.sent = true, nil
		}
		s.mu.Unlock()
		return err
	}
	reopened, reopenErr := s.reopen()
	if reopenErr != nil {
		s.mu.Unlock()
		return reopenErr
	}
	for _, message := range s.sent {
		if sendErr := reopened.SendMsg(message); sendErr != nil && !errors.Is(sendErr, io.EOF) {
			s.mu.Unlock()
			return sendErr
		}
	}
	if s.sendClosed {
		if closeErr := reopened.CloseSend(); closeErr != nil {
			s.mu.Unlock()
			return closeErr
		}
	}
	s.current, s.settled, s.sent = reopened, true, nil
	s.mu.Unlock()
	return reopened.RecvMsg(m)
}

func (s *fallbackStream) Header() (metadata.MD, error) { return s.stream().Header() }

func (s *fallbackStream) Trailer() metadata.MD { return s.stream().Trailer() }

func (s *fallbackStream) Context() context.Context { return s.stream().Context() }
