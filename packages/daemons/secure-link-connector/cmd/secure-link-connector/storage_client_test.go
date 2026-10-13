package main

import (
	"context"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

// A storage connection the daemon refuses (the link's relay sessions are all in use) is logged with the daemon's
// reason, once per interval, instead of closing without a trace.
func TestStorageConnectorLogsTheRelayRefusal(t *testing.T) {
	socketPath := filepath.Join(sockettest.Dir(t), "relay.sock")
	daemon, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer daemon.Close()
	const refusal = "storage link session capacity reached: relay route session capacity reached"
	go func() {
		for {
			connection, err := daemon.Accept()
			if err != nil {
				return
			}
			var request securelink.RelayRequest
			if securelink.ReadJSON(connection, &request) == nil {
				_ = securelink.WriteJSON(connection, securelink.RelayResponse{Version: securelink.RelayProtocolVersion, Error: refusal})
			}
			_ = connection.Close()
		}
	}()

	now := time.Unix(1_000, 0)
	var mu sync.Mutex
	var lines []string
	previous := storageRelayFailures
	storageRelayFailures = &storageRelayFailureLog{now: func() time.Time { return now }, logf: func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, fmt.Sprintf(format, args...))
	}}
	defer func() { storageRelayFailures = previous }()

	config := storageConnectorConfig{BindingID: "5b0c3b52-5d0f-4c1c-9a59-3f8f0f4c2a11", SocketPath: socketPath, Listen: storageConnectorListenAddress}
	connect := func() {
		local, application := net.Pipe()
		defer application.Close()
		proxyStorageConnectorConnection(context.Background(), local, config, nil)
	}
	for range 3 {
		connect()
	}
	now = now.Add(storageRelayFailureLogInterval)
	connect()

	mu.Lock()
	defer mu.Unlock()
	if len(lines) != 2 || !strings.HasSuffix(lines[0], refusal) || !strings.Contains(lines[1], refusal+" (2 more since the last line)") {
		t.Fatalf("relay refusals logged as %q", lines)
	}
}
