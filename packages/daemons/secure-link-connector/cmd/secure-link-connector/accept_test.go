package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

// failingOnceListener fails its first Accept like a process out of file descriptors.
type failingOnceListener struct {
	net.Listener
	failed atomic.Bool
}

func (l *failingOnceListener) Accept() (net.Conn, error) {
	if l.failed.CompareAndSwap(false, true) {
		return nil, errors.New("accept: too many open files")
	}
	return l.Listener.Accept()
}

// A transient accept error must not end an ingress binding's accept loop (B-22).
func TestBindingListenerAcceptsAfterATransientError(t *testing.T) {
	targetHost, targetPort := startEchoServer(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	binding := &bindingListener{
		config:   securelink.BindingConfig{TargetHost: targetHost, TargetPort: targetPort},
		listener: &failingOnceListener{Listener: listener},
		active:   map[net.Conn]struct{}{},
		done:     make(chan struct{}),
		carrier:  newSessionSet(),
	}
	t.Cleanup(binding.close)
	go binding.accept(nil)

	connection, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := fmt.Fprint(connection, "ping\n"); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil || line != "PING\n" {
		t.Fatalf("no answer through the binding after a transient accept error: %q, %v", line, err)
	}
}
