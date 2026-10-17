// Package listenerkeep keeps a daemon's listening sockets open while the
// daemon process restarts, so a connection made in between waits in the
// socket's backlog for the next process instead of being refused.
//
// A listener survives in a keeper that outlives the daemon process:
//
//   - the daemon launcher, which starts every daemon process of a unit in turn
//     (update handoffs, crashes). A daemon hands it a copy of each listener
//     over a datagram channel, and the launcher hands every copy it holds to
//     the next daemon process;
//   - systemd's file descriptor store (FileDescriptorStoreMax=), which outlives
//     a restart of the whole unit. The launcher, or a daemon running without
//     one as the unit's main process, stores each copy there, and systemd
//     passes them back through LISTEN_FDS on the next start.
//
// A kept listener is named by its socket path and the inode of the socket file
// (Name): a process adopts a kept listener only while the path still names
// that very socket, never one a different process re-created in between.
package listenerkeep

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// ChannelFDEnv names the descriptor of the datagram channel to the launcher.
	ChannelFDEnv = "OPFIELD_DAEMON_LISTENER_KEEP_FD"
	// KeptEnv lists the listeners the launcher handed this process: a JSON
	// array of {"name", "fd"}.
	KeptEnv = "OPFIELD_DAEMON_KEPT_LISTENERS"
	// launcherManagedEnv mirrors lifecycle.LauncherManagedEnv: a daemon started
	// by a launcher is not the unit's main process, so it must never talk to
	// systemd's notification socket itself.
	launcherManagedEnv = "OPFIELD_DAEMON_LAUNCHER_MANAGED"

	// The launcher and the daemon can be different releases: the launcher sets
	// both names, the daemon reads the Opfield one first.
	// legacy-name: legacycompat.EnvPrefixDAEMON_* listener keep environment of pre-Opfield launchers and daemons — remove once every node reports none
	legacyChannelFDEnv       = legacycompat.EnvPrefix + "DAEMON_LISTENER_KEEP_FD"
	legacyKeptEnv            = legacycompat.EnvPrefix + "DAEMON_KEPT_LISTENERS"
	legacyLauncherManagedEnv = legacycompat.EnvPrefix + "DAEMON_LAUNCHER_MANAGED"

	messageKeep = "keep"
	messageDrop = "drop"
	messageSync = "sync"

	// sendTimeout bounds a message to a launcher that stopped reading: the
	// listener is then simply not kept.
	sendTimeout = time.Second
	maxMessage  = 8192
)

// systemdNotifySocket is where systemd receives service notifications (a
// variable for tests).
var systemdNotifySocket = "/run/systemd/notify"

type keptDescriptor struct {
	Name string `json:"name"`
	FD   int    `json:"fd"`
}

// Name is the keeper name of the Unix listener bound at socketPath: the path
// and the inode of the socket file it created there.
func Name(socketPath string) (string, error) {
	info, err := os.Lstat(socketPath)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return "", fmt.Errorf("%s is not a socket", socketPath)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", errors.New("socket inode is unavailable")
	}
	return socketPath + "#" + strconv.FormatUint(uint64(stat.Ino), 10), nil
}

// NamePath is the socket path part of a keeper name.
func NamePath(name string) string {
	if index := strings.LastIndex(name, "#"); index >= 0 {
		return name[:index]
	}
	return name
}

type client struct {
	mu        sync.Mutex
	inherited map[string]*os.File
	// own names the listeners this process kept or took over.
	own  map[string]bool
	send func(message string, file *os.File) error
	// channel is the datagram channel to a launcher's keeper, which hands
	// what this process keeps to the next process (nil: no such keeper).
	channel *net.UnixConn
	// mirror stores what the launcher keeps in systemd's store as well, when
	// the launcher cannot (see newClientFromEnvironment).
	mirror *notifySocket
	// fromLauncher is set when the launcher handed this process its keeper
	// channel.
	fromLauncher bool
}

var (
	initOnce sync.Once
	global   = &client{inherited: map[string]*os.File{}}
)

// Init takes over what the launcher or systemd handed this process and marks
// every inherited descriptor close-on-exec, so no helper process started
// later inherits a listener. Call it before starting any other process; later
// calls do nothing.
func Init() {
	initOnce.Do(func() {
		fresh := newClientFromEnvironment()
		globalMu.Lock()
		global = fresh
		globalMu.Unlock()
	})
}

// ReinitForTest replaces this process's keeper client with one read from the
// environment again. Tests only.
func ReinitForTest() {
	initOnce.Do(func() {})
	fresh := newClientFromEnvironment()
	globalMu.Lock()
	global = fresh
	globalMu.Unlock()
}

var globalMu sync.Mutex

func current() *client {
	Init()
	globalMu.Lock()
	defer globalMu.Unlock()
	return global
}

// Available reports whether a listener handed to Keep survives a restart.
func Available() bool { return current().available() }

// FromLauncher reports whether this process runs under a launcher that keeps
// what it is handed (a launcher started before 2.11 has no keeper).
func FromLauncher() bool {
	keeper := current()
	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	return keeper.fromLauncher
}

// Take returns the descriptor a previous process kept under name, which the
// caller now owns, and forgets it.
func Take(name string) (*os.File, bool) { return current().take(name) }

// Inherited lists the names of the descriptors still unclaimed whose socket
// path starts with prefix.
func Inherited(prefix string) []string { return current().unclaimed(prefix) }

// Keep hands a copy of file to the keeper under name, replacing a copy kept
// under that name. The caller keeps, and eventually closes, its own file.
func Keep(name string, file *os.File) error { return current().keep(name, file) }

// Drop tells the keeper to close its copy kept under name.
func Drop(name string) error { return current().drop(name) }

// DropStale drops a copy kept under name by an earlier process that was not
// handed to this one (a launcher without a keeper hands nothing over, while
// systemd's store may still hold it). A listener this process kept stays.
func DropStale(name string) error { return current().dropStale(name) }

// ReleaseUnclaimed closes every inherited descriptor under prefix that no
// Take claimed, here and in the keeper, and returns their names.
func ReleaseUnclaimed(prefix string) []string { return current().releaseUnclaimed(prefix) }

// HandsOver reports a launcher keeper that hands what this process keeps to
// the next daemon process it starts (an update's candidate, a restart after a
// crash). A launcher without one (installed before it had a keeper, until the
// unit's next start) or systemd's store alone keep listeners across a restart
// of the whole unit only.
func HandsOver() bool {
	c := current()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.channel != nil
}

// Flush waits, at most timeout, until the launcher's keeper received every
// message this process sent: the launcher then applies them before it starts
// the next process (Store.Settle bounds that wait on its side).
func Flush(timeout time.Duration) error {
	c := current()
	c.mu.Lock()
	channel := c.channel
	c.mu.Unlock()
	if channel == nil {
		return nil
	}
	return flushChannel(channel, timeout)
}

// MaxEnvBytes bounds the variable the launcher describes the kept descriptors
// with (KeptEnv): a single environment string is at most 128 KiB
// (MAX_ARG_STRLEN), and a launcher whose variable exceeded it could not start
// the next process at all.
const MaxEnvBytes = 120 * 1024

// EnvBytes estimates the size of that variable once the keeper holds what it
// holds for this process now plus names more descriptors.
func EnvBytes(names []string) int {
	c := current()
	c.mu.Lock()
	defer c.mu.Unlock()
	size := len(KeptEnv) + 3
	entry := func(name string) { size += EnvEntryBytes(name) }
	for name := range c.own {
		entry(name)
	}
	for name := range c.inherited {
		if !c.own[name] {
			entry(name)
		}
	}
	for _, name := range names {
		entry(name)
	}
	return size
}

// EnvEntryBytes is what one more kept descriptor adds to that variable.
func EnvEntryBytes(name string) int { return len(name) + len(`{"name":"","fd":12345},`) }

// transientName reports a name that is not a listener: a connection or state
// handed to the next process (live handover). It lives in the launcher only,
// never in systemd's store on this process's behalf: the next process takes it
// at once, and a restart of the whole unit ends what it carries anyway.
func transientName(name string) bool {
	return strings.HasPrefix(name, "conn/") || strings.HasPrefix(name, "state/")
}

func (c *client) available() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.send != nil
}

func (c *client) take(name string) (*os.File, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	file, ok := c.inherited[name]
	if ok {
		delete(c.inherited, name)
		// The keeper's copy is this process's now.
		if c.own == nil {
			c.own = map[string]bool{}
		}
		c.own[name] = true
		if c.mirror != nil && !transientName(name) {
			// The previous process kept it while nothing stored it in
			// systemd's store; this process keeps it from now on.
			_ = forwardToSystemd(c.mirror, messageKeep+"\n"+name, file)
		}
	}
	return file, ok
}

func (c *client) unclaimed(prefix string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	names := make([]string, 0, len(c.inherited))
	for name := range c.inherited {
		if strings.HasPrefix(NamePath(name), prefix) {
			names = append(names, name)
		}
	}
	return names
}

func (c *client) keep(name string, file *os.File) error {
	c.mu.Lock()
	send := c.send
	c.mu.Unlock()
	if send == nil {
		return nil
	}
	if file == nil {
		return errors.New("no listener to keep")
	}
	if err := send(messageKeep+"\n"+name, file); err != nil {
		return err
	}
	c.mu.Lock()
	if c.own == nil {
		c.own = map[string]bool{}
	}
	c.own[name] = true
	c.mu.Unlock()
	return nil
}

func (c *client) dropStale(name string) error {
	c.mu.Lock()
	_, inherited := c.inherited[name]
	own := c.own[name]
	c.mu.Unlock()
	if inherited || own {
		return nil
	}
	return c.drop(name)
}

func (c *client) drop(name string) error {
	c.mu.Lock()
	send := c.send
	delete(c.own, name)
	c.mu.Unlock()
	if send == nil || name == "" {
		return nil
	}
	return send(messageDrop+"\n"+name, nil)
}

func (c *client) releaseUnclaimed(prefix string) []string {
	c.mu.Lock()
	released := make(map[string]*os.File)
	for name, file := range c.inherited {
		if strings.HasPrefix(NamePath(name), prefix) {
			released[name] = file
			delete(c.inherited, name)
		}
	}
	c.mu.Unlock()
	names := make([]string, 0, len(released))
	for name, file := range released {
		_ = c.drop(name)
		_ = file.Close()
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func newClientFromEnvironment() *client {
	current := &client{inherited: map[string]*os.File{}}
	if envEither(launcherManagedEnv, legacyLauncherManagedEnv) == "1" {
		kept := envEither(KeptEnv, legacyKeptEnv)
		channel := envEither(ChannelFDEnv, legacyChannelFDEnv)
		for _, name := range []string{KeptEnv, legacyKeptEnv, ChannelFDEnv, legacyChannelFDEnv} {
			_ = os.Unsetenv(name)
		}
		var descriptors []keptDescriptor
		if kept != "" && json.Unmarshal([]byte(kept), &descriptors) == nil {
			for _, descriptor := range descriptors {
				if descriptor.FD < 3 || descriptor.Name == "" {
					continue
				}
				syscall.CloseOnExec(descriptor.FD)
				current.inherited[descriptor.Name] = os.NewFile(uintptr(descriptor.FD), descriptor.Name)
			}
		}
		fd, err := strconv.Atoi(channel)
		if err != nil || fd < 3 {
			// A launcher without a keeper (installed before it had one; the
			// launcher refresh replaces it on the unit's next start) hands
			// nothing over and stores nothing. The listeners then go to
			// systemd's store directly, on behalf of the launcher, which is
			// the unit's main process (NotifyAccess=main): the next start of
			// the unit, the refresh's trial included, takes them over instead
			// of dropping them.
			if notify := dialNotifySocketFor(os.Getppid()); notify != nil {
				current.send = func(message string, file *os.File) error {
					return forwardToSystemd(notify, message, file)
				}
			}
			return current
		}
		syscall.CloseOnExec(fd)
		file := os.NewFile(uintptr(fd), "listener-keep")
		connection, err := net.FileConn(file)
		_ = file.Close()
		if unixConnection, ok := connection.(*net.UnixConn); err == nil && ok {
			current.fromLauncher = true
			// The launcher stores what it keeps in systemd's store through the
			// NOTIFY_SOCKET systemd gave it when the unit started. A unit that
			// had no store and NotifyAccess then (the drop-in
			// EnsureSystemdStore installs applies to the running unit) gave it
			// none, so the listeners lived in the launcher alone and closed
			// with it on the unit's next restart, the first one after the
			// update: the connections waiting in their backlogs were reset. Its
			// processes inherit its environment; without NOTIFY_SOCKET this
			// process stores them itself, on the launcher's behalf, as under a
			// launcher without a keeper.
			if os.Getenv("NOTIFY_SOCKET") == "" {
				current.mirror = dialNotifySocketFor(os.Getppid())
			}
			mirror := current.mirror
			current.channel = unixConnection
			current.send = func(message string, file *os.File) error {
				if err := sendMessage(unixConnection, message, file); err != nil {
					return err
				}
				if _, name, _ := strings.Cut(message, "\n"); mirror != nil && !transientName(name) {
					// The launcher keeps it either way; a store that refuses
					// it only loses it across a restart of the whole unit.
					_ = forwardToSystemd(mirror, message, file)
				}
				return nil
			}
		}
		return current
	}
	for name, file := range takeSystemdListeners() {
		current.inherited[name] = file
	}
	if notify := dialNotifySocket(); notify != nil {
		current.send = func(message string, file *os.File) error {
			return forwardToSystemd(notify, message, file)
		}
	}
	return current
}

func sendMessage(connection *net.UnixConn, message string, file *os.File) error {
	if len(message) > maxMessage {
		return errors.New("listener keep message is too long")
	}
	_ = connection.SetWriteDeadline(time.Now().Add(sendTimeout))
	return withDescriptor(file, func(rights []byte) error {
		_, _, err := connection.WriteMsgUnix([]byte(message), rights, nil)
		return err
	})
}

// withDescriptor runs send with the SCM_RIGHTS control message carrying file
// (none for a nil file). It never calls file.Fd(): that switches the
// descriptor to blocking mode, and the mode belongs to the socket every copy
// shares, so a listener still accepting in this or another process would
// block in accept() and could no longer be closed.
func withDescriptor(file *os.File, send func(rights []byte) error) error {
	if file == nil {
		return send(nil)
	}
	raw, err := file.SyscallConn()
	if err != nil {
		return err
	}
	var sendErr error
	if err := raw.Control(func(fd uintptr) {
		sendErr = send(syscall.UnixRights(int(fd)))
	}); err != nil {
		return err
	}
	return sendErr
}

// takeSystemdListeners adopts the descriptors systemd passed this process
// (sd_listen_fds with names) and clears the variables so no helper process
// reads them.
func takeSystemdListeners() map[string]*os.File {
	return takeListenFDs(3)
}

// takeListenFDs reads sd_listen_fds for descriptors numbered from first (3
// outside tests).
func takeListenFDs(first int) map[string]*os.File {
	pid := os.Getenv("LISTEN_PID")
	count := os.Getenv("LISTEN_FDS")
	names := os.Getenv("LISTEN_FDNAMES")
	if pid == "" && count == "" {
		return nil
	}
	_ = os.Unsetenv("LISTEN_PID")
	_ = os.Unsetenv("LISTEN_FDS")
	_ = os.Unsetenv("LISTEN_FDNAMES")
	if pid != strconv.Itoa(os.Getpid()) {
		return nil
	}
	n, err := strconv.Atoi(count)
	if err != nil || n <= 0 {
		return nil
	}
	nameList := strings.Split(names, ":")
	files := make(map[string]*os.File, n)
	for index := 0; index < n; index++ {
		fd := first + index
		syscall.CloseOnExec(fd)
		name := ""
		if index < len(nameList) {
			name = nameList[index]
		}
		if name == "" || name == "unknown" || name == "stored" {
			// Not one of ours: keep it closed rather than guessing.
			_ = syscall.Close(fd)
			continue
		}
		files[name] = os.NewFile(uintptr(fd), name)
	}
	return files
}

// notifySocket sends to systemd's notification socket. The socket is not
// connected: a connected datagram socket cannot carry descriptors in Go.
type notifySocket struct {
	fd      int
	address *syscall.SockaddrUnix
	// pid is the process the messages are sent on behalf of; 0 for this one.
	pid int
}

func dialNotifySocket() *notifySocket {
	return dialNotifySocketFor(0)
}

// dialNotifySocketFor opens the unit's notification socket for messages sent
// on behalf of pid (0: this process). Sending as another process takes
// privileges (CAP_SYS_ADMIN, as root has): without them a send fails and the
// listener is simply not kept.
func dialNotifySocketFor(pid int) *notifySocket {
	if pid == 1 || pid < 0 || (pid > 0 && !notifyOnBehalfSupported) {
		return nil
	}
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" && pid > 0 && os.Getenv("INVOCATION_ID") != "" {
		// A unit started before it had a store and NotifyAccess (the drop-in
		// EnsureSystemdStore installs applies to the running unit, but its
		// processes got no NOTIFY_SOCKET): systemd's own socket.
		if info, err := os.Stat(systemdNotifySocket); err == nil && info.Mode()&os.ModeSocket != 0 {
			path = systemdNotifySocket
		}
	}
	if path == "" || (!strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "@")) {
		return nil
	}
	syscall.ForkLock.RLock()
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_DGRAM, 0)
	if err == nil {
		syscall.CloseOnExec(fd)
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil
	}
	return &notifySocket{fd: fd, address: &syscall.SockaddrUnix{Name: path}, pid: pid}
}

func (n *notifySocket) send(message string, file *os.File) error {
	return withDescriptor(file, func(rights []byte) error {
		control := rights
		if n.pid > 0 {
			control = append(notifyCredentials(n.pid), rights...)
		}
		return syscall.Sendmsg(n.fd, []byte(message), control, n.address, 0)
	})
}

func (n *notifySocket) close() {
	_ = syscall.Close(n.fd)
}

// forwardToSystemd stores or removes a kept listener in systemd's file
// descriptor store (sd_pid_notify_with_fds FDSTORE=1 / FDSTOREREMOVE=1).
func forwardToSystemd(notify *notifySocket, message string, file *os.File) error {
	kind, name, ok := strings.Cut(message, "\n")
	if !ok || name == "" || strings.ContainsAny(name, ":\n") {
		return errors.New("invalid listener keep message")
	}
	if err := notify.send("FDSTOREREMOVE=1\nFDNAME="+name+"\n", nil); err != nil {
		return err
	}
	if kind != messageKeep {
		return nil
	}
	if file == nil {
		return errors.New("listener keep message carries no descriptor")
	}
	return notify.send("FDSTORE=1\nFDNAME="+name+"\n", file)
}

// envEither reads a variable under its Opfield name, else its pre-Opfield one.
func envEither(name, legacy string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	// legacy-name: legacycompat.EnvPrefixDAEMON_* set by a pre-Opfield launcher copy — remove once every node reports none
	return os.Getenv(legacy)
}
