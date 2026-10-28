//go:build linux

package loopbackpeer

import (
	"net"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestUIDIsThePeerSocketOwner(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.64.0.9:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	uid, err := UID(server)
	if err != nil || uid != os.Getuid() {
		t.Fatalf("peer uid = %d, %v; want %d", uid, err, os.Getuid())
	}
}

// A restricted listener hands out the connections of allowed users only; any other local process is cut at once and
// never reaches the server behind it.
func TestRestrictServesOnlyAllowedUsers(t *testing.T) {
	inner, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var allow atomic.Bool
	allow.Store(true)
	refusedUIDs := make(chan int, 4)
	listener := Restrict(inner, func(uid int) bool { return allow.Load() && uid == os.Getuid() },
		func(uid int, _ net.Addr) { refusedUIDs <- uid })
	defer listener.Close()
	accepted := make(chan net.Conn, 4)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			accepted <- connection
		}
	}()

	client, err := net.Dial("tcp4", inner.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	select {
	case connection := <-accepted:
		_ = connection.Close()
	case <-time.After(2 * time.Second):
		t.Fatal("the allowed user's connection was not accepted")
	}

	allow.Store(false)
	refused, err := net.Dial("tcp4", inner.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer refused.Close()
	select {
	case uid := <-refusedUIDs:
		if uid != os.Getuid() {
			t.Fatalf("refused uid = %d, want %d", uid, os.Getuid())
		}
	case <-accepted:
		t.Fatal("a refused user's connection was accepted")
	case <-time.After(2 * time.Second):
		t.Fatal("the refused connection was not reported")
	}
	_ = refused.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := refused.Read(make([]byte, 1)); err == nil {
		t.Fatal("the refused connection stays open")
	}
}

func TestUsersAllowsRootAndTheNamedUsers(t *testing.T) {
	allowed := Users(1000, 65532)
	for uid, want := range map[int]bool{0: true, 1000: true, 65532: true, 1001: false, 65534: false} {
		if allowed(uid) != want {
			t.Fatalf("Users(1000, 65532)(%d) = %v, want %v", uid, !want, want)
		}
	}
}
