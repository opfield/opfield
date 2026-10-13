package connector

import (
	"errors"
	"io"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// PlannedServerStop reports an error that only says the server ended the
// stream or connection on purpose: it stopped gracefully (a relay or Opfield
// being updated or restarted sends GOAWAY NO_ERROR, "graceful_stop"), it
// drains the connection, or it closed the stream normally (EOF). The caller
// connects again as usual; nothing failed, so it is no warning (rc.10
// upgrade run, F-4).
func PlannedServerStop(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	current, ok := status.FromError(err)
	if !ok || current.Code() != codes.Unavailable {
		return false
	}
	message := current.Message()
	return strings.Contains(message, "received prior goaway: code: NO_ERROR") ||
		strings.Contains(message, "the connection is draining")
}
