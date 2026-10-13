package main

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

func startEchoServer(t *testing.T) (string, uint16) {
	t.Helper()
	host := nonLoopbackHost(t)
	listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				line, _ := bufio.NewReader(connection).ReadString('\n')
				_, _ = fmt.Fprint(connection, strings.ToUpper(line))
			}()
		}
	}()
	address := listener.Addr().(*net.TCPAddr)
	return host, uint16(address.Port)
}

func nonLoopbackHost(t *testing.T) string {
	t.Helper()
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err == nil && ip.To4() != nil && !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsMulticast() {
			return ip.String()
		}
	}
	t.Skip("no non-loopback IPv4 address available")
	return ""
}

func TestBindingManagerSyncAndProxy(t *testing.T) {
	targetHost, targetPort := startEchoServer(t)
	manager := newBindingManager(16, 8)
	t.Cleanup(manager.close)
	listenHost := nonLoopbackHost(t)
	bindingID := "11111111-1111-4111-8111-111111111111"
	statuses, err := manager.sync([]securelink.BindingConfig{{
		ID: bindingID, Generation: 1, ListenHost: listenHost, TargetHost: targetHost, TargetPort: targetPort,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 1 || statuses[0].Port == 0 {
		t.Fatalf("unexpected statuses: %#v", statuses)
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort(listenHost, fmt.Sprintf("%d", statuses[0].Port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, _ = fmt.Fprint(connection, "hello\n")
	line, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if line != "HELLO\n" {
		t.Fatalf("unexpected response %q", line)
	}
}

func TestBindingManagerServesMultipleBindingsFromOneConnector(t *testing.T) {
	targetHostA, targetPortA := startEchoServer(t)
	targetHostB, targetPortB := startEchoServer(t)
	manager := newBindingManager(16, 8)
	t.Cleanup(manager.close)
	listenHost := nonLoopbackHost(t)
	statuses, err := manager.sync([]securelink.BindingConfig{
		{ID: "33333333-3333-4333-8333-333333333333", Generation: 1, ListenHost: listenHost, TargetHost: targetHostA, TargetPort: targetPortA},
		{ID: "44444444-4444-4444-8444-444444444444", Generation: 1, ListenHost: listenHost, TargetHost: targetHostB, TargetPort: targetPortB},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 2 || statuses[0].Port == 0 || statuses[1].Port == 0 || statuses[0].Port == statuses[1].Port {
		t.Fatalf("unexpected multi-binding statuses: %#v", statuses)
	}
	for index, status := range statuses {
		connection, err := net.DialTimeout("tcp", net.JoinHostPort(listenHost, fmt.Sprintf("%d", status.Port)), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		message := fmt.Sprintf("binding-%d\n", index)
		_, _ = fmt.Fprint(connection, message)
		line, err := bufio.NewReader(connection).ReadString('\n')
		_ = connection.Close()
		if err != nil {
			t.Fatal(err)
		}
		if line != strings.ToUpper(message) {
			t.Fatalf("binding %d response = %q", index, line)
		}
	}
}

func TestBindingManagerReleasesClosedTargetWithoutWaitingForSource(t *testing.T) {
	host := nonLoopbackHost(t)
	targetListener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { targetListener.Close() })
	targetPort := uint16(targetListener.Addr().(*net.TCPAddr).Port)
	accepted := make(chan *net.TCPConn, 1)
	go func() {
		connection, acceptErr := targetListener.Accept()
		if acceptErr != nil {
			return
		}
		accepted <- connection.(*net.TCPConn)
	}()

	manager := newBindingManager(16, 8)
	t.Cleanup(manager.close)
	bindingID := "77777777-7777-4777-8777-777777777777"
	statuses, err := manager.sync([]securelink.BindingConfig{{
		ID: bindingID, Generation: 1, ListenHost: host, TargetHost: host, TargetPort: targetPort,
	}})
	if err != nil {
		t.Fatal(err)
	}
	source, err := net.DialTimeout(
		"tcp",
		net.JoinHostPort(host, fmt.Sprintf("%d", statuses[0].Port)),
		time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { source.Close() })

	var target *net.TCPConn
	select {
	case target = <-accepted:
	case <-time.After(time.Second):
		t.Fatal("connector did not open the target connection")
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		binding := manager.bindings[bindingID]
		binding.activeMu.Lock()
		active := len(binding.active)
		binding.activeMu.Unlock()
		if active == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	binding := manager.bindings[bindingID]
	binding.activeMu.Lock()
	active := len(binding.active)
	binding.activeMu.Unlock()
	t.Fatalf("broken target retained %d connector connections", active)
}

func TestBindingManagerRejectsArbitraryTargetsAndStaleUpdates(t *testing.T) {
	manager := newBindingManager(16, 8)
	t.Cleanup(manager.close)
	host := nonLoopbackHost(t)
	bindingID := "22222222-2222-4222-8222-222222222222"
	if _, err := manager.sync([]securelink.BindingConfig{{ID: bindingID, Generation: 1, ListenHost: "0.0.0.0", TargetHost: "127.0.0.1", TargetPort: 80}}); err == nil {
		t.Fatal("expected unsafe binding to be rejected")
	}
	_, err := manager.sync([]securelink.BindingConfig{{ID: bindingID, Generation: 2, ListenHost: host, TargetHost: host, TargetPort: 8080}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.sync([]securelink.BindingConfig{{ID: bindingID, Generation: 1, ListenHost: host, TargetHost: host, TargetPort: 8081}}); err == nil {
		t.Fatal("expected stale generation to be rejected")
	}
}

func TestBindingManagerRejectedUpdateLeavesTheWholePreviousSetIntact(t *testing.T) {
	manager := newBindingManager(16, 8)
	t.Cleanup(manager.close)
	host := nonLoopbackHost(t)
	firstID := "55555555-5555-4555-8555-555555555555"
	secondID := "66666666-6666-4666-8666-666666666666"
	initial := []securelink.BindingConfig{
		{ID: firstID, Generation: 2, ListenHost: host, TargetHost: host, TargetPort: 8080},
		{ID: secondID, Generation: 2, ListenHost: host, TargetHost: host, TargetPort: 8081},
	}
	before, err := manager.sync(initial)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.sync([]securelink.BindingConfig{{
		ID: firstID, Generation: 1, ListenHost: host, TargetHost: host, TargetPort: 8082,
	}}); err == nil {
		t.Fatal("expected stale update to fail")
	}
	after, err := manager.sync(initial)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 2 || before[0].Port != after[0].Port || before[1].Port != after[1].Port {
		t.Fatalf("rejected update mutated listeners: before=%#v after=%#v", before, after)
	}
}
