package server

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/opfield/opfield/daemon-shared/slowstart"
	"github.com/opfield/opfield/daemon-shared/tlsbatch"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

// The relay port serves two kinds of clients: daemons and Opfield with a
// verified certificate, and nodes that enroll without one (Opfield
// enrollment RPC proxied by the local relay). gRPC bounds message sizes per
// server, and the limit Opfield's proxied RPCs need (512 MiB) let any peer
// that reached the port make the relay assemble messages that large before a
// handler saw them. The split listener completes each TLS handshake itself
// and hands the connection to one of two gRPC servers: the full one, or one
// with small limits for clients without a certificate (F7).
const (
	// tlsHandshakeTimeout bounds a TLS handshake on the relay port.
	tlsHandshakeTimeout = 10 * time.Second
	// anonymousMessageBytes bounds a message from a client without a
	// certificate: enrollment requests and answers are a few KiB.
	anonymousMessageBytes = 1024 * 1024
	// anonymousStreamsPerConnection and maxAnonymousConnections bound what
	// clients without a certificate may hold open at once.
	anonymousStreamsPerConnection = 16
	maxAnonymousConnections       = 256
)

// splitListener accepts connections, completes their TLS handshake and queues
// each for the authenticated or the anonymous server.
type splitListener struct {
	base          net.Listener
	config        *tls.Config
	authenticated *connQueue
	anonymous     *connQueue
	anonymousOpen atomic.Int64
	// sockets maps a connection's remote address to the socket beneath its
	// TLS (laneCollapsed).
	sockets   sync.Map
	done      chan struct{}
	closeOnce sync.Once
	err       error
}

func newSplitListener(base net.Listener, config *tls.Config) *splitListener {
	listener := &splitListener{base: base, config: config, done: make(chan struct{})}
	listener.authenticated = &connQueue{parent: listener, conns: make(chan net.Conn)}
	listener.anonymous = &connQueue{parent: listener, conns: make(chan net.Conn)}
	go listener.run()
	return listener
}

func (l *splitListener) close(err error) {
	l.closeOnce.Do(func() {
		l.err = err
		close(l.done)
		_ = l.base.Close()
	})
}

func (l *splitListener) run() {
	var backoff time.Duration
	for {
		raw, err := l.base.Accept()
		if err != nil {
			if temporary, ok := err.(interface{ Temporary() bool }); ok && temporary.Temporary() {
				// Out of descriptors and the like: wait as gRPC's own loop does.
				backoff = min(max(backoff*2, 5*time.Millisecond), time.Second)
				select {
				case <-time.After(backoff):
					continue
				case <-l.done:
					return
				}
			}
			l.close(err)
			return
		}
		backoff = 0
		go l.handshake(raw)
	}
}

func (l *splitListener) handshake(raw net.Conn) {
	// Each Write's records leave in one send (tlsbatch); the slow start
	// guard beneath needs the socket peerConn hides from gRPC.
	var below *tlsbatch.Conn
	if tcp, ok := tcpConn(raw); ok {
		below = tlsbatch.BelowSocket(raw, tcp)
	} else {
		below = tlsbatch.Below(raw)
	}
	connection := tls.Server(below, l.config)
	ctx, cancel := context.WithTimeout(context.Background(), tlsHandshakeTimeout)
	err := connection.HandshakeContext(ctx)
	cancel()
	if err != nil {
		_ = raw.Close()
		return
	}
	state := connection.ConnectionState()
	if state.NegotiatedProtocol == "" {
		// HTTP/2 over TLS needs ALPN; gRPC's own credentials refuse it too.
		_ = connection.Close()
		return
	}
	queue := l.authenticated
	batched := tlsbatch.Above(connection, below)
	key := raw.RemoteAddr().String()
	l.sockets.Store(key, below)
	forget := func() { l.sockets.CompareAndDelete(key, below) }
	var handed net.Conn = &handshakenConn{Conn: batched, state: state, forget: forget}
	if len(state.VerifiedChains) == 0 {
		if l.anonymousOpen.Add(1) > maxAnonymousConnections {
			l.anonymousOpen.Add(-1)
			_ = connection.Close()
			return
		}
		queue = l.anonymous
		handed = &handshakenConn{Conn: batched, state: state, forget: forget, release: func() { l.anonymousOpen.Add(-1) }}
	}
	select {
	case queue.conns <- handed:
	case <-l.done:
		_ = handed.Close()
	}
}

// connQueue is the net.Listener one gRPC server serves.
type connQueue struct {
	parent *splitListener
	conns  chan net.Conn
}

func (q *connQueue) Accept() (net.Conn, error) {
	select {
	case connection := <-q.conns:
		return connection, nil
	case <-q.parent.done:
		if q.parent.err != nil && !errors.Is(q.parent.err, net.ErrClosed) {
			return nil, q.parent.err
		}
		return nil, net.ErrClosed
	}
}

// Close closes the shared port: both servers stop together.
func (q *connQueue) Close() error {
	q.parent.close(net.ErrClosed)
	return nil
}

func (q *connQueue) Addr() net.Addr { return q.parent.base.Addr() }

// handshakenConn is a TLS connection whose handshake the split listener
// completed. It hides the TCP connection from gRPC like peerConn does.
type handshakenConn struct {
	net.Conn
	state     tls.ConnectionState
	release   func()
	forget    func()
	closeOnce sync.Once
}

func (c *handshakenConn) Close() error {
	err := c.Conn.Close()
	c.closeOnce.Do(func() {
		if c.forget != nil {
			c.forget()
		}
		if c.release != nil {
			c.release()
		}
	})
	return err
}

// laneCollapsed reports a connection (by its remote address) whose sending
// side's congestion state is stale at its path's round trip
// (slowstart.State.Stale: collapsed, or a threshold learned on a shorter path
// that holds a transfer below slowstart.SlowRate) and that is not delivering
// at slowstart.BusyRate right now: a lane the node had better replace, since
// only a new connection starts afresh. A busy LAN lane after an ordinary loss
// is neither.
func (l *splitListener) laneCollapsed(remote string) bool {
	value, ok := l.sockets.Load(remote)
	if !ok {
		return false
	}
	state, ok := slowstart.ReadState(value.(*tlsbatch.Conn))
	return ok && state.Stale() && !state.Busy()
}

// handshakenCredentials gives gRPC the identity of a handshaken connection in
// the shape gRPC's TLS credentials give it, so peer identities read the same.
type handshakenCredentials struct{}

func (handshakenCredentials) ClientHandshake(context.Context, string, net.Conn) (net.Conn, credentials.AuthInfo, error) {
	return nil, nil, errors.New("relay server credentials do not dial")
}

func (handshakenCredentials) ServerHandshake(raw net.Conn) (net.Conn, credentials.AuthInfo, error) {
	connection, ok := raw.(*handshakenConn)
	if !ok {
		_ = raw.Close()
		return nil, nil, errors.New("connection did not pass the relay TLS handshake")
	}
	return connection, credentials.TLSInfo{State: connection.state, CommonAuthInfo: credentials.CommonAuthInfo{SecurityLevel: credentials.PrivacyAndIntegrity}}, nil
}

func (handshakenCredentials) Info() credentials.ProtocolInfo {
	return credentials.ProtocolInfo{SecurityProtocol: "tls", SecurityVersion: "1.2"}
}

func (c handshakenCredentials) Clone() credentials.TransportCredentials { return c }

func (handshakenCredentials) OverrideServerName(string) error { return nil }

// serverPair stops both servers of the relay port together.
type serverPair [2]*grpc.Server

func (p serverPair) GracefulStop() {
	var wait sync.WaitGroup
	for _, server := range p {
		wait.Add(1)
		go func() {
			defer wait.Done()
			server.GracefulStop()
		}()
	}
	wait.Wait()
}

func (p serverPair) Stop() {
	for _, server := range p {
		server.Stop()
	}
}
