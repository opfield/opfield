package availabilitylease

import (
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"strings"
	"testing"
	"time"
)

// A relay voter accepts a holder statement only from the holder its latest
// verified commit names, with that holder's manifest key and domain.
func TestVerifyHolderStatementAcceptsOnlyTheCommittedHolder(t *testing.T) {
	// Wire mode: real ECDSA identities, so signatures are checked for real.
	w := newScenario(t, scenarioSpec{relays: voterRelays(1, "r1"), daemons: daemonVoters("d1", "d2"),
		candidates: []string{"d1", "d2"}, bootstrap: "d1", stateful: true, wire: true})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	relay := w.nodes["r1"].node
	const domain = HolderStatementDomainPrefix + "test/v1"
	payload := []byte("activate witness w1")

	signature, err := SignHolderStatement(w.nodes["d1"].signer, domain, payload)
	if err != nil {
		t.Fatal(err)
	}
	holder, err := relay.VerifyHolderStatement(keyP1, domain, payload, signature)
	if err != nil || holder != "d1" {
		t.Fatalf("holder statement of the committed holder: holder=%q err=%v", holder, err)
	}
	if _, err := relay.VerifyHolderStatement(keyP1, domain, []byte("another payload"), signature); err == nil {
		t.Fatal("a statement over another payload was accepted")
	}
	other, err := SignHolderStatement(w.nodes["d2"].signer, domain, payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := relay.VerifyHolderStatement(keyP1, domain, payload, other); err == nil || !strings.Contains(err.Error(), "committed holder") {
		t.Fatalf("a statement of a non-holder candidate: err=%v", err)
	}
	if _, err := relay.VerifyHolderStatement(keyP1, legacycompat.AvailabilityLeaseDomain+"/frame/v1", payload, signature); err == nil {
		t.Fatal("a lease protocol domain was accepted")
	}
	if _, err := SignHolderStatement(w.nodes["d1"].signer, legacycompat.AvailabilityLeaseDomain+"/accept/v2", payload); err == nil {
		t.Fatal("signing under a lease protocol domain was allowed")
	}
	if _, err := relay.VerifyHolderStatement(Key{PolicyID: "unknown", Slot: 0}, domain, payload, signature); err == nil {
		t.Fatal("a statement for an unknown policy was accepted")
	}
}
