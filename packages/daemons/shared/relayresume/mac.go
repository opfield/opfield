package relayresume

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"strconv"
)

// PathContext names what every MAC of a path is bound to.
type PathContext struct {
	RouteID       string
	RelayID       string // path_relay_instance_id
	KeyID         string
	Key           []byte
	SessionID     [SessionIDLen]byte
	TargetNonce   [NonceLen]byte // unknown (zero) until HELLO_ACK
	HelloMAC      [MACLen]byte   // HELLO_ACK only
	ResumeMAC     [MACLen]byte   // RESUME_ACK only
	transcriptBuf [256]byte
}

func appendStr(dst []byte, value string) []byte {
	dst = binary.BigEndian.AppendUint16(dst, uint16(len(value)))
	return append(dst, value...)
}

func (c *PathContext) prefix(dst []byte, label string) []byte {
	dst = appendStr(dst, transcriptDomain)
	dst = appendStr(dst, label)
	dst = appendStr(dst, c.RouteID)
	dst = appendStr(dst, c.RelayID)
	dst = appendStr(dst, c.KeyID)
	return append(dst, c.SessionID[:]...)
}

// HelloTranscript is the MAC input of a HELLO.
func (c *PathContext) HelloTranscript(wnd uint64) []byte {
	dst := c.prefix(c.transcriptBuf[:0], "hello")
	return binary.BigEndian.AppendUint64(dst, wnd)
}

// HelloAckTranscript is the MAC input of a HELLO_ACK.
func (c *PathContext) HelloAckTranscript(nonce [NonceLen]byte, wnd uint64) []byte {
	dst := c.prefix(c.transcriptBuf[:0], "hello_ack")
	dst = append(dst, c.HelloMAC[:]...)
	dst = append(dst, nonce[:]...)
	return binary.BigEndian.AppendUint64(dst, wnd)
}

// ResumeTranscript is the MAC input of a RESUME.
func (c *PathContext) ResumeTranscript(epoch, rcvNxt uint64) []byte {
	dst := c.prefix(c.transcriptBuf[:0], "resume")
	dst = append(dst, c.TargetNonce[:]...)
	dst = binary.BigEndian.AppendUint64(dst, epoch)
	return binary.BigEndian.AppendUint64(dst, rcvNxt)
}

// ResumeAckTranscript is the MAC input of a RESUME_ACK.
func (c *PathContext) ResumeAckTranscript(epoch, rcvNxt, sendFrom uint64) []byte {
	dst := c.prefix(c.transcriptBuf[:0], "resume_ack")
	dst = append(dst, c.TargetNonce[:]...)
	dst = binary.BigEndian.AppendUint64(dst, epoch)
	dst = binary.BigEndian.AppendUint64(dst, rcvNxt)
	dst = binary.BigEndian.AppendUint64(dst, sendFrom)
	return append(dst, c.ResumeMAC[:]...)
}

// ComputeMAC is HMAC-SHA256(key, transcript) truncated to MACLen bytes.
func ComputeMAC(key, transcript []byte) [MACLen]byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(transcript)
	var sum [sha256.Size]byte
	var out [MACLen]byte
	copy(out[:], mac.Sum(sum[:0]))
	return out
}

// VerifyMAC compares in constant time.
func VerifyMAC(key, transcript []byte, got [MACLen]byte) bool {
	want := ComputeMAC(key, transcript)
	return hmac.Equal(want[:], got[:])
}

// DeriveRouteKey is Opfield's route key derivation (the daemons only receive
// keys); it is here for the shared test vectors.
func DeriveRouteKey(secret []byte, routeID string, keyVersion uint64) ([]byte, error) {
	info := appendStr([]byte(transcriptDomain), routeID)
	info = binary.BigEndian.AppendUint64(info, keyVersion)
	return hkdf.Key(sha256.New, secret, nil, string(info), KeyLen)
}

// RouteKeyID is the key id of a route key version.
func RouteKeyID(keyVersion uint64) string {
	return "v" + strconv.FormatUint(keyVersion, 10)
}

// VerifyHello checks a HELLO received through relayID for routeID.
func VerifyHello(record *Record, routeID, relayID string, key []byte) bool {
	if record.Type != TypeHello || len(key) == 0 {
		return false
	}
	ctx := PathContext{RouteID: routeID, RelayID: relayID, KeyID: record.KeyID, Key: key, SessionID: record.SessionID}
	return VerifyMAC(key, ctx.HelloTranscript(record.Wnd), record.MAC)
}
