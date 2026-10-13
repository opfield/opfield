package connector

import (
	"errors"
	"strings"
	"syscall"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// PlannedDisconnect reports a stream that ended because its peer or this
// process closed it on purpose: the peer stopped gracefully or drained the
// connection (a relay or Opfield restarting for an update sends GOAWAY
// "graceful_stop" first), the stream ended cleanly (EOF), or this process
// closed the connection (a planned control reconnect after a launcher
// update), or the peer cancelled the stream itself (RST_STREAM CANCEL: a
// Opfield shutting down for its update or restart ends its streams so;
// a peer that fails drops the connection instead). Such an end is logged as
// information, not as a warning (stand rc.10 O-2, rc.11 upgrade run N-2).
func PlannedDisconnect(err error) bool {
	if err == nil || PlannedServerStop(err) {
		return true
	}
	current, ok := status.FromError(err)
	if !ok {
		return false
	}
	switch current.Code() {
	case codes.Canceled:
		return strings.Contains(current.Message(), "client connection is closing") ||
			strings.Contains(current.Message(), "RST_STREAM with error code: CANCEL")
	case codes.Unavailable:
		return strings.Contains(current.Message(), "graceful_stop")
	}
	return false
}

// RefusedDial reports a session whose connection could not be opened because
// its peer refused it: an Opfield or relay restarting for its update listens
// again within RestartQuiet, so the first such failures are information, and
// only a longer outage warns, as connectWithRetry logs them (stand rc.13 O-d:
// "dial tcp …:9443: connect: connection refused" during an Opfield restart).
func RefusedDial(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	current, ok := status.FromError(err)
	return ok && current.Code() == codes.Unavailable && strings.Contains(current.Message(), "connection refused")
}
