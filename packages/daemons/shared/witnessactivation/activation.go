// Package witnessactivation is the request a ClickHouse availability set's
// lease holder sends to a relay's staged standby Keeper witness to activate
// it while Opfield is down (decision 8 of the availability plan). The holder
// reaches the standby's relay-local endpoint over its witness route; the
// relay supervisor listens there while the witness is staged, has the relay
// worker verify the holder statement (availabilitylease
// VerifyHolderStatement) and starts the Keeper on that port.
package witnessactivation

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"time"
)

// Domain is the holder statement domain of an activation.
const Domain = "gateway-availability-holder/activate-witness/v1"

// MaxSkew bounds the clock difference between holder and relay.
const MaxSkew = 5 * time.Minute

const maxLine = 16 << 10

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Request activates one standby witness.
type Request struct {
	Version        int    `json:"v"`
	WitnessID      string `json:"witnessId"`
	SetID          string `json:"setId"`
	LeasePolicyID  string `json:"leasePolicyId"`
	HolderNodeID   string `json:"holderNodeId"`
	IssuedAtUnixMs int64  `json:"issuedAtUnixMs"`
	// Signature is the holder statement over Payload (ASN.1 ECDSA).
	Signature []byte `json:"signature"`
}

// Response is the supervisor's answer.
type Response struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// Payload is the signed content: every field but the signature.
func (r Request) Payload() []byte {
	return []byte("v1\n" + r.WitnessID + "\n" + r.SetID + "\n" + r.LeasePolicyID + "\n" + r.HolderNodeID + "\n" +
		strconv.FormatInt(r.IssuedAtUnixMs, 10))
}

// Validate checks the fields and the issue time against now.
func (r Request) Validate(now time.Time) error {
	if r.Version != 1 {
		return fmt.Errorf("unsupported activation version %d", r.Version)
	}
	if !uuidPattern.MatchString(r.WitnessID) || !uuidPattern.MatchString(r.SetID) || !uuidPattern.MatchString(r.LeasePolicyID) {
		return errors.New("activation ids must be UUIDs")
	}
	if r.HolderNodeID == "" || len(r.HolderNodeID) > 128 {
		return errors.New("activation holder is invalid")
	}
	if len(r.Signature) == 0 || len(r.Signature) > 256 {
		return errors.New("activation signature is missing")
	}
	issued := time.UnixMilli(r.IssuedAtUnixMs)
	if skew := now.Sub(issued); skew > MaxSkew || skew < -MaxSkew {
		return errors.New("activation request is outside the allowed clock skew")
	}
	return nil
}

// Write sends one message as a JSON line.
func Write(w io.Writer, message any) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(data) >= maxLine {
		return errors.New("activation message is too large")
	}
	_, err = w.Write(append(data, '\n'))
	return err
}

// Read receives one JSON line into message.
func Read(r io.Reader, message any) error {
	reader := bufio.NewReaderSize(io.LimitReader(r, maxLine), 4096)
	line, err := reader.ReadBytes('\n')
	if err != nil && (len(line) == 0 || !errors.Is(err, io.EOF)) {
		return err
	}
	return json.Unmarshal(line, message)
}
