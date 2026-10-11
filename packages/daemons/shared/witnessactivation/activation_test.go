package witnessactivation

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func validRequest(now time.Time) Request {
	return Request{Version: 1, WitnessID: "11111111-1111-4111-8111-111111111111", SetID: "22222222-2222-4222-8222-222222222222",
		LeasePolicyID: "33333333-3333-4333-8333-333333333333", HolderNodeID: "node-a", IssuedAtUnixMs: now.UnixMilli(),
		Signature: []byte{1, 2, 3}}
}

func TestRequestValidateAndRoundTrip(t *testing.T) {
	now := time.Now()
	request := validRequest(now)
	if err := request.Validate(now); err != nil {
		t.Fatal(err)
	}
	stale := request
	stale.IssuedAtUnixMs = now.Add(-MaxSkew - time.Second).UnixMilli()
	if err := stale.Validate(now); err == nil {
		t.Fatal("a stale request was accepted")
	}
	bad := request
	bad.SetID = "not-a-uuid"
	if err := bad.Validate(now); err == nil {
		t.Fatal("a request with a bad set id was accepted")
	}
	unsigned := request
	unsigned.Signature = nil
	if err := unsigned.Validate(now); err == nil {
		t.Fatal("an unsigned request was accepted")
	}
	var buffer bytes.Buffer
	if err := Write(&buffer, request); err != nil {
		t.Fatal(err)
	}
	var decoded Request
	if err := Read(&buffer, &decoded); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded.Payload(), request.Payload()) || !bytes.Equal(decoded.Signature, request.Signature) {
		t.Fatalf("round trip changed the request: %+v", decoded)
	}
	// The payload binds every field.
	other := request
	other.HolderNodeID = "node-b"
	if bytes.Equal(other.Payload(), request.Payload()) {
		t.Fatal("the payload does not cover the holder")
	}
	if err := Read(strings.NewReader(strings.Repeat("x", maxLine+10)), &decoded); err == nil {
		t.Fatal("an oversized line was accepted")
	}
}
