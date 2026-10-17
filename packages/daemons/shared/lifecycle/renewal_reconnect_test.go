package lifecycle

import "testing"

func TestRequestControlReconnectDefersTunnelSwitch(t *testing.T) {
	d := &DaemonBase{
		tunnelIdentityChanged: make(chan struct{}, 1),
		controlReconnect:      make(chan struct{}, 1),
	}

	d.requestControlReconnect()
	d.requestControlReconnect() // coalesces, never blocks

	select {
	case <-d.controlReconnect:
	default:
		t.Fatal("renewal must ask the control session to reconnect")
	}
	select {
	case <-d.tunnelIdentityChanged:
		t.Fatal("the tunnel must wait until Opfield accepted the renewed certificate")
	default:
	}
	if !d.tunnelIdentityPending.Load() {
		t.Fatal("the tunnel switch must stay pending until the control session is ready")
	}
}
