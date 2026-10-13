package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/securelink"
	"golang.org/x/sys/unix"
)

// A connector replaced by another (a new connector image, a drain) hands the sessions it carries to its replacement
// instead of finishing them itself (connector live handover). Both run in the anchor's network namespace with the
// control directory mounted at the same place, as the same user. The daemon tells the replaced connector the
// replacement's control socket (a Handover request); the replaced connector stops accepting, stops every session at
// a safe point (shared/handover: each byte is in a socket or in the pending bytes the snapshot carries), and sends the
// sockets (SCM_RIGHTS) and the snapshot (a sealed memory file) over the replacement's takeover socket. The
// replacement confirms it holds them all, the replaced connector commits, and from then on only the replacement
// carries those sessions: their sockets never close, so for the workloads and the daemon the replacement is a pause.
// Nothing is carried twice: until the commit the replaced connector carries on, and the replacement only takes what a
// commit gave it.
//
// What cannot move stays with the replaced connector, which finishes it as a drained connector does: a session whose
// TLS it originates (managed storage with TLS), one still being set up, one that did not stop in time.

const (
	// handoverDaemonType names the connector's snapshots (handover.Snapshot.DaemonType).
	handoverDaemonType = "secure-link-connector"
	// takeoverSuffix turns a control socket's name into its connector's takeover socket's.
	takeoverSuffix = "-takeover.sock"
	// handoverStartingWait bounds the wait for sessions being set up before a handover.
	handoverStartingWait = 2 * time.Second
	// handoverTransferWait bounds a handover's exchange with the replacement.
	handoverTransferWait = 20 * time.Second
	// handoverReturnWait bounds the wait for the handed over sessions to let go of this process's copies.
	handoverReturnWait = 5 * time.Second
	// takeoverFilesPerMessage stays below the kernel's limit of descriptors in one message (253).
	takeoverFilesPerMessage = 200
	takeoverMessageBytes    = 64 * 1024
)

var controlSocketNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.sock$`)

// takeoverSocketPath is the takeover socket of the connector whose control socket is controlSocket.
func takeoverSocketPath(controlSocket string) string {
	return strings.TrimSuffix(controlSocket, ".sock") + takeoverSuffix
}

// takeoverMessage is one message on a takeover socket (SOCK_SEQPACKET: one JSON object per message, with the
// descriptors it names attached).
type takeoverMessage struct {
	// Files names the descriptors attached, in order (handover keeper names).
	Files []string `json:"files,omitempty"`
	// Snapshot: the descriptor attached is the handover snapshot; the replacement answers Ready.
	Snapshot bool `json:"snapshot,omitempty"`
	// Ready (replacement): it holds Took descriptors.
	Ready bool `json:"ready,omitempty"`
	Took  int  `json:"took,omitempty"`
	// Commit (replaced): the replacement carries the sessions from now on.
	Commit bool `json:"commit,omitempty"`
	// Done (replacement): Restored sessions carry on, Lost did not come over.
	Done     bool   `json:"done,omitempty"`
	Restored int    `json:"restored,omitempty"`
	Lost     int    `json:"lost,omitempty"`
	Error    string `json:"error,omitempty"`
}

func sendTakeover(connection *net.UnixConn, message takeoverMessage, files []*os.File) error {
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	var rights []byte
	if len(files) > 0 {
		descriptors := make([]int, len(files))
		for i, file := range files {
			descriptors[i] = int(file.Fd())
		}
		rights = unix.UnixRights(descriptors...)
	}
	n, oobn, err := connection.WriteMsgUnix(payload, rights, nil)
	if err == nil && (n != len(payload) || oobn != len(rights)) {
		err = errors.New("takeover message sent in part")
	}
	return err
}

// receiveTakeover reads one message and the descriptors attached (owned by the caller).
func receiveTakeover(connection *net.UnixConn) (takeoverMessage, []*os.File, error) {
	var message takeoverMessage
	buffer := make([]byte, takeoverMessageBytes)
	oob := make([]byte, unix.CmsgSpace(4*takeoverFilesPerMessage))
	n, oobn, flags, _, err := connection.ReadMsgUnix(buffer, oob)
	if err != nil {
		return message, nil, err
	}
	var files []*os.File
	if oobn > 0 {
		controls, err := unix.ParseSocketControlMessage(oob[:oobn])
		if err != nil {
			return message, nil, err
		}
		for _, control := range controls {
			descriptors, err := unix.ParseUnixRights(&control)
			if err != nil {
				continue
			}
			for _, descriptor := range descriptors {
				files = append(files, os.NewFile(uintptr(descriptor), "takeover"))
			}
		}
	}
	closeAll := func() {
		for _, file := range files {
			_ = file.Close()
		}
	}
	if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 {
		closeAll()
		return message, nil, errors.New("takeover message truncated")
	}
	if n == 0 {
		closeAll()
		return message, nil, errors.New("takeover socket closed")
	}
	if err := json.Unmarshal(buffer[:n], &message); err != nil {
		closeAll()
		return message, nil, fmt.Errorf("decode takeover message: %w", err)
	}
	return message, files, nil
}

// handoverSender is the handover's keeper in the replaced connector: it holds a copy of each socket the handover
// keeps and, when the handover keeps its snapshot (the commit point), sends them all to the replacement and commits
// once the replacement holds them. Keep of the snapshot fails, and nothing is committed, unless the commit was sent.
type handoverSender struct {
	connection *net.UnixConn
	mu         sync.Mutex
	files      map[string]*os.File
	order      []string
}

func (s *handoverSender) HandsOver() bool              { return true }
func (s *handoverSender) Unbounded() bool              { return true }
func (s *handoverSender) Take(string) (*os.File, bool) { return nil, false }
func (s *handoverSender) Inherited(string) []string    { return nil }
func (s *handoverSender) Flush(time.Duration) error    { return nil }
func (s *handoverSender) EnvBytes([]string) int        { return 0 }
func (s *handoverSender) Keep(name string, file *os.File) error {
	if name == handover.KeptSnapshotName {
		return s.transfer(file)
	}
	copied, err := duplicateFile(file)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if previous := s.files[name]; previous != nil {
		_ = previous.Close()
	} else {
		s.order = append(s.order, name)
	}
	s.files[name] = copied
	return nil
}

// Drop closes this connector's copy: the replacement holds its own once it was sent.
func (s *handoverSender) Drop(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if file := s.files[name]; file != nil {
		_ = file.Close()
		delete(s.files, name)
	}
	return nil
}

// release closes every copy left.
func (s *handoverSender) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for name, file := range s.files {
		_ = file.Close()
		delete(s.files, name)
	}
}

func (s *handoverSender) transfer(snapshot *os.File) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := make([]string, 0, len(s.order))
	for _, name := range s.order {
		if s.files[name] != nil {
			names = append(names, name)
		}
	}
	for start := 0; start < len(names); start += takeoverFilesPerMessage {
		batch := names[start:min(start+takeoverFilesPerMessage, len(names))]
		files := make([]*os.File, len(batch))
		for i, name := range batch {
			files[i] = s.files[name]
		}
		if err := sendTakeover(s.connection, takeoverMessage{Files: batch}, files); err != nil {
			return fmt.Errorf("send the sessions to the replacement: %w", err)
		}
	}
	if err := sendTakeover(s.connection, takeoverMessage{Snapshot: true, Files: []string{handover.KeptSnapshotName}}, []*os.File{snapshot}); err != nil {
		return fmt.Errorf("send the handover snapshot to the replacement: %w", err)
	}
	answer, files, err := receiveTakeover(s.connection)
	for _, file := range files {
		_ = file.Close()
	}
	if err != nil {
		return fmt.Errorf("the replacement did not confirm the sessions: %w", err)
	}
	if !answer.Ready || answer.Took != len(names)+1 {
		return fmt.Errorf("the replacement holds %d of %d descriptors: %s", answer.Took, len(names)+1, answer.Error)
	}
	if err := sendTakeover(s.connection, takeoverMessage{Commit: true}, nil); err != nil {
		return fmt.Errorf("commit the handover: %w", err)
	}
	return nil
}

func duplicateFile(file *os.File) (*os.File, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return nil, err
	}
	duplicated := -1
	var dupErr error
	if err := raw.Control(func(fd uintptr) { duplicated, dupErr = unix.FcntlInt(fd, unix.F_DUPFD_CLOEXEC, 0) }); err != nil {
		return nil, err
	}
	if dupErr != nil {
		return nil, dupErr
	}
	return os.NewFile(uintptr(duplicated), file.Name()), nil
}

// handOver drains the connector and hands its sessions to the connector whose control socket is named to, in the
// connector's own control directory. The answer counts what it handed over and what it still carries.
func handOver(request *securelink.HandoverRequest, manager *bindingManager, egress *egressManager) securelink.SyncResponse {
	response := securelink.SyncResponse{Version: securelink.ProtocolVersionHandover}
	if request == nil || !controlSocketNamePattern.MatchString(request.To) {
		response.Error = "invalid secure-link handover request"
		return response
	}
	sets := []*sessionSet{manager.sessions}
	if egress.sessions != manager.sessions {
		sets = append(sets, egress.sessions)
	}
	for _, set := range sets {
		set.handing.Lock()
		defer set.handing.Unlock()
	}
	manager.drain()
	egress.drain()
	// Sessions being set up get a moment to start (a target being dialed, a stream being opened): then they go too.
	deadline := time.Now().Add(handoverStartingWait)
	for time.Now().Before(deadline) && startingSessions(sets) > 0 {
		time.Sleep(10 * time.Millisecond)
	}
	result := &securelink.HandoverResult{Left: map[string]int{}}
	response.Handover = result
	directory := filepath.Dir(egress.socketPath)
	err := handOverTo(filepath.Join(directory, request.To), sets, result)
	if err != nil {
		result.Error = err.Error()
	}
	if starting := startingSessions(sets); starting > 0 {
		result.Left[securelink.HandoverLeftStarting] += int(starting)
	}
	response.Active = manager.active() + egress.active()
	if len(result.Left) == 0 && response.Active > 0 {
		result.Left[securelink.HandoverLeftFailed] = response.Active
	}
	log.Printf("handed %d sessions over to the replacement connector; still carrying %d (left %v, error %q)",
		result.HandedOver, response.Active, result.Left, result.Error)
	return response
}

func startingSessions(sets []*sessionSet) int64 {
	starting := int64(0)
	for _, set := range sets {
		starting += set.starting.Load()
	}
	return starting
}

// handOverTo hands the sessions of sets to the connector whose control socket is target, one set per connection.
func handOverTo(target string, sets []*sessionSet, result *securelink.HandoverResult) error {
	for _, set := range sets {
		if err := handOverSet(target, set, result); err != nil {
			return err
		}
	}
	return nil
}

func handOverSet(target string, set *sessionSet, result *securelink.HandoverResult) error {
	dialer := net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialer.DialContext(context.Background(), "unixpacket", takeoverSocketPath(target))
	if err != nil {
		return fmt.Errorf("the replacement does not take sessions: %w", err)
	}
	connection := conn.(*net.UnixConn)
	defer connection.Close()
	if err := samePeerUser(connection); err != nil {
		return err
	}
	_ = connection.SetDeadline(time.Now().Add(handoverTransferWait))
	sender := &handoverSender{connection: connection, files: map[string]*os.File{}}
	handed := set.registry.HandOver(handover.Options{
		DaemonType: handoverDaemonType, Keeper: sender, Repeatable: true,
		Logger: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
	})
	sender.release()
	for class, n := range handed.Cut {
		result.Left[leftClass(class)] += n
	}
	if !handed.Committed {
		// Nothing handed over: everything carries on here (Err nil: there was nothing to hand over).
		return handed.Err
	}
	set.registry.WaitHandedOver(handoverReturnWait)
	result.HandedOver += handed.HandedOver
	result.Peers = append(result.Peers, set.takeHandedPeers()...)
	// The replacement reports what it carries on; a session it lost is cut either way.
	if answer, files, err := receiveTakeover(connection); err == nil {
		for _, file := range files {
			_ = file.Close()
		}
		if answer.Lost > 0 || answer.Error != "" {
			log.Printf("the replacement connector lost %d of the sessions handed over: %s", answer.Lost, answer.Error)
		}
	}
	return nil
}

// leftClass is why a session stayed, in the daemon's words.
func leftClass(class string) string {
	switch class {
	case handover.CutNoSocket:
		return securelink.HandoverLeftTLS
	case handover.CutBusy:
		return securelink.HandoverLeftBusy
	default:
		return securelink.HandoverLeftFailed
	}
}

// serveTakeover takes the sessions replaced connectors hand over, on the takeover socket next to the control socket.
func serveTakeover(listener *net.UnixListener, manager *bindingManager, egress *egressManager) {
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go takeOver(connection, manager, egress)
	}
}

// takeOver takes one handover: the descriptors, the snapshot, then, on the commit, the sessions. A handover that
// never commits leaves nothing here: the replaced connector still carries its sessions.
func takeOver(connection *net.UnixConn, manager *bindingManager, egress *egressManager) {
	defer connection.Close()
	if err := samePeerUser(connection); err != nil {
		log.Printf("refused a session handover: %v", err)
		return
	}
	manager.mu.Lock()
	closed := manager.closed
	manager.mu.Unlock()
	if closed {
		// Draining itself: the replaced connector keeps its sessions.
		return
	}
	_ = connection.SetDeadline(time.Now().Add(handoverTransferWait))
	keeper := &takeoverKeeper{files: map[string]*os.File{}}
	defer keeper.discard()
	for {
		message, files, err := receiveTakeover(connection)
		if err != nil {
			return
		}
		if message.Commit {
			// Only a snapshot already received commits.
			return
		}
		if len(files) != len(message.Files) {
			for _, file := range files {
				_ = file.Close()
			}
			_ = sendTakeover(connection, takeoverMessage{Ready: false, Error: "descriptors and names differ"}, nil)
			return
		}
		for i, name := range message.Files {
			keeper.put(name, files[i])
		}
		if !message.Snapshot {
			continue
		}
		if err := sendTakeover(connection, takeoverMessage{Ready: true, Took: keeper.count()}, nil); err != nil {
			return
		}
		commit, files, err := receiveTakeover(connection)
		for _, file := range files {
			_ = file.Close()
		}
		if err != nil || !commit.Commit {
			return
		}
		restored, err := handover.RestoreFrom(keeper, handoverDaemonType, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
		done := takeoverMessage{Done: true}
		if err != nil {
			done.Error = err.Error()
			log.Printf("could not take the sessions a replaced connector handed over: %v", err)
		}
		if restored != nil {
			for _, pipe := range restored.Pipes {
				switch pipe.Labels[sessionLabelKind] {
				case sessionKindEgress:
					egress.adopt(pipe)
				default:
					manager.adopt(pipe)
				}
			}
			done.Restored, done.Lost = len(restored.Pipes), restored.Lost
			log.Printf("took over %d sessions from a replaced connector (lost %d)", done.Restored, done.Lost)
		}
		_ = sendTakeover(connection, done, nil)
		return
	}
}

// takeoverKeeper holds what a replaced connector sent until the handover commits (handover.Keeper for
// handover.RestoreFrom): Take hands a descriptor over, and discard closes the ones nobody took, without ending their
// connections (the replaced connector still carries them when nothing committed).
type takeoverKeeper struct {
	mu    sync.Mutex
	files map[string]*os.File
}

func (k *takeoverKeeper) put(name string, file *os.File) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if previous := k.files[name]; previous != nil {
		_ = previous.Close()
	}
	k.files[name] = file
}

func (k *takeoverKeeper) count() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.files)
}

func (k *takeoverKeeper) discard() {
	k.mu.Lock()
	defer k.mu.Unlock()
	for name, file := range k.files {
		_ = file.Close()
		delete(k.files, name)
	}
}

func (k *takeoverKeeper) HandsOver() bool { return false }
func (k *takeoverKeeper) Keep(string, *os.File) error {
	return errors.New("the takeover keeper keeps nothing")
}
func (k *takeoverKeeper) Drop(string) error         { return nil }
func (k *takeoverKeeper) Flush(time.Duration) error { return nil }
func (k *takeoverKeeper) EnvBytes([]string) int     { return 0 }
func (k *takeoverKeeper) Take(name string) (*os.File, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	file, ok := k.files[name]
	delete(k.files, name)
	return file, ok
}
func (k *takeoverKeeper) Inherited(prefix string) []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	var names []string
	for name := range k.files {
		if strings.HasPrefix(name, prefix) {
			names = append(names, name)
		}
	}
	return names
}

// listenTakeover listens on the takeover socket of the connector whose control socket is controlSocket, with the
// control socket's mode: only the connectors of this node (the same user) reach it.
func listenTakeover(controlSocket string) (*net.UnixListener, error) {
	path := takeoverSocketPath(controlSocket)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale takeover socket: %w", err)
	}
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: path, Net: "unixpacket"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o660); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}
