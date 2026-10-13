//go:build linux

package daemon

import (
	"context"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/handover/handovertest"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// handoverPlugin is a daemon process of the fixture's node: relay lanes to
// both test relays and the link's binding.
func handoverPlugin(t *testing.T) *NginxPlugin {
	t.Helper()
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	plugin := &NginxPlugin{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), relayGrants: store, handover: handover.NewRegistry(),
		baseCfg: &lifecycle.BaseConfig{StateDir: t.TempDir()}}
	plugin.relayStreams = newRelayStreamManager(plugin)
	plugin.secureLinks = newSourceLinkManager(plugin.openProxySecureLink, "nginx", func() (int, error) { return 0, nil })
	plugin.secureLinks.bindings[testSecureLinkID] = &sourceLinkBinding{active: map[net.Conn]bool{}, done: make(chan struct{})}
	if _, err := plugin.SyncRelayGrants(resumeBundle(1, nil, true)); err != nil {
		t.Fatal(err)
	}
	return plugin
}

func startHandoverLanes(t *testing.T, plugin *NginxPlugin, near, far string) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go plugin.RunRelayTargetTunnels(ctx, dialTestLane(t, near), "", "relay-near")
	go plugin.RunRelayTargetTunnels(ctx, dialTestLane(t, far), "", "relay-far")
	waitForRelayLanes(t, plugin, 2)
	return cancel
}

// An update of the nginx daemon keeps a Secure Link connection: its stream
// goes to the next process, which resumes it with the target, and nginx's
// connection carries on without a second backend.
func TestLiveHandoverKeepsSecureLinkConnection(t *testing.T) {
	keeper := handovertest.NewKeeper()
	previousKeeper, previousExit := handoverKeeper, exitingForUpdate
	handoverKeeper, exitingForUpdate = keeper, func() bool { return true }
	t.Cleanup(func() { handoverKeeper, exitingForUpdate = previousKeeper, previousExit })

	target := newResumeTarget()
	_, near := startResumeRelay(t, "relay-near", target)
	_, far := startResumeRelay(t, "relay-far", target)
	old := handoverPlugin(t)
	stopOld := startHandoverLanes(t, old, near, far)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	daemonSide, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	go old.openProxySecureLink(testSecureLinkID, daemonSide)
	_ = client.SetDeadline(time.Now().Add(20 * time.Second))
	connection := &linkConnection{t: t, client: client, done: make(chan struct{})}
	connection.roundTrip(64 * 1024)
	session := onlySession(t, old)
	waitFor(t, "the stream to open", func() bool { return session.State() == relayresume.StateOpen })

	result := old.handOverConnections()
	if !result.Committed || result.HandedOver != 1 || len(result.Cut) > 0 {
		t.Fatalf("handover: %+v", result)
	}
	stopOld()
	if err := keeper.Restart(); err != nil {
		t.Fatal(err)
	}
	next := handoverPlugin(t)
	next.restoreHandover()
	if keeper.Kept() != 0 {
		t.Fatalf("the keeper still holds %d descriptors", keeper.Kept())
	}
	startHandoverLanes(t, next, near, far)
	connection.roundTrip(256 * 1024)
	resumed := onlySession(t, next)
	if pause, ok, _ := resumed.HandoverPause(); !ok || pause <= 0 {
		t.Fatalf("pause %s resumed %v", pause, ok)
	}
	if target.backends.Load() != 1 {
		t.Fatalf("backends %d", target.backends.Load())
	}
	next.secureLinks.bindings[testSecureLinkID].activeMu.Lock()
	active := len(next.secureLinks.bindings[testSecureLinkID].active)
	next.secureLinks.bindings[testSecureLinkID].activeMu.Unlock()
	if active != 1 {
		t.Fatalf("the binding carries %d connections", active)
	}
	if status := next.updateConnections(); status.GetKept() != 1 {
		t.Fatalf("update connections %+v", status)
	}
}
