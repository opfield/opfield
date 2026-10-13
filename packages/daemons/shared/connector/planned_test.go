package connector

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestPlannedDisconnect(t *testing.T) {
	for _, tc := range []struct {
		err     error
		planned bool
	}{
		{io.EOF, true},
		{fmt.Errorf("recv: %w", io.EOF), true},
		{status.Error(codes.Unavailable, `closing transport due to: connection error: desc = "error reading from server: EOF", received prior goaway: code: NO_ERROR, debug data: "graceful_stop"`), true},
		{status.Error(codes.Canceled, "grpc: the client connection is closing"), true},
		{status.Error(codes.Canceled, "stream terminated by RST_STREAM with error code: CANCEL"), true},
		{status.Error(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: dial tcp 127.0.0.1:9443: connect: connection refused\""), false},
		{status.Error(codes.Canceled, "context canceled"), false},
		{errors.New("reset by peer"), false},
	} {
		if got := PlannedDisconnect(tc.err); got != tc.planned {
			t.Errorf("%v: planned %v, want %v", tc.err, got, tc.planned)
		}
	}
}

func TestRefusedDial(t *testing.T) {
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	for _, tc := range []struct {
		err     error
		refused bool
	}{
		// The monitoring daemon and the relay supervisor while Opfield restarted (stand rc.13 O-d).
		{status.Error(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: dial tcp 172.18.0.4:9443: connect: connection refused\""), true},
		{fmt.Errorf("connect: %w", refused), true},
		{status.Error(codes.Unavailable, "connection error: desc = \"transport: Error while dialing: dial tcp 10.0.0.1:9443: i/o timeout\""), false},
		{status.Error(codes.PermissionDenied, "connection refused"), false},
		{errors.New("reset by peer"), false},
		{nil, false},
	} {
		if got := RefusedDial(tc.err); got != tc.refused {
			t.Errorf("%v: refused %v, want %v", tc.err, got, tc.refused)
		}
	}
}
