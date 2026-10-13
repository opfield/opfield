package docker

import (
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

// A restart or update of this daemon hands the sockets workloads reach their database and storage links through to
// the next daemon process instead of closing them (a restart refused every new link connection until the next
// process listened again, and an update did the same). The listener keeper (the daemon launcher, and the unit's
// systemd file descriptor store) holds a copy of each listening socket, so the socket keeps accepting into its
// backlog while no daemon process runs, and the next process adopts it. Stopping, this process only stops accepting
// and lets the link connections that are in the middle of a request finish; connections idle between requests close
// at once and the workload's pool opens new ones, which wait in the backlog. The data of a link passes this process
// (its relay tunnels belong to it), so a connection that is still busy when the drain ends is cut.

const (
	// hostListenerKeepPrefix names the database binding host listeners in the listener keeper.
	hostListenerKeepPrefix = "gateway-db-listener/"
	// keptListenerAdoptionWindow bounds how long a kept host listener whose binding could not be verified at start
	// (dockerd slow) waits for the sync that adopts it; it queues connections meanwhile.
	keptListenerAdoptionWindow = time.Minute
	// listenerRebindWait bounds the retries of a bind refused because the previous copy of the socket at that address
	// is still being closed by the keeper.
	listenerRebindWait = time.Second
	listenerRebindTick = 20 * time.Millisecond
	// relayLaneStartupWait is how long after this process started a link connection that finds no relay lane waits
	// for the first lanes instead of being refused: the sockets handed over by the previous process hold connections
	// that are accepted before the lanes are up.
	relayLaneStartupWait = 15 * time.Second
	relayLaneStartupTick = 25 * time.Millisecond
	// linkFlowIdleQuiet is how long a link connection must have carried no byte, with its last request answered, to
	// count as idle between requests.
	linkFlowIdleQuiet = 100 * time.Millisecond
)

// hostListenerKeepName is the keeper name of the host listener at address and port (no ':' in a keeper name).
func hostListenerKeepName(address netip.Addr, port uint16) string {
	return hostListenerKeepPrefix + address.String() + "/" + strconv.Itoa(int(port))
}

// listenerDescriptor returns a copy of a listener's descriptor whose Fd leaves the socket's blocking mode alone (the
// File method of a net listener switches the shared descriptor to blocking mode, and the listener's own accept loop
// could then never be closed).
func listenerDescriptor(listener syscall.Conn, name string) (*os.File, error) {
	raw, err := listener.SyscallConn()
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
	return os.NewFile(uintptr(duplicated), name), nil
}

// keepListener hands a copy of listener to the listener keeper under name and returns the name ("" when there is no
// keeper or it could not be kept).
func keepListener(listener syscall.Conn, name string) string {
	if !listenerkeep.Available() {
		return ""
	}
	file, err := listenerDescriptor(listener, name)
	if err != nil {
		return ""
	}
	defer file.Close()
	if err := listenerkeep.Keep(name, file); err != nil {
		return ""
	}
	return name
}

// adoptKeptListeners takes over the host listeners the previous daemon process kept (listenerkeep) and the ones the
// boot step held for this one (boot), to be claimed by the reconcile that wants them (listen).
func (m *managedDatabaseHostListenerManager) adoptKeptListeners(boot map[string]*os.File) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.adopted == nil {
		m.adopted = map[string]*os.File{}
	}
	for _, name := range listenerkeep.Inherited(hostListenerKeepPrefix) {
		if file, ok := listenerkeep.Take(name); ok {
			m.adopted[name] = file
		}
	}
	for name, file := range boot {
		if previous := m.adopted[name]; previous != nil {
			// The same socket, handed over twice: the keeper's copy is enough.
			_ = file.Close()
			continue
		}
		m.adopted[name] = file
	}
}

// releaseAdopted closes the adopted listeners no reconcile claimed, except those named in keep, which wait for a
// later reconcile until keptListenerAdoptionWindow ends.
func (m *managedDatabaseHostListenerManager) releaseAdopted(keep map[string]bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	waiting := 0
	for name, file := range m.adopted {
		if keep[name] {
			waiting++
			continue
		}
		_ = file.Close()
		_ = listenerkeep.Drop(name)
		delete(m.adopted, name)
	}
	if waiting > 0 && m.adoptionTimer == nil {
		m.adoptionTimer = time.AfterFunc(keptListenerAdoptionWindow, func() { m.releaseAdopted(nil) })
	}
}

// takeAdoptedLocked returns the adopted listener for config's address, nil when there is none (or it is not that
// socket). Callers hold m.mu.
func (m *managedDatabaseHostListenerManager) takeAdoptedLocked(name string, config managedDatabaseHostListenerConfig) *net.TCPListener {
	file := m.adopted[name]
	if file == nil {
		return nil
	}
	delete(m.adopted, name)
	defer file.Close()
	listener, err := net.FileListener(file)
	if err != nil {
		_ = listenerkeep.Drop(name)
		return nil
	}
	tcpListener, ok := listener.(*net.TCPListener)
	address, _ := netip.AddrFromSlice(listenerTCPAddress(listener).IP)
	if !ok || address.Unmap() != config.listenAddress || listenerTCPAddress(listener).Port != int(config.listenPort) {
		_ = listener.Close()
		_ = listenerkeep.Drop(name)
		return nil
	}
	return tcpListener
}

func listenerTCPAddress(listener net.Listener) *net.TCPAddr {
	if address, ok := listener.Addr().(*net.TCPAddr); ok {
		return address
	}
	return &net.TCPAddr{}
}

// bindHostListener binds a new host listener for config. A previous copy of the socket the keeper still holds (a
// listener replaced at the same address, or one a launcher without a keeper left in systemd's store) is dropped
// first; its close is asynchronous, so a bind refused meanwhile is retried briefly.
func bindHostListener(name string, config managedDatabaseHostListenerConfig) (*net.TCPListener, error) {
	_ = listenerkeep.DropStale(name)
	addressBytes := config.listenAddress.As4()
	address := &net.TCPAddr{IP: net.IPv4(addressBytes[0], addressBytes[1], addressBytes[2], addressBytes[3]), Port: int(config.listenPort)}
	deadline := time.Now().Add(listenerRebindWait)
	for {
		listener, err := net.ListenTCP("tcp4", address)
		if err == nil || !errors.Is(err, syscall.EADDRINUSE) || time.Now().After(deadline) {
			return listener, err
		}
		time.Sleep(listenerRebindTick)
	}
}

// suspendForHandover stops every host listener accepting for the next daemon process and reports how many it handed
// over. Listeners without a keeper's copy keep accepting: closing them would only refuse connections earlier.
func (m *managedDatabaseHostListenerManager) suspendForHandover() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	m.handingOver = true
	listeners := make([]*managedDatabaseHostListener, 0, len(m.listeners))
	for _, listener := range m.listeners {
		listeners = append(listeners, listener)
	}
	// An orphan's socket goes along: the next process's first bundle may name the binding that takes it over.
	for _, listener := range m.orphans {
		listeners = append(listeners, listener)
	}
	m.mu.Unlock()
	handed := 0
	for _, listener := range listeners {
		if listener.suspend() {
			handed++
		}
	}
	return handed
}

// suspend closes only this process's copy of a kept listener: the keeper's copy keeps the socket, and the connections
// waiting in its backlog, for the next process. The connections this process serves stay.
func (listener *managedDatabaseHostListener) suspend() bool {
	listener.mu.Lock()
	if listener.closed || listener.keptName == "" {
		listener.mu.Unlock()
		return false
	}
	// The keeper's copy is the next process's from here on: nothing in this one drops it.
	listener.keptName = ""
	listener.mu.Unlock()
	_ = listener.listener.Close()
	return true
}

// keepUnixListener hands a copy of a Unix listener at path to the listener keeper and returns its keeper name.
func keepUnixListener(listener net.Listener, path string) string {
	unixListener, ok := listener.(*net.UnixListener)
	if !ok || !listenerkeep.Available() {
		return ""
	}
	name, err := listenerkeep.Name(path)
	if err != nil {
		return ""
	}
	return keepListener(unixListener, name)
}

// keptUnixListener is a link's Unix socket (the storage connectors', the shared connector's egress) with its keeper
// name.
type keptUnixListener struct {
	mu       sync.Mutex
	listener net.Listener
	keptName string
}

func (k *keptUnixListener) set(listener net.Listener, keptName string) {
	k.mu.Lock()
	k.listener, k.keptName = listener, keptName
	k.mu.Unlock()
}

// suspend stops accepting on a kept socket for the next process, leaving the socket file in place.
func (k *keptUnixListener) suspend() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.listener == nil || k.keptName == "" {
		return false
	}
	if unixListener, ok := k.listener.(*net.UnixListener); ok {
		unixListener.SetUnlinkOnClose(false)
	}
	_ = k.listener.Close()
	k.listener, k.keptName = nil, ""
	return true
}

// suspendLinkListeners hands every link socket over to the next daemon process (see the top of this file) and
// reports how many.
func (p *DockerPlugin) suspendLinkListeners() int {
	handed := p.databaseListeners.suspendForHandover()
	if p.storageConnectorKept.suspend() {
		handed++
	}
	if p.secureLinkEgressKept.suspend() {
		handed++
	}
	if p.registryProxy.suspendForHandover() {
		handed++
	}
	return handed
}

// linkFlowSet tracks the link connections this daemon carries, so a restart lets the requests in flight finish.
type linkFlowSet struct {
	mu    sync.Mutex
	flows map[*linkFlowConn]struct{}
}

// track returns connection tracked until done is called.
func (s *linkFlowSet) track(connection net.Conn) (flow *linkFlowConn, done func()) {
	flow = &linkFlowConn{Conn: connection, opened: time.Now().UnixNano()}
	s.mu.Lock()
	if s.flows == nil {
		s.flows = map[*linkFlowConn]struct{}{}
	}
	s.flows[flow] = struct{}{}
	s.mu.Unlock()
	return flow, func() {
		s.mu.Lock()
		delete(s.flows, flow)
		s.mu.Unlock()
	}
}

// drain waits up to limit for the connections in the middle of a request, closing each one as soon as it is idle
// between requests, and reports how many were still busy at the end.
func (s *linkFlowSet) drain(limit time.Duration) int {
	deadline := time.Now().Add(limit)
	for {
		now := time.Now()
		busy := 0
		s.mu.Lock()
		for flow := range s.flows {
			if flow.idle(now, linkFlowIdleQuiet) {
				_ = flow.Close()
				delete(s.flows, flow)
				continue
			}
			busy++
		}
		s.mu.Unlock()
		if busy == 0 || !now.Before(deadline) {
			return busy
		}
		time.Sleep(restartDrainTick)
	}
}

// linkFlowConn is a workload's link connection: what it reads is the workload's request, what it writes the answer.
type linkFlowConn struct {
	net.Conn
	opened    int64
	lastRead  atomic.Int64
	lastWrite atomic.Int64
}

func (c *linkFlowConn) Read(buffer []byte) (int, error) {
	n, err := c.Conn.Read(buffer)
	if n > 0 {
		c.lastRead.Store(time.Now().UnixNano())
	}
	return n, err
}

func (c *linkFlowConn) Write(buffer []byte) (int, error) {
	n, err := c.Conn.Write(buffer)
	if n > 0 {
		c.lastWrite.Store(time.Now().UnixNano())
	}
	return n, err
}

// CloseWrite passes a relay half-close on to the workload.
func (c *linkFlowConn) CloseWrite() error {
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

// idle reports a connection whose last request was answered and that carried no byte for quiet.
func (c *linkFlowConn) idle(now time.Time, quiet time.Duration) bool {
	read, write := c.lastRead.Load(), c.lastWrite.Load()
	if now.UnixNano()-max(read, write, c.opened) < quiet.Nanoseconds() {
		return false
	}
	return read <= write
}

// waitForRelayLanes waits, within relayLaneStartupWait of this process's start, until a relay lane may be open, and
// reports whether it is worth trying again.
func (p *DockerPlugin) waitForRelayLanes() bool {
	if p.startedAt.IsZero() || time.Since(p.startedAt) >= relayLaneStartupWait {
		return false
	}
	time.Sleep(relayLaneStartupTick)
	return true
}

// restartMarkerFile records when this daemon announced a restart to its relays (B-13): the next process registers
// its endpoints at once, taking over the registrations the relays hold for it, instead of waiting for Opfield's
// first grant bundle (relayGrantRestoreHold).
const restartMarkerFile = "restart-announced"

// restartMarkerValid is how long the relays keep a restarting endpoint's registration (relay EndpointRestartGrace).
const restartMarkerValid = 15 * time.Second

func writeRestartMarker(stateDir string, now time.Time) error {
	return os.WriteFile(restartMarkerPath(stateDir), []byte(strconv.FormatInt(now.UnixMilli(), 10)), 0o600)
}

// consumeRestartMarker reports whether the previous process announced its restart less than restartMarkerValid ago,
// and removes the marker.
func consumeRestartMarker(stateDir string, now time.Time) bool {
	path := restartMarkerPath(stateDir)
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	_ = os.Remove(path)
	announced, err := strconv.ParseInt(string(data), 10, 64)
	if err != nil {
		return false
	}
	age := now.Sub(time.UnixMilli(announced))
	return age >= 0 && age < restartMarkerValid
}

func restartMarkerPath(stateDir string) string {
	return filepath.Join(stateDir, restartMarkerFile)
}
