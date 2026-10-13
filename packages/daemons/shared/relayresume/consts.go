package relayresume

import "time"

// Capability is advertised by daemons whose streams can be resumable.
const Capability = "relay_stream_resume_v1"

// Protocol constants (frozen for version 1).
const (
	Version      = 1
	Magic        = "GWRS"
	MACLen       = 16
	SessionIDLen = 16
	NonceLen     = 16
	KeyLen       = 32
	MaxKeyIDLen  = 64
	MaxReasonLen = 255
	// MaxFrameBytes caps every frame a session writes, whatever the path allows.
	MaxFrameBytes = 1024 * 1024
	// MinPathFrameBytes is the smallest path frame a session runs on: a full
	// handshake record must fit.
	MinPathFrameBytes = 256
	// MaxRecordHeader is the largest DATA header: type plus a 10-byte uvarint.
	MaxRecordHeader = 1 + 10

	transcriptDomain = "gw-relay-resume/v1"
)

// Record types.
const (
	TypeData       byte = 0x01
	TypeAck        byte = 0x02
	TypeFin        byte = 0x03
	TypeRst        byte = 0x04
	TypeClose      byte = 0x05
	TypeHello      byte = 0x10
	TypeHelloAck   byte = 0x11
	TypeResume     byte = 0x12
	TypeResumeAck  byte = 0x13
	TypeResumeRej  byte = 0x14
	TypeMigrateReq byte = 0x15
)

// RESUME_REJ codes.
const (
	RejectUnknown      byte = 1
	RejectFinished     byte = 2
	RejectReset        byte = 3
	RejectUnauthorized byte = 4
	RejectStaleEpoch   byte = 5
)

// RST codes. A receiver treats an unknown code like RstProtocol.
const (
	RstProtocol        byte = 1 // malformed or out-of-order record
	RstLocal           byte = 2 // the local socket failed (not EOF)
	RstSuspendTimeout  byte = 3 // no path came back in time
	RstIdle            byte = 4 // the local idle deadline passed
	RstHalfCloseIdle   byte = 5 // proxy half-close reaping
	RstRevoked         byte = 6 // the route or endpoint is no longer assigned
	RstAborted         byte = 7 // the local side gave up (shutdown, cancel)
	RstResumeRejected  byte = 8 // the peer refused a resume
	RstLegacyPeer      byte = 9 // the peer is not resume-aware
	RstWindowViolation byte = 10
)

// MIGRATE_REQ reasons.
const (
	MigrateDrain  byte = 1 // the target's relay candidate is draining
	MigrateGoAway byte = 2 // the target's lane to the relay got GOAWAY
	// MigrateLane: the target replaced the connection its path runs on (its
	// congestion state went stale): the source opens a new path on the same
	// relay, which the target accepts on the new connection. Sources that
	// predate it move off the relay where they can, so a target sends it only
	// to a source that announces LaneMigration.
	MigrateLane byte = 3
)

// TransferGap is the pause without data after which a stream's next bytes
// start a new transfer (Session.CheapToMove): a bulk transfer moves data
// every round trip, and requests through one keepalive connection are
// apart by at least the client's turn.
const TransferGap = 250 * time.Millisecond

// Flow control.
const (
	// InitialWindow: a stream starts here (fewer ACK records on bulk
	// transfers), or at FallbackWindow, then MinWindow, when the process
	// budget is short.
	InitialWindow  = 1024 * 1024
	FallbackWindow = 256 * 1024
	MinWindow      = 64 * 1024
	// MaxWindow is the largest window towards a peer that does not announce
	// the window extension (every release before it): such a peer resets a
	// stream that queues more than 2*(MaxWindow+MaxFrameBytes) for its socket.
	MaxWindow = 4 * 1024 * 1024
	// MaxExtendedWindow is the largest window towards a peer that announces
	// the window extension: a stream through a far relay needs a window of
	// its whole round trip (both relay legs), and 4 MiB held a 600 ms round
	// trip at 7 MB/s, below a plain TCP connection through the same relay
	// host.
	MaxExtendedWindow = 32 * 1024 * 1024
	// WindowExtension is the bit a session sets in every window it announces
	// (HELLO, HELLO_ACK, ACK) to say it takes windows up to
	// MaxExtendedWindow. Windows are otherwise multiples of 1 KiB, and a
	// session before the extension announces only those.
	WindowExtension = 1
	// LaneMigration is the bit a session sets in every window it announces
	// to say it takes MIGRATE_REQ MigrateLane (a new path on the same relay).
	// Sessions before it announce windows without it.
	LaneMigration = 2
	// DefaultProcessBudget bounds the unacked bytes all sessions of a process
	// may hold beyond their floor windows.
	DefaultProcessBudget = 256 * 1024 * 1024
	DelayedAck           = 20 * time.Millisecond
)

// Timeouts.
const (
	FirstRecordTimeout     = time.Second      // target: no first frame -> legacy
	OpenTimeout            = 5 * time.Second  // per candidate, OpenTunnel until Ready
	ResumeAckTimeout       = 5 * time.Second  // RESUME -> RESUME_ACK
	HelloAckTimeout        = 10 * time.Second // first path: HELLO -> HELLO_ACK
	PlannedBudget          = 30 * time.Second // per planned migration, then stay
	UnplannedBudget        = 55 * time.Second // source: find a new path
	UnplannedBackoffMin    = 250 * time.Millisecond
	UnplannedBackoffMax    = 2 * time.Second
	TargetSuspendTimeout   = 60 * time.Second
	TombstoneTTL           = 120 * time.Second
	LegacyLatch            = 10 * time.Minute
	ProxyHalfCloseTimeout  = 30 * time.Second
	CloseLingerTimeout     = 10 * time.Second // finishing: wait for the peer's CLOSE
	DrainDeadlineMargin    = 15 * time.Second // Opfield: drain start + grace - margin
	MaxMigrationsInFlight  = 32
	DefaultDrainSpreadTime = 60 * time.Second // drain moves spread over at most this
)
