package lifecycle

import (
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// CommandResultsResentCapability tells Opfield that results of commands
// still running when a control session ended are delivered on the next
// session (resultOutbox), so it keeps those commands pending across the
// reconnect instead of failing them.
const CommandResultsResentCapability = "command_results_resent_v1"

const (
	// outboxLimit bounds the results kept between sessions (the oldest go).
	outboxLimit = 256
	// outboxTTL drops a kept result Opfield has long stopped waiting for.
	outboxTTL = 10 * time.Minute
)

// resultSender is a control session's message writer (stream.Writer).
type resultSender interface {
	Send(*pb.DaemonMessage) error
}

// resultOutbox carries the results of async commands across control session
// reconnects: a result produced while no session is up, or whose send failed
// because the session just ended (stand rc.9: a result lost at the launcher's
// planned reconnect after a daemon update), is kept and delivered once the
// next session is accepted. The zero value is ready.
type resultOutbox struct {
	mu sync.Mutex
	// current is the accepted session's writer; nil between sessions.
	current resultSender
	kept    []keptResult
}

type keptResult struct {
	result *pb.CommandResult
	at     time.Time
}

func resultMessage(result *pb.CommandResult) *pb.DaemonMessage {
	return &pb.DaemonMessage{Payload: &pb.DaemonMessage_CommandResult{CommandResult: result}}
}

// send delivers result on the current session, or keeps it for the next one.
// failed is the session writer whose send failed with err (nil when it went
// out or no session is up); kept reports a result held for the next session.
func (o *resultOutbox) send(result *pb.CommandResult, now time.Time) (failed resultSender, kept bool, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.current != nil {
		if err = o.current.Send(resultMessage(result)); err == nil {
			return nil, false, nil
		}
		failed, o.current = o.current, nil
	}
	o.keepLocked(result, now)
	return failed, true, err
}

func (o *resultOutbox) keepLocked(result *pb.CommandResult, now time.Time) {
	if len(o.kept) >= outboxLimit {
		o.kept = o.kept[len(o.kept)-outboxLimit+1:]
	}
	o.kept = append(o.kept, keptResult{result: result, at: now})
}

// attach makes writer the current session (Opfield accepted it) after
// delivering the kept results on it, oldest first. On a failed send the rest
// stays kept and the session is not attached.
func (o *resultOutbox) attach(writer resultSender, now time.Time) (delivered int, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for len(o.kept) > 0 {
		next := o.kept[0]
		if now.Sub(next.at) <= outboxTTL {
			if err := writer.Send(resultMessage(next.result)); err != nil {
				return delivered, err
			}
			delivered++
		}
		o.kept[0] = keptResult{}
		o.kept = o.kept[1:]
	}
	o.kept = nil
	o.current = writer
	return delivered, nil
}

// detach ends writer's session: results produced from now on are kept.
func (o *resultOutbox) detach(writer resultSender) {
	o.mu.Lock()
	if o.current == writer {
		o.current = nil
	}
	o.mu.Unlock()
}
