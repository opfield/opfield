package memberha

import (
	"context"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// echoBackend is an engine that answers every byte.
func echoBackend(t *testing.T) net.Listener {
	t.Helper()
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(conn, conn) }()
		}
	}()
	return backend
}

func startProxy(t *testing.T, admit *atomic.Bool, backend net.Listener) *Proxy {
	t.Helper()
	proxy := NewProxy("127.0.0.1:0", admit.Load, func(ctx context.Context) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, "tcp", backend.Addr().String())
	}, nil)
	if err := proxy.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(proxy.Close)
	return proxy
}

func refused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }

func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting until %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func echo(t *testing.T, conn net.Conn) {
	t.Helper()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 4)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(conn, buffer); err != nil || string(buffer) != "ping" {
		t.Fatalf("echo = %q, %v", buffer, err)
	}
}

// A member that does not serve has no listener: connections are refused by
// the kernel (never accepted and closed), on the same port it listens on
// again once it serves.
func TestProxyListensOnlyWhileTheMemberServes(t *testing.T) {
	var admit atomic.Bool
	proxy := startProxy(t, &admit, echoBackend(t))
	address := proxy.Addr().String()
	if proxy.Listening() {
		t.Fatal("a member that does not serve must not listen")
	}
	if _, err := net.Dial("tcp", address); !refused(err) {
		t.Fatalf("dial a copy's port = %v, want connection refused", err)
	}
	admit.Store(true)
	waitFor(t, "the serving member listens", proxy.Listening)
	client, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	echo(t, client)
	admit.Store(false)
	waitFor(t, "the port closes", func() bool { return !proxy.Listening() })
	if _, err := net.Dial("tcp", address); !refused(err) {
		t.Fatalf("dial after the member stopped serving = %v, want connection refused", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Fatal("the session must be closed once the member stops serving")
	}
}

// Fast holder flaps never leave the port open on a member that does not
// serve.
func TestProxyHolderFlapsLeaveNoListenerOnANonHolder(t *testing.T) {
	var admit atomic.Bool
	proxy := startProxy(t, &admit, echoBackend(t))
	for i := 0; i < 60; i++ {
		admit.Store(i%2 == 0)
		if i%7 == 0 {
			proxy.Sync()
		}
		time.Sleep(time.Duration(i%4) * 20 * time.Millisecond)
	}
	admit.Store(false)
	waitFor(t, "the port closes after the flaps", func() bool { return !proxy.Listening() })
	if _, err := net.Dial("tcp", proxy.Addr().String()); !refused(err) {
		t.Fatalf("dial a non-holder after flaps = %v, want connection refused", err)
	}
}

// A client with several hosts (libpq host=A,B target_session_attrs=read-write)
// that lists the copy first is refused there and connects to the primary.
func TestMultiHostClientMovesFromTheCopyToThePrimary(t *testing.T) {
	backend := echoBackend(t)
	var copyAdmits, primaryAdmits atomic.Bool
	primaryAdmits.Store(true)
	copyProxy := startProxy(t, &copyAdmits, backend)
	primaryProxy := startProxy(t, &primaryAdmits, backend)
	var connected net.Conn
	for _, host := range []string{copyProxy.Addr().String(), primaryProxy.Addr().String()} {
		conn, err := net.DialTimeout("tcp", host, time.Second)
		if err != nil {
			if !refused(err) {
				t.Fatalf("the copy must refuse the connection, got %v", err)
			}
			continue
		}
		connected = conn
		break
	}
	if connected == nil {
		t.Fatal("no host took the connection")
	}
	defer connected.Close()
	if connected.RemoteAddr().String() != primaryProxy.Addr().String() {
		t.Fatalf("connected to %s, want the primary %s", connected.RemoteAddr(), primaryProxy.Addr())
	}
	echo(t, connected)
}
