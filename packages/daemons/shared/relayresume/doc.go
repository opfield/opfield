// Package relayresume implements resumable relay streams (RSv1): a session
// layer carried inside relay TunnelData payloads between the two endpoint
// daemons, so a stream moves to another relay (or to the same relay after a
// restart) without the local sockets noticing. Relays are unchanged: they see
// ordinary Data frames.
//
// # Wire format (frozen, version 1)
//
// One TunnelData payload holds one or more records. A DATA record, when
// present, is the last record of its frame: its payload runs to the end of the
// frame and is never empty. Every other record is self-delimiting. A frame is
// never empty and never exceeds min(path max frame, 1 MiB). uvarint is
// unsigned LEB128 (encoding/binary), at most 10 bytes, minimal (a multi-byte
// encoding never ends in 0x00) and at most 2^64-1.
//
//	0x01 DATA        ack:uvarint payload...
//	0x02 ACK         ack:uvarint wnd:uvarint
//	0x03 FIN         ack:uvarint                 (consumes one offset unit)
//	0x04 RST         code:u8 reason_len:u8 reason[reason_len]
//	0x05 CLOSE
//	0x10 HELLO       "GWRS" ver:u8=1 key_id_len:u8 key_id session_id[16] wnd:uvarint mac[16]
//	0x11 HELLO_ACK   session_id[16] target_nonce[16] wnd:uvarint mac[16]
//	0x12 RESUME      "GWRS" ver:u8=1 session_id[16] epoch:uvarint rcv_nxt:uvarint key_id_len:u8 key_id mac[16]
//	0x13 RESUME_ACK  session_id[16] epoch:uvarint rcv_nxt:uvarint send_from:uvarint mac[16]
//	0x14 RESUME_REJ  session_id[16] code:u8
//	0x15 MIGRATE_REQ reason:u8
//
// key_id is 1..64 bytes. Unknown record types, trailing bytes after a record
// that is not DATA, an empty DATA payload and a non-minimal uvarint are
// protocol errors.
//
// Offsets: each direction is one byte stream with 64-bit offsets. A DATA
// record's offset is implicit: the path's base offset plus the bytes (and FIN
// unit) this side sent on the path before it. The base is 0 on the first path;
// on a resumed path it is RESUME_ACK.rcv_nxt for source -> target and
// RESUME_ACK.send_from (= RESUME.rcv_nxt) for target -> source. ack is the
// sender's rcv_nxt: every byte below it was handed to the local socket. wnd is
// the record sender's current send window; the peer acknowledges at least once
// every wnd/4 delivered bytes and within the delayed-ack time.
//
// Window extension: a session that takes windows up to MaxExtendedWindow
// announces every wnd with the lowest bit set (wnd | 1; windows are multiples
// of 1 KiB, and sessions before the extension announce no odd value). A
// sender keeps at most MaxWindow beyond what the peer delivered unless the
// peer's last HELLO, HELLO_ACK or ACK since the stream last resumed was odd;
// after a resume it waits for the peer's next ACK to learn it again.
//
// Lane migration: a session that takes MIGRATE_REQ reason 3 (a new path on
// the same relay) also sets the second lowest bit (wnd | 2). A target sends
// reason 3 only to a source whose last window since the stream last resumed
// carried it; sessions before it move a stream off the relay on any
// MIGRATE_REQ.
//
// # MACs
//
// mac = HMAC-SHA256(key, transcript)[:16]. Transcript fields are
// concatenated; a string is u16be(len) followed by its bytes, an integer is
// u64be, fixed-size byte arrays are written as is.
//
//	HELLO:      str("gw-relay-resume/v1") str("hello") str(route_id) str(path_relay_instance_id)
//	            str(key_id) session_id u64(wnd)
//	HELLO_ACK:  str("gw-relay-resume/v1") str("hello_ack") str(route_id) str(path_relay_instance_id)
//	            str(key_id) session_id hello_mac target_nonce u64(wnd)
//	RESUME:     str("gw-relay-resume/v1") str("resume") str(route_id) str(path_relay_instance_id)
//	            str(key_id) session_id target_nonce u64(epoch) u64(rcv_nxt)
//	RESUME_ACK: str("gw-relay-resume/v1") str("resume_ack") str(route_id) str(path_relay_instance_id)
//	            str(key_id) session_id target_nonce u64(epoch) u64(rcv_nxt) u64(send_from) resume_mac
//
// HELLO_ACK and RESUME_ACK use the key the HELLO or RESUME named.
// path_relay_instance_id is the relay instance id of the candidate the path
// runs through ("local" for a pre-pool relay). Route keys are derived by
// Opfield only: key = HKDF-SHA256(ikm = Opfield resume secret, salt = empty,
// info = "gw-relay-resume/v1" || u16be(len(route_id)) || route_id ||
// u64be(key_version), 32 bytes), key_id = "v" + decimal(key_version).
//
// The test vectors in proto/testdata/relay-resume-v1.json are normative and
// shared with the TypeScript port.
package relayresume
