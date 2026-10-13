package main

import (
	"bufio"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

// A replacement connector in the anchor's network namespace binds the egress addresses the serving one listens on
// (SO_REUSEPORT). Told to drain, the previous one stops accepting and reports its open sessions, which go on; new
// connections reach the replacement. No session is cut and no address changes.
func TestReplacementTakesEgressAddress(t *testing.T) {
	socket, _ := fakeEgressDaemon(t)
	config := egressTestConfig(t, egressTestLinkID)
	previous := newEgressManager(socket)
	t.Cleanup(previous.close)
	replacement := newEgressManager(socket)
	t.Cleanup(replacement.close)
	address := net.JoinHostPort(config.ListenHost, fmt.Sprint(config.ListenPort))
	exchange := func(connection net.Conn, reader *bufio.Reader, line string) string {
		_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
		_, _ = fmt.Fprint(connection, line+"\n")
		answer, _ := reader.ReadString('\n')
		return answer
	}

	if statuses, err := previous.sync([]securelink.EgressConfig{config}); err != nil || statuses[0].State != securelink.EgressListening {
		t.Fatalf("previous connector: %+v %v", statuses, err)
	}
	session, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	sessionReader := bufio.NewReader(session)
	if answer := exchange(session, sessionReader, "one"); answer != "ONE\n" {
		t.Fatalf("session through the previous connector answered %q", answer)
	}

	if statuses, err := replacement.sync([]securelink.EgressConfig{config}); err != nil || statuses[0].State != securelink.EgressListening {
		t.Fatalf("the replacement could not bind the serving address: %+v %v", statuses, err)
	}
	if active := previous.drain(); active != 1 {
		t.Fatalf("draining connector reports %d sessions, want 1", active)
	}
	if answer := exchange(session, sessionReader, "two"); answer != "TWO\n" {
		t.Fatalf("the session through the draining connector was cut: %q", answer)
	}
	fresh, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatalf("a new connection after the drain was refused: %v", err)
	}
	defer fresh.Close()
	if answer := exchange(fresh, bufio.NewReader(fresh), "three"); answer != "THREE\n" {
		t.Fatalf("a new connection after the drain answered %q", answer)
	}
	if _, err := previous.sync([]securelink.EgressConfig{config}); err == nil {
		t.Fatal("a drained connector took a sync")
	}
}
