package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Node-local control of availability set members for the operator CLI
// (`docker-daemon availability ...`), which must work while Opfield is down
// (AS10: a forced promotion through the lease when no copy is eligible). A
// unix socket in the state directory, owner-only.

// AvailabilityControlSocket is the socket path under the daemon's state
// directory.
func AvailabilityControlSocket(stateDir string) string {
	return filepath.Join(stateDir, "availability-control.sock")
}

// AvailabilityControlRequest is one CLI request.
type AvailabilityControlRequest struct {
	Action      string `json:"action"` // status | force-promote | force-status
	SetID       string `json:"setId,omitempty"`
	OperationID string `json:"operationId,omitempty"`
	// Over is the commit ballot the operator saw ("round.incarnation.node").
	Over           string `json:"over,omitempty"`
	AcceptDataLoss bool   `json:"acceptDataLoss,omitempty"`
}

// AvailabilityControlMember is one member in a status answer.
type AvailabilityControlMember struct {
	memberha.Report
	// CommitBallot is the newest commit of the set's lease this node verified
	// (what a forced promotion is bound to).
	CommitBallot string `json:"commitBallot,omitempty"`
	CommitHolder string `json:"commitHolder,omitempty"`
}

// AvailabilityControlResponse is the daemon's answer.
type AvailabilityControlResponse struct {
	Error   string                      `json:"error,omitempty"`
	Members []AvailabilityControlMember `json:"members,omitempty"`
	Force   *memberha.ForceResult       `json:"force,omitempty"`
}

// ParseBallot reads Ballot.String() ("round.incarnation.proposer").
func ParseBallot(text string) (memberha.Ballot, error) {
	parts := strings.SplitN(strings.TrimSpace(text), ".", 3)
	usage := errors.New("a ballot is round.incarnation.node, as `availability status` prints it")
	if len(parts) != 3 || parts[2] == "" {
		return memberha.Ballot{}, usage
	}
	round, err1 := strconv.ParseUint(parts[0], 10, 64)
	incarnation, err2 := strconv.ParseUint(parts[1], 10, 64)
	if err1 != nil || err2 != nil {
		return memberha.Ballot{}, usage
	}
	return memberha.Ballot{Round: round, Incarnation: incarnation, Proposer: parts[2]}, nil
}

func (p *DockerPlugin) serveAvailabilityControl(ctx context.Context) {
	path := AvailabilityControlSocket(p.cfg.StateDir)
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		p.logger.Warn("availability control socket unavailable", "path", path, "error", err)
		return
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		p.logger.Warn("availability control socket unavailable", "path", path, "error", err)
		return
	}
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go p.serveAvailabilityControlConn(conn)
	}
}

func (p *DockerPlugin) serveAvailabilityControlConn(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	var request AvailabilityControlRequest
	if err := json.NewDecoder(bufio.NewReader(&controlLimitedReader{conn: conn, left: 64 << 10})).Decode(&request); err != nil {
		_ = json.NewEncoder(conn).Encode(AvailabilityControlResponse{Error: "bad request: " + err.Error()})
		return
	}
	_ = json.NewEncoder(conn).Encode(p.availabilityControl(request))
}

func (p *DockerPlugin) availabilityControl(request AvailabilityControlRequest) AvailabilityControlResponse {
	manager := p.setMembers
	if manager == nil {
		return AvailabilityControlResponse{Error: "the availability member runtime is not running on this node"}
	}
	switch request.Action {
	case "status":
		var members []AvailabilityControlMember
		for _, report := range manager.Reports() {
			if request.SetID != "" && report.SetID != request.SetID {
				continue
			}
			report.Events = nil
			member := AvailabilityControlMember{Report: report}
			if config, ok := manager.Config(report.SetID); ok && config.LeasePolicyID != "" && p.lease != nil && p.lease.runtime != nil {
				if commit, found := p.lease.runtime.Node().ObservedCommit(config.Key()); found {
					member.CommitBallot, member.CommitHolder = commit.Ballot.String(), commit.State.Holder
				}
			}
			members = append(members, member)
		}
		return AvailabilityControlResponse{Members: members}
	case "force-promote":
		if !request.AcceptDataLoss {
			return AvailabilityControlResponse{Error: "a forced promotion needs --accept-data-loss"}
		}
		over, err := ParseBallot(request.Over)
		if err != nil {
			return AvailabilityControlResponse{Error: err.Error()}
		}
		operationID := request.OperationID
		if operationID == "" {
			operationID = fmt.Sprintf("cli-%d", time.Now().UnixMilli())
		}
		result, err := manager.ForcePromote(request.SetID, operationID, over)
		if err != nil {
			message := err.Error()
			if strings.Contains(message, "majority") {
				message += "; a forced promotion still needs a strict majority of the set's voters. Quorum loss is repaired only by a signed voter change from Opfield."
			}
			return AvailabilityControlResponse{Error: message}
		}
		return AvailabilityControlResponse{Force: &result}
	case "force-status":
		result, err := manager.ForceStatusOf(request.SetID)
		if err != nil {
			return AvailabilityControlResponse{Error: err.Error()}
		}
		return AvailabilityControlResponse{Force: &result}
	}
	return AvailabilityControlResponse{Error: fmt.Sprintf("unknown action %q", request.Action)}
}

type controlLimitedReader struct {
	conn net.Conn
	left int
}

func (r *controlLimitedReader) Read(p []byte) (int, error) {
	if r.left <= 0 {
		return 0, errors.New("request too large")
	}
	if len(p) > r.left {
		p = p[:r.left]
	}
	n, err := r.conn.Read(p)
	r.left -= n
	return n, err
}
