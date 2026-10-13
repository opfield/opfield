package server

import (
	"net"
	"time"

	"google.golang.org/grpc/keepalive"
)

// Peer liveness (N-12). A daemon whose host drops off the network leaves its
// connections to this relay open but black-holed: its endpoint registrations
// stay here, and every tunnel admitted to them, and every request sent over a
// tunnel already open, waits for an answer that never comes. The rc.20
// campaign measured 13 s of hanging requests (until the lease fence closed
// the member) although the other replica served all along.
//
// Such a connection is now closed within about peerPingInterval +
// peerAckTimeout (3 s): the relay pings every connection that has been quiet
// for peerPingInterval, and the kernel closes a connection whose sent data
// (that ping, a tunnel's bytes, an incoming tunnel for the endpoint) the
// peer's host does not acknowledge within peerAckTimeout (TCP_USER_TIMEOUT).
// Closing it ends the endpoint's registration and the tunnels bridged over it:
// new tunnels are refused at once ("not registered"), the relay reports the
// holder's endpoint NOT_READY so nginx closes the member socket, and nginx
// retries the requests in flight on the next member where that is safe.
//
// Only an unreachable host is detected this fast. The peer's kernel
// acknowledges TCP data whatever its process does, so a daemon or Opfield
// that is merely busy, or an application that takes long to answer a
// request, never loses its connection: that needs peerPingTimeout without
// an answer to a ping from a host that still acknowledges.
const (
	peerPingInterval = time.Second
	peerAckTimeout   = 2 * time.Second
	peerPingTimeout  = 10 * time.Second
)

func peerKeepalive() keepalive.ServerParameters {
	return keepalive.ServerParameters{Time: peerPingInterval, Timeout: peerPingTimeout}
}

// livenessListener sets the acknowledgement timeout on every accepted
// connection.
type livenessListener struct {
	net.Listener
	ackTimeout time.Duration
}

func withPeerLiveness(listener net.Listener) net.Listener {
	return livenessListener{Listener: listener, ackTimeout: peerAckTimeout}
}

func (l livenessListener) Accept() (net.Conn, error) {
	connection, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	_ = setAckTimeout(connection, l.ackTimeout)
	return peerConn{Conn: connection}, nil
}

// peerConn hides the *net.TCPConn from gRPC on purpose: gRPC sets
// TCP_USER_TIMEOUT to its keepalive ping timeout on connections it can see
// as TCP, which would replace the short acknowledgement timeout with the long
// ping timeout (or, the other way round, drop a merely busy peer after 2 s).
type peerConn struct {
	net.Conn
}

func tcpConn(connection net.Conn) (*net.TCPConn, bool) {
	if wrapped, ok := connection.(peerConn); ok {
		connection = wrapped.Conn
	}
	tcp, ok := connection.(*net.TCPConn)
	return tcp, ok
}
