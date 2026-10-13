package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

// A replaced connector whose control socket the daemon cannot reach is told to drain by a signal: it stops accepting
// on its egress listeners and keeps the sessions it carries.
func TestDrainSignalStopsAccepting(t *testing.T) {
	socket, _ := fakeEgressDaemon(t)
	egress := newEgressManager(socket)
	t.Cleanup(egress.close)
	config := egressTestConfig(t, egressTestLinkID)
	if _, err := egress.sync([]securelink.EgressConfig{config}); err != nil {
		t.Fatal(err)
	}
	address := net.JoinHostPort(config.ListenHost, fmt.Sprint(config.ListenPort))
	session, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	reader := bufio.NewReader(session)
	_ = session.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = fmt.Fprint(session, "a\n")
	if line, err := reader.ReadString('\n'); err != nil || line != "A\n" {
		t.Fatalf("the session was not served: %q, %v", line, err)
	}
	signals := make(chan os.Signal, 1)
	drained := make(chan int, 1)
	go drainOnSignal(context.Background(), signals, func() { drained <- egress.drain() })
	signals <- drainSignal
	select {
	case <-drained:
	case <-time.After(2 * time.Second):
		t.Fatal("the drain signal was not handled")
	}
	if _, err := net.DialTimeout("tcp", address, 200*time.Millisecond); err == nil {
		t.Fatal("the connector still accepts after the drain signal")
	}
	_ = session.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = fmt.Fprint(session, "x\n")
	if line, err := reader.ReadString('\n'); err != nil || line != "X\n" {
		t.Fatalf("the session was cut by the drain: %q, %v", line, err)
	}
}
