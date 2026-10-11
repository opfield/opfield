package lifecycle

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/state"
	"google.golang.org/grpc/connectivity"
)

const nextAddressTestConfig = `# Opfield node configuration
gateway:
  address: old.example:9443 # current Opfield
  cert_sha256: abc123
tls:
  ca_cert: /var/lib/node/ca.pem
  client_cert: /var/lib/node/node.pem
  client_key: /var/lib/node/node-key.pem
state_dir: /var/lib/node
protected:
  enabled: true
worker:
  service_port: 7443
  advertised_addresses:
    - 10.0.0.1
`

func writeNextAddressTestConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	return path
}

func readYAMLMap(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := yaml.Unmarshal(data, &out); err != nil {
		t.Fatalf("config no longer parses: %v\n%s", err, data)
	}
	return out
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// testMove is a gatewayMove on a fake clock whose probe answers with probeErr.
type testMove struct {
	*gatewayMove
	clock    time.Time
	mu       sync.Mutex
	probed   []string
	probeErr error
	applied  []string
}

func newTestMove(t *testing.T, path, current, next string) *testMove {
	t.Helper()
	tm := &testMove{clock: time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)}
	tm.gatewayMove = newGatewayMove(path, current, next,
		func() time.Time { return tm.clock },
		discardLogger(),
		func(_ context.Context, address string) error {
			tm.mu.Lock()
			defer tm.mu.Unlock()
			tm.probed = append(tm.probed, address)
			return tm.probeErr
		},
		func(address string) { tm.applied = append(tm.applied, address) },
	)
	return tm
}

func (tm *testMove) advance(d time.Duration) { tm.clock = tm.clock.Add(d) }

func (tm *testMove) probes() int {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return len(tm.probed)
}

func TestNormalizeGatewayAddress(t *testing.T) {
	valid := map[string]string{
		"gw.example.com:9443":   "gw.example.com:9443",
		"GW.Example.com:1":      "gw.example.com:1",
		"localhost:65535":       "localhost:65535",
		"10.0.0.1:443":          "10.0.0.1:443",
		"[2001:db8::1]:9443":    "[2001:db8::1]:9443",
		"[2001:DB8:0::1]:9443":  "[2001:db8::1]:9443",
		"node-1.internal:7443":  "node-1.internal:7443",
		"xn--bcher-kva.ch:9443": "xn--bcher-kva.ch:9443",
	}
	for input, want := range valid {
		got, err := normalizeGatewayAddress(input)
		if err != nil || got != want {
			t.Errorf("normalizeGatewayAddress(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	invalid := []string{
		"", "gw.example.com", "https://gw.example.com:443", "gw.example.com:443/path", "grpc://10.0.0.1:443",
		"gw.example.com:0", "gw.example.com:65536", "gw.example.com:+443", "gw.example.com:0443", "gw.example.com:port",
		":443", "2001:db8::1:443", "[gw.example.com]:443", "[10.0.0.1]:443", "[fe80::1%eth0]:443",
		"1.2.3:443", "256.1.1.1:443", "-gw.example.com:443", "gw-.example.com:443", "gw..example.com:443",
		"gw_1.example.com:443", "gw example.com:443", "gw.example.com:443 ", "user@gw.example.com:443",
		strings.Repeat("a", 64) + ".example:443",
	}
	for _, input := range invalid {
		if got, err := normalizeGatewayAddress(input); err == nil {
			t.Errorf("normalizeGatewayAddress(%q) = %q, want an error", input, got)
		}
	}
}

func TestSetNextAddressPersistsAndKeepsEveryOtherKey(t *testing.T) {
	path := writeNextAddressTestConfig(t, nextAddressTestConfig)
	before := readYAMLMap(t, path)
	tm := newTestMove(t, path, "old.example:9443", "")

	stored, err := tm.set(" New.Example:9443 ")
	if err != nil || stored != "new.example:9443" {
		t.Fatalf("set = %q, %v", stored, err)
	}
	after := readYAMLMap(t, path)
	gateway := after["gateway"].(map[string]any)
	if gateway["next_address"] != "new.example:9443" {
		t.Fatalf("next_address not saved: %v", gateway)
	}
	delete(gateway, "next_address")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("other keys changed:\nbefore %v\nafter  %v", before, after)
	}
	data, _ := os.ReadFile(path)
	for _, comment := range []string{"# Opfield node configuration", "# current Opfield"} {
		if !strings.Contains(string(data), comment) {
			t.Errorf("comment %q lost:\n%s", comment, data)
		}
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("file mode changed: %v %v", info.Mode(), err)
	}
	if loaded, err := LoadBaseConfig(path); err != nil || loaded.Gateway.NextAddress != "new.example:9443" || loaded.Gateway.Address != "old.example:9443" {
		t.Fatalf("LoadBaseConfig = %+v, %v", loaded, err)
	}
}

func TestSetNextAddressRejectsInvalidInputWithoutChanges(t *testing.T) {
	path := writeNextAddressTestConfig(t, nextAddressTestConfig)
	tm := newTestMove(t, path, "old.example:9443", "")
	if _, err := tm.set("new.example:9443"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	if _, err := tm.set("https://other.example/path"); err == nil {
		t.Fatal("an invalid address was accepted")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) || tm.next != "new.example:9443" {
		t.Fatalf("an invalid address changed the state: next %q\n%s", tm.next, after)
	}
}

func TestSetNextAddressEmptyOrCurrentClearsIt(t *testing.T) {
	for _, clear := range []string{"", "OLD.example:9443"} {
		path := writeNextAddressTestConfig(t, nextAddressTestConfig)
		tm := newTestMove(t, path, "old.example:9443", "")
		if _, err := tm.set("new.example:9443"); err != nil {
			t.Fatal(err)
		}
		stored, err := tm.set(clear)
		if err != nil || stored != "" || tm.next != "" {
			t.Fatalf("set(%q) = %q, %v; next %q", clear, stored, err, tm.next)
		}
		gateway := readYAMLMap(t, path)["gateway"].(map[string]any)
		if _, ok := gateway["next_address"]; ok || gateway["address"] != "old.example:9443" {
			t.Fatalf("set(%q) left %v", clear, gateway)
		}
		// Nothing to switch to once cleared.
		tm.advance(time.Hour)
		if tm.tick(context.Background()) || tm.probes() != 0 {
			t.Fatalf("set(%q): a cleared next address was probed", clear)
		}
	}
}

func TestNextAddressIsLoadedOnStart(t *testing.T) {
	path := writeNextAddressTestConfig(t, strings.Replace(nextAddressTestConfig, "  cert_sha256: abc123\n", "  cert_sha256: abc123\n  next_address: new.example:9443\n", 1))
	cfg, err := LoadBaseConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	tm := newTestMove(t, path, cfg.Gateway.Address, cfg.Gateway.NextAddress)
	if tm.next != "new.example:9443" {
		t.Fatalf("next address not loaded: %q", tm.next)
	}
	for _, ignored := range []string{"https://broken/", "old.example:9443"} {
		if tm := newTestMove(t, path, "old.example:9443", ignored); tm.next != "" {
			t.Fatalf("next address %q from the config file was taken", ignored)
		}
	}
}

func TestNextAddressIsTriedOnlyAfterTenMinutesWithoutASession(t *testing.T) {
	path := writeNextAddressTestConfig(t, nextAddressTestConfig)
	tm := newTestMove(t, path, "old.example:9443", "new.example:9443")
	tm.probeErr = errors.New("unreachable")
	ctx := context.Background()

	// Never connected since the start: counted from the start.
	tm.advance(nextAddressAfter - time.Second)
	if tm.tick(ctx) || tm.probes() != 0 {
		t.Fatal("probed before ten minutes")
	}
	tm.advance(time.Second)
	if tm.tick(ctx) || tm.probes() != 1 {
		t.Fatalf("not probed after ten minutes: %d probes", tm.probes())
	}
	// Once a minute while it does not answer.
	tm.advance(30 * time.Second)
	tm.tick(ctx)
	if tm.probes() != 1 {
		t.Fatal("probed again within a minute")
	}
	tm.advance(30 * time.Second)
	tm.tick(ctx)
	if tm.probes() != 2 {
		t.Fatal("not probed again after a minute")
	}

	// A working session (the old host restarted or updated) stops the attempts,
	// and the ten minutes count again from its end.
	tm.sessionStarted()
	tm.advance(time.Hour)
	tm.tick(ctx)
	if tm.probes() != 2 {
		t.Fatal("probed while the control session works")
	}
	tm.sessionEnded()
	tm.advance(9 * time.Minute)
	tm.tick(ctx)
	if tm.probes() != 2 {
		t.Fatal("probed within ten minutes of the last session")
	}
	tm.advance(time.Minute)
	tm.tick(ctx)
	if tm.probes() != 3 || len(tm.applied) != 0 {
		t.Fatalf("probes %d, applied %v", tm.probes(), tm.applied)
	}
	gateway := readYAMLMap(t, path)["gateway"].(map[string]any)
	if gateway["address"] != "old.example:9443" {
		t.Fatalf("a failed probe changed the address: %v", gateway)
	}
}

func TestNextAddressPromotionPersistsAndSwitches(t *testing.T) {
	path := writeNextAddressTestConfig(t, nextAddressTestConfig)
	tm := newTestMove(t, path, "old.example:9443", "")
	if _, err := tm.set("new.example:9443"); err != nil {
		t.Fatal(err)
	}
	before := readYAMLMap(t, path)
	tm.advance(nextAddressAfter)
	if !tm.tick(context.Background()) {
		t.Fatal("did not switch to an answering next address")
	}
	if !slices.Equal(tm.probed, []string{"new.example:9443"}) || !slices.Equal(tm.applied, []string{"new.example:9443"}) {
		t.Fatalf("probed %v, applied %v", tm.probed, tm.applied)
	}
	after := readYAMLMap(t, path)
	gateway := after["gateway"].(map[string]any)
	if gateway["address"] != "new.example:9443" {
		t.Fatalf("address not saved: %v", gateway)
	}
	if _, ok := gateway["next_address"]; ok {
		t.Fatalf("next_address kept after the switch: %v", gateway)
	}
	before["gateway"].(map[string]any)["address"] = "new.example:9443"
	delete(before["gateway"].(map[string]any), "next_address")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("other keys changed:\nbefore %v\nafter  %v", before, after)
	}
	if tm.current != "new.example:9443" || tm.next != "" {
		t.Fatalf("state after the switch: current %q next %q", tm.current, tm.next)
	}
	// Nothing more to do.
	tm.advance(time.Hour)
	if tm.tick(context.Background()) || len(tm.probed) != 1 {
		t.Fatal("kept probing after the switch")
	}
}

func TestNextAddressNotPromotedWhenClearedOrConnectedDuringTheProbe(t *testing.T) {
	path := writeNextAddressTestConfig(t, nextAddressTestConfig)
	tm := newTestMove(t, path, "old.example:9443", "new.example:9443")
	tm.advance(nextAddressAfter)
	tm.probe = func(context.Context, string) error {
		tm.sessionStarted()
		return nil
	}
	if tm.tick(context.Background()) || len(tm.applied) != 0 {
		t.Fatal("switched although the current address answered meanwhile")
	}
	tm.sessionEnded()
	tm.advance(nextAddressAfter)
	tm.probe = func(context.Context, string) error {
		_, _ = tm.set("")
		return nil
	}
	if tm.tick(context.Background()) || len(tm.applied) != 0 {
		t.Fatal("switched to a next address cleared meanwhile")
	}
}

// The switch reaches the running daemon: the connector dials the new address
// from its next attempt, ControlAddress reports it, and the listeners run.
func TestSwitchControlAddressUpdatesConnectorAndListeners(t *testing.T) {
	t.Cleanup(func() {
		activeControlAddress.Store(nil)
		controlAddressListenersMu.Lock()
		controlAddressListeners = nil
		controlAddressListenersMu.Unlock()
	})
	if got := ControlAddress("fallback:1"); got != "fallback:1" {
		t.Fatalf("ControlAddress before start = %q", got)
	}
	d := &DaemonBase{connector: connector.NewConnector("old.example:9443", nil, discardLogger())}
	setActiveControlAddress(d.connector.Address())
	changed := d.connector.AddressChanged()
	heard := make(chan string, 1)
	OnControlAddressChanged(func(address string) { heard <- address })

	d.switchControlAddress("new.example:9443")
	if d.connector.Address() != "new.example:9443" || ControlAddress("fallback:1") != "new.example:9443" {
		t.Fatalf("connector %q, ControlAddress %q", d.connector.Address(), ControlAddress("fallback:1"))
	}
	select {
	case <-changed:
	default:
		t.Fatal("AddressChanged not signalled")
	}
	select {
	case address := <-heard:
		if address != "new.example:9443" {
			t.Fatalf("listener got %q", address)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listener not called")
	}
}

func TestSetGatewayNextAddressCommandResult(t *testing.T) {
	path := writeNextAddressTestConfig(t, nextAddressTestConfig)
	d := &DaemonBase{logger: discardLogger(), move: newTestMove(t, path, "old.example:9443", "").gatewayMove}
	command := func(address string) *pb.GatewayCommand {
		return &pb.GatewayCommand{CommandId: "c1", Payload: &pb.GatewayCommand_SetGatewayNextAddress{
			SetGatewayNextAddress: &pb.SetGatewayNextAddressCommand{Address: address},
		}}
	}
	if result := d.handleSetGatewayNextAddress(command("new.example:9443")); !result.Success || result.CommandId != "c1" {
		t.Fatalf("valid address: %+v", result)
	}
	if result := d.handleSetGatewayNextAddress(command("new.example")); result.Success || !strings.Contains(result.Error, "host:port") {
		t.Fatalf("invalid address: %+v", result)
	}
	if result := d.handleSetGatewayNextAddress(command("")); !result.Success || d.move.next != "" {
		t.Fatalf("clear: %+v, next %q", result, d.move.next)
	}
	if result := (&DaemonBase{}).handleSetGatewayNextAddress(command("new.example:9443")); result.Success {
		t.Fatal("a daemon without its lifecycle started accepted the command")
	}
}

func TestRegistrationAdvertisesGatewayNextAddress(t *testing.T) {
	d := &DaemonBase{plugin: &protectedTestPlugin{}, cfg: &BaseConfig{}, state: &state.State{NodeID: "node-1"}}
	if !slices.Contains(d.buildRegistration().Capabilities, GatewayNextAddressCapability) {
		t.Fatal("registration lacks " + GatewayNextAddressCapability)
	}
}

// The probe is a control connection with the node's identity and the usual
// server verification: an Opfield whose certificate names the next address
// passes, one presenting a certificate for another name does not.
func TestConnectorProbeVerifiesTheServerName(t *testing.T) {
	pki := newRelayTestPKI(t)
	good := newTestRelay(t, pki, "localhost")
	wrong := newTestRelay(t, pki, "other.example")
	c := connector.NewConnector("old.example:9443", pki.clients, discardLogger())
	ctx := context.Background()
	if err := c.Probe(ctx, "localhost:"+portOf(good.path.listener.Addr().String()), 5*time.Second); err != nil {
		t.Fatalf("probe of the right Opfield failed: %v", err)
	}
	if err := c.Probe(ctx, "localhost:"+portOf(wrong.path.listener.Addr().String()), time.Second); err == nil {
		t.Fatal("probe accepted a certificate for another name")
	}
}

// Lanes to the relay at the Gateway address that are down when Opfield moved
// are rebuilt for the new address.
func TestRelayPoolLocalLanesFollowTheControlAddress(t *testing.T) {
	pki := newRelayTestPKI(t)
	oldRelay := newTestRelay(t, pki, "localhost")
	newRelay := newTestRelay(t, pki, "localhost")
	c := connector.NewConnector("localhost:"+portOf(oldRelay.path.listener.Addr().String()), pki.clients, discardLogger())
	plugin := newTestRelayPoolPlugin()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runProcessRelayPool(ctx, c, plugin, "node-test", nil, discardLogger())
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	first := plugin.waitForLane(t, "local", 1)

	// The old host goes away for good.
	_ = oldRelay.path.listener.Close()
	oldRelay.path.drop()
	waitForLaneState(t, first, func(state connectivity.State) bool { return state != connectivity.Ready })

	c.SetAddress("localhost:" + portOf(newRelay.path.listener.Addr().String()))
	plugin.waitForLane(t, "local", 2)
	newRelay.path.mu.Lock()
	accepted := newRelay.path.accepted
	newRelay.path.mu.Unlock()
	if accepted == 0 {
		t.Fatal("the rebuilt lane did not dial the new address")
	}
}

func portOf(address string) string {
	return address[strings.LastIndex(address, ":")+1:]
}

// A config file that could not be written is written again when Opfield
// repeats the command, instead of the repeat reporting success unsaved.
func TestSetNextAddressRetriesAnUnsavedConfigFile(t *testing.T) {
	path := writeNextAddressTestConfig(t, nextAddressTestConfig)
	tm := newTestMove(t, path, "old.example:9443", "")
	tm.cfgPath = filepath.Join(t.TempDir(), "missing", "config.yaml")
	if _, err := tm.set("new.example:9443"); err == nil {
		t.Fatal("an unwritable config file reported success")
	}
	if tm.next != "new.example:9443" {
		t.Fatalf("the next address is not kept in memory: %q", tm.next)
	}
	tm.cfgPath = path
	if _, err := tm.set("new.example:9443"); err != nil {
		t.Fatal(err)
	}
	if gateway := readYAMLMap(t, path)["gateway"].(map[string]any); gateway["next_address"] != "new.example:9443" {
		t.Fatalf("the repeat did not save it: %v", gateway)
	}
}
