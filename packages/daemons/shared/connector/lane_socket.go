package connector

import (
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/slowstart"
	"github.com/opfield/opfield/daemon-shared/tlsbatch"
	"google.golang.org/grpc"
)

// LaneSocket is the TCP connection currently beneath a relay lane: gRPC
// reconnects a lane over a new socket, and the lane's TCP state (what the
// lane learned of its path) is read from the current one.
type LaneSocket struct {
	mu     sync.Mutex
	conn   *tlsbatch.Conn
	dialed time.Time
}

// LaneRenewHeader is the response header a relay sets on a tunnel whose lane
// connection's sending side collapsed (slowstart.State.Collapsed): the node
// replaces the lane's connection (its own sending side it reads itself).
const LaneRenewHeader = "gw-lane-renew"

var laneSockets sync.Map // *grpc.ClientConn -> *LaneSocket

// LaneSocketOf returns the socket holder of a relay lane dialled by this
// package, or nil.
func LaneSocketOf(conn *grpc.ClientConn) *LaneSocket {
	if socket, ok := laneSockets.Load(conn); ok {
		return socket.(*LaneSocket)
	}
	return nil
}

// ForgetLane drops a closed lane's socket holder.
func ForgetLane(conn *grpc.ClientConn) { laneSockets.Delete(conn) }

func (s *LaneSocket) attach(conn *tlsbatch.Conn) {
	s.mu.Lock()
	s.conn, s.dialed = conn, time.Now()
	s.mu.Unlock()
}

// Dialed is when the current socket was connected (zero before the first).
func (s *LaneSocket) Dialed() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dialed
}

// State reads the current socket's TCP state; false where unknown.
func (s *LaneSocket) State() (slowstart.State, bool) {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn == nil {
		return slowstart.State{}, false
	}
	return slowstart.ReadState(conn)
}
