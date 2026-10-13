package listenerkeep

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Store is the launcher's keeper: it holds a copy of every listener the
// running daemon kept, hands them all to the next daemon process it starts,
// and mirrors them into systemd's file descriptor store when the unit has one,
// so they also outlive a restart of the launcher itself.
type Store struct {
	mu     sync.Mutex
	files  map[string]*os.File
	notify *notifySocket
	logger *slog.Logger

	channel   *net.UnixConn // the launcher's end
	childEnd  *os.File      // handed to every daemon process
	syncEnd   *net.UnixConn // writes into the channel behind a daemon's messages
	syncSeq   uint64
	syncWait  map[uint64]chan struct{}
	closeOnce sync.Once
	done      chan struct{}

	// frozen stops the receive loop before the launcher execs in place
	// (PrepareExec); receiving is closed when the loop returned.
	frozen    bool
	receiving chan struct{}
}

// OpenStore creates the launcher's keeper. It adopts the listeners systemd
// passed this process, which must be the unit's main process.
func OpenStore(logger *slog.Logger) (*Store, error) {
	if logger == nil {
		logger = slog.Default()
	}
	syscall.ForkLock.RLock()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_DGRAM, 0)
	if err == nil {
		syscall.CloseOnExec(fds[0])
		syscall.CloseOnExec(fds[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, err
	}
	launcherFile := os.NewFile(uintptr(fds[0]), "listener-keep-launcher")
	childEnd := os.NewFile(uintptr(fds[1]), "listener-keep-daemon")
	connection, err := net.FileConn(launcherFile)
	_ = launcherFile.Close()
	if err != nil {
		_ = childEnd.Close()
		return nil, err
	}
	syncConnection, err := net.FileConn(childEnd)
	if err != nil {
		_ = connection.Close()
		_ = childEnd.Close()
		return nil, err
	}
	store := &Store{
		files:    takeSystemdListeners(),
		notify:   dialNotifySocket(),
		logger:   logger,
		channel:  connection.(*net.UnixConn),
		childEnd: childEnd,
		syncEnd:  syncConnection.(*net.UnixConn),
		syncWait: map[uint64]chan struct{}{},
		done:     make(chan struct{}),
	}
	if store.files == nil {
		store.files = map[string]*os.File{}
	}
	store.startReceiving()
	return store, nil
}

func (s *Store) startReceiving() {
	s.receiving = make(chan struct{})
	go s.receive(s.receiving)
}

// Close stops the keeper. The kept descriptors stay open until the process
// exits, which is when systemd's copies take over.
func (s *Store) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		_ = s.channel.Close()
		_ = s.syncEnd.Close()
		_ = s.childEnd.Close()
		if s.notify != nil {
			s.notify.close()
		}
	})
}

// Settle waits until every message a daemon process sent before it exited is
// applied, so the next process receives the listeners it kept last.
func (s *Store) Settle(timeout time.Duration) {
	s.mu.Lock()
	s.syncSeq++
	seq := s.syncSeq
	wait := make(chan struct{})
	s.syncWait[seq] = wait
	s.mu.Unlock()
	if err := sendMessage(s.syncEnd, messageSync+"\n"+strconv.FormatUint(seq, 10), nil); err != nil {
		s.mu.Lock()
		delete(s.syncWait, seq)
		s.mu.Unlock()
		return
	}
	select {
	case <-wait:
	case <-time.After(timeout):
	case <-s.done:
	}
}

// ChildFiles returns the descriptors to hand a daemon process as extra files
// starting at firstFD, the environment that describes them to it, and a
// release function to call once the process started: the kept listeners are
// passed as copies, so a message applied meanwhile cannot close one under it.
func (s *Store) ChildFiles(firstFD int) ([]*os.File, []string, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := make([]string, 0, len(s.files))
	for name := range s.files {
		names = append(names, name)
	}
	sort.Strings(names)
	files := []*os.File{s.childEnd}
	copies := make([]*os.File, 0, len(names))
	kept := make([]keptDescriptor, 0, len(names))
	for _, name := range names {
		duplicate, err := duplicate(s.files[name])
		if err != nil {
			s.logger.Warn("listener keeper could not pass a kept listener on", "name", name, "error", err)
			continue
		}
		copies = append(copies, duplicate)
		files = append(files, duplicate)
		kept = append(kept, keptDescriptor{Name: name, FD: firstFD + len(files) - 1})
	}
	encoded, _ := json.Marshal(kept)
	return files, []string{
			ChannelFDEnv + "=" + strconv.Itoa(firstFD),
			KeptEnv + "=" + string(encoded),
			// legacy-name: GATEWAY_DAEMON_* read by a pre-Opfield daemon the launcher rolls back to — remove once every node reports none
			legacyChannelFDEnv + "=" + strconv.Itoa(firstFD),
			legacyKeptEnv + "=" + string(encoded),
		}, func() {
			closeAll(copies)
		}
}

func duplicate(file *os.File) (*os.File, error) {
	raw, err := file.SyscallConn()
	if err != nil {
		return nil, err
	}
	duplicated := -1
	var dupErr error
	syscall.ForkLock.RLock()
	controlErr := raw.Control(func(fd uintptr) {
		duplicated, dupErr = syscall.Dup(int(fd))
		if dupErr == nil {
			syscall.CloseOnExec(duplicated)
		}
	})
	syscall.ForkLock.RUnlock()
	if controlErr != nil {
		return nil, controlErr
	}
	if dupErr != nil {
		return nil, dupErr
	}
	return os.NewFile(uintptr(duplicated), file.Name()), nil
}

// Names lists the kept listeners.
func (s *Store) Names() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	names := make([]string, 0, len(s.files))
	for name := range s.files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (s *Store) receive(receiving chan struct{}) {
	defer close(receiving)
	buffer := make([]byte, maxMessage)
	oob := make([]byte, syscall.CmsgSpace(4*4))
	for {
		n, oobn, _, _, err := s.channel.ReadMsgUnix(buffer, oob)
		if err != nil {
			select {
			case <-s.done:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.mu.Lock()
			frozen := s.frozen
			s.mu.Unlock()
			if frozen {
				// Unread messages wait in the channel for the next image.
				return
			}
			s.logger.Warn("listener keeper channel read failed", "error", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		files := receivedFiles(oob[:oobn])
		s.apply(string(buffer[:n]), files)
	}
}

func receivedFiles(oob []byte) []*os.File {
	if len(oob) == 0 {
		return nil
	}
	messages, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	var files []*os.File
	for _, message := range messages {
		fds, err := syscall.ParseUnixRights(&message)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			syscall.CloseOnExec(fd)
			files = append(files, os.NewFile(uintptr(fd), "kept-listener"))
		}
	}
	return files
}

func (s *Store) apply(message string, files []*os.File) {
	kind, argument, _ := strings.Cut(message, "\n")
	switch kind {
	case messageSync:
		closeAll(files)
		seq, _ := strconv.ParseUint(argument, 10, 64)
		s.mu.Lock()
		wait := s.syncWait[seq]
		delete(s.syncWait, seq)
		s.mu.Unlock()
		if wait != nil {
			close(wait)
		}
	case messageKeep:
		if argument == "" || strings.ContainsAny(argument, ":\n") || len(files) != 1 {
			closeAll(files)
			s.logger.Warn("listener keeper ignored an invalid keep message")
			return
		}
		s.mu.Lock()
		previous := s.files[argument]
		s.files[argument] = files[0]
		s.mu.Unlock()
		if previous != nil {
			_ = previous.Close()
		}
		s.mirror(message, files[0])
	case messageDrop:
		closeAll(files)
		s.mu.Lock()
		previous := s.files[argument]
		delete(s.files, argument)
		s.mu.Unlock()
		if previous != nil {
			_ = previous.Close()
		}
		s.mirror(message, nil)
	default:
		closeAll(files)
	}
}

// mirror stores what the keeper keeps in systemd's store as well, except a
// connection or state a daemon hands to its next process (live handover): the
// next process takes it at once, and a restart of the whole unit ends what it
// carries anyway.
func (s *Store) mirror(message string, file *os.File) {
	if _, name, _ := strings.Cut(message, "\n"); s.notify == nil || transientName(name) {
		return
	}
	if err := forwardToSystemd(s.notify, message, file); err != nil {
		s.logger.Debug("systemd file descriptor store update failed", "error", err)
	}
}

func closeAll(files []*os.File) {
	for _, file := range files {
		_ = file.Close()
	}
}
