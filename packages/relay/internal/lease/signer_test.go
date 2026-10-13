package lease

import (
	"bytes"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// dualSigned reports whether the relay sent any frame with an additional
// (previous-key) signature since frames were last cleared.
func dualSigned(h *harness) bool {
	for _, frames := range h.relayFrames {
		for _, frame := range frames {
			if len(frame.GetAdditionalSignatures()) > 0 {
				return true
			}
		}
	}
	return false
}

// H3: a relay certificate renewal that changes its identity key must not cut
// the relay out of the quorum. With v2 down, d1 renews only through the
// relay's accepts: while the manifests still list the old key the relay
// dual-signs; once they list the new key it signs with the new key alone.
func TestRelayKeyRenewalKeepsItsVotesCounting(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	h.down["v2"] = true
	oldKey := h.publicKey(relayID)

	h.renewRelayKey()
	h.relayFrames = map[string][]*relayv1.CoordinationFrame{}
	h.step(availabilitylease.LeaseTerm + 10*time.Second)
	if !h.holding("d1") || !h.relay.Admit(policyID, "d1").Open {
		t.Fatal("holder lost its lease after the relay renewed its identity key")
	}
	if !h.relay.node.IdentityOverlap() || !dualSigned(h) {
		t.Fatal("relay did not dual-sign while the manifests list its previous key")
	}
	if report := h.relay.Report(); bytes.Equal(report.GetIdentityPublicKey(), oldKey) || !bytes.Equal(report.GetIdentityPublicKey(), h.publicKey(relayID)) {
		t.Fatal("report does not carry the renewed identity key for the Gateway to publish")
	}

	// Opfield republishes the manifest with the relay's new key.
	next := h.signManifest([]string{"d1", "d2"}, false)
	for id, node := range h.daemons {
		if _, err := node.AdoptManifest(next); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	h.relay.ApplyPolicy(h.snapshot())
	h.step(time.Second)
	if h.relay.node.IdentityOverlap() {
		t.Fatal("overlap did not end once every manifest listed the new key")
	}
	h.relayFrames = map[string][]*relayv1.CoordinationFrame{}
	h.step(availabilitylease.LeaseTerm + 10*time.Second)
	if dualSigned(h) || !h.holding("d1") || !h.relay.Admit(policyID, "d1").Open {
		t.Fatal("relay votes stopped counting under its renewed key")
	}
}

// After a restart inside the overlap the relay dual-signs again from the
// retained previous key; after IdentityKeyOverlap it no longer does.
func TestRelayRestartRestoresTheKeyOverlap(t *testing.T) {
	h := newHarness(t, true)
	h.renewRelayKey()
	h.restartRelay(false)
	if !h.relay.node.IdentityOverlap() {
		t.Fatal("restart inside the overlap dropped the previous key")
	}
	h.renewedAt = h.wall().Add(-availabilitylease.IdentityKeyOverlap)
	h.restartRelay(false)
	if h.relay.node.IdentityOverlap() {
		t.Fatal("restart after the overlap still signs with the previous key")
	}
}
