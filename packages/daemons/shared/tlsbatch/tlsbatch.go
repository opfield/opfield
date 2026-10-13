// Package tlsbatch sends what one Write of a TLS connection encrypts in one
// write to its socket. crypto/tls writes every record (at most 16 KiB) with a
// write call of its own: a relay lane moving a bulk stream made one send per
// 16 KiB on every hop, and those sends took about 40 % of a daemon's and a
// relay's CPU on a LAN. The bytes on the wire are the same; only how many
// syscalls carry them changes.
//
// The raw connection goes beneath the TLS connection (Below) and the TLS
// connection is wrapped above (Above): a Write above collects the records the
// TLS connection writes below and sends them when it returns, so nothing is
// ever held back after a Write returned. Writes the TLS connection makes on
// its own (the handshake, alerts, key updates while reading) go out at once,
// after whatever an ongoing Write collected before them, in the order they
// were encrypted.
package tlsbatch

import (
	"net"
	"sync"
	"syscall"

	"github.com/opfield/opfield/daemon-shared/slowstart"
)

// WriteBuffer is the gRPC write buffer of a daemon's batched relay lane: the
// most its writer collects before one Write (gRPC's default is 32 KiB). The
// relay keeps gRPC's default: with 256 KiB on the relay's side, streams over
// links with a round trip (60 ms) fell to half or less, down to stalls of
// 1 MB/s, while the daemons' side showed no such effect.
const WriteBuffer = 256 * 1024

// MaxBatch is the most a Write collects before it sends: a larger Write goes
// out in pieces of about this size.
const MaxBatch = 512 * 1024

var batchBuffers = sync.Pool{New: func() any {
	buffer := make([]byte, 0, MaxBatch+32*1024)
	return &buffer
}}

// Conn is the raw connection beneath a TLS connection.
type Conn struct {
	net.Conn
	mu sync.Mutex
	// collecting counts Writes above in progress: while one is, writes from
	// the TLS connection are collected in pending.
	collecting int
	pending    *[]byte
	err        error
	// slowStart keeps a lane's slow start after a pause from ending at a
	// round trip the connection learned long ago (see slowstart).
	slowStart *slowstart.Guard
}

// Below wraps the raw connection a TLS connection is made over.
func Below(raw net.Conn) *Conn {
	return &Conn{Conn: raw, slowStart: slowstart.New(raw)}
}

// BelowSocket is Below for a raw connection that hides its TCP socket (the
// relay hides it from gRPC): socket is the TCP connection beneath raw.
func BelowSocket(raw, socket net.Conn) *Conn {
	return &Conn{Conn: raw, slowStart: slowstart.New(socket)}
}

// SyscallConn exposes the raw connection's socket (gRPC reads and sets TCP
// options through it).
func (c *Conn) SyscallConn() (syscall.RawConn, error) {
	if conn, ok := c.Conn.(syscall.Conn); ok {
		return conn.SyscallConn()
	}
	return nil, syscall.EINVAL
}

// NetConn returns the raw connection.
func (c *Conn) NetConn() net.Conn { return c.Conn }

// Write is called by the TLS connection with one encrypted record (or
// handshake flight) at a time, in encryption order.
func (c *Conn) Write(record []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return 0, c.err
	}
	if c.collecting == 0 {
		if err := c.flushLocked(); err != nil {
			return 0, err
		}
		return c.writeLocked(record)
	}
	if c.pending == nil {
		c.pending = batchBuffers.Get().(*[]byte)
	}
	*c.pending = append(*c.pending, record...)
	if len(*c.pending) >= MaxBatch {
		if err := c.flushLocked(); err != nil {
			return 0, err
		}
	}
	return len(record), nil
}

func (c *Conn) writeLocked(data []byte) (int, error) {
	c.slowStart.BeforeWrite()
	n, err := c.Conn.Write(data)
	if err != nil {
		c.err = err
	}
	return n, err
}

// flushLocked sends what was collected and returns the buffer to the pool.
func (c *Conn) flushLocked() error {
	if c.pending == nil {
		return c.err
	}
	pending := c.pending
	c.pending = nil
	var err error
	if len(*pending) > 0 && c.err == nil {
		_, err = c.writeLocked(*pending)
	}
	*pending = (*pending)[:0]
	batchBuffers.Put(pending)
	if err != nil {
		return err
	}
	return c.err
}

func (c *Conn) begin() {
	c.mu.Lock()
	c.collecting++
	c.mu.Unlock()
}

func (c *Conn) end() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.collecting--
	if c.collecting > 0 {
		return nil
	}
	return c.flushLocked()
}

// Above wraps the TLS connection (or gRPC's wrapper of it) made over below.
func Above(conn net.Conn, below *Conn) net.Conn {
	return &tlsConn{Conn: conn, below: below}
}

type tlsConn struct {
	net.Conn
	below *Conn
}

func (c *tlsConn) Write(data []byte) (int, error) {
	c.below.begin()
	n, err := c.Conn.Write(data)
	if flushErr := c.below.end(); err == nil && flushErr != nil {
		// The TLS connection counted the bytes as written; the socket did
		// not take them, and the connection is broken from here on.
		return n, flushErr
	}
	return n, err
}

// SyscallConn keeps the socket reachable through the wrapper.
func (c *tlsConn) SyscallConn() (syscall.RawConn, error) {
	return c.below.SyscallConn()
}

// NetConn returns the wrapped connection (the TLS connection).
func (c *tlsConn) NetConn() net.Conn { return c.Conn }
