package chha

import (
	"errors"
	"log/slog"
	"net"
	"sort"
	"sync"
)

// forwarders are the listeners in a member container's network namespace that
// carry Keeper raft and interserver connections over the member mesh: one per
// other server (LoopbackHost:port), bound again after every container start
// (a new container is a new namespace).
type forwarders struct {
	listen func(pid int, address string) (net.Listener, error)
	bridge func(connection net.Conn, alias string) error
	logger *slog.Logger

	mu          sync.Mutex
	containerID string
	open        map[string]net.Listener
	aliases     map[string]string
	failed      map[string]string
}

func newForwarders(listen func(int, string) (net.Listener, error), bridge func(net.Conn, string) error, logger *slog.Logger) *forwarders {
	return &forwarders{listen: listen, bridge: bridge, logger: logger, open: map[string]net.Listener{},
		aliases: map[string]string{}, failed: map[string]string{}}
}

// desiredForwards maps every endpoint of another server or member to the mesh
// alias that reaches it.
func desiredForwards(memberID string, ec EngineConfig) map[string]string {
	out := map[string]string{}
	for _, server := range ec.KeeperServers {
		if server.MemberID == memberID {
			continue
		}
		out[ec.Endpoint(server)] = server.Alias()
	}
	for _, peer := range ec.Interserver {
		if peer.MemberID == memberID {
			continue
		}
		out[ec.Endpoint(KeeperServer{Port: peer.Port})] = "member-" + peer.MemberID + "-ch-interserver"
	}
	return out
}

// ensure binds what is missing for the running container containerID (pid)
// and closes what is no longer wanted; a new container drops every listener
// of the previous one first. It returns the addresses that failed to bind.
func (f *forwarders) ensure(containerID string, pid int, desired map[string]string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if containerID != f.containerID {
		f.closeLocked()
		f.containerID = containerID
	}
	for address, listener := range f.open {
		if _, ok := desired[address]; !ok {
			_ = listener.Close()
			delete(f.open, address)
		}
	}
	for address, alias := range desired {
		f.aliases[address] = alias
	}
	var failed []string
	for address := range desired {
		if _, ok := f.open[address]; ok {
			continue
		}
		listener, err := f.listen(pid, address)
		if err != nil {
			failed = append(failed, address)
			if f.failed[address] != err.Error() && f.logger != nil {
				f.logger.Warn("ClickHouse member mesh forwarder could not listen", "address", address, "error", err)
			}
			f.failed[address] = err.Error()
			continue
		}
		delete(f.failed, address)
		f.open[address] = listener
		go f.accept(listener, address)
	}
	sort.Strings(failed)
	return failed
}

func (f *forwarders) accept(listener net.Listener, address string) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) && f.logger != nil {
				f.logger.Debug("ClickHouse member mesh forwarder stopped", "address", address, "error", err)
			}
			return
		}
		f.mu.Lock()
		alias := f.aliases[address]
		f.mu.Unlock()
		go func() {
			if err := f.bridge(connection, alias); err != nil && f.logger != nil {
				f.logger.Debug("ClickHouse member mesh connection failed", "alias", alias, "error", err)
			}
		}()
	}
}

// close drops every listener (container stopped or member removed).
func (f *forwarders) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeLocked()
	f.containerID = ""
}

func (f *forwarders) closeLocked() {
	for address, listener := range f.open {
		_ = listener.Close()
		delete(f.open, address)
	}
}

// addresses are the bound addresses (tests).
func (f *forwarders) addresses() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.open))
	for address := range f.open {
		out = append(out, address)
	}
	sort.Strings(out)
	return out
}
