package handover

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"time"

	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// Restored is what the previous process handed over.
type Restored struct {
	FromVersion string
	// FrozenAt is when the previous process stopped the connections.
	FrozenAt time.Time
	Sessions []*RestoredSession
	Pipes    []*RestoredPipe
	// Tombstones answer later RESUMEs of target streams that ended
	// (relayresume.TargetTable.RestoreTombstones).
	Tombstones []relayresume.Tombstone
	// Lost counts handed over connections that did not come over: a socket
	// the keeper did not pass on, or not the one the snapshot names.
	Lost int
}

// RestoredSession is a local connection and the state of its stream.
type RestoredSession struct {
	State  *relayresume.SessionState
	Conn   net.Conn
	Labels Labels
}

// Cut ends a connection this process does not take over after all (its route
// was revoked meanwhile): its peer sees it end at once.
func (s *RestoredSession) Cut() {
	_ = s.Conn.Close()
}

// RestoredPipe is a node-local link connection: its two sockets and, per
// direction, what was read and not written yet and whether it ended.
type RestoredPipe struct {
	Conns   [2]net.Conn
	Pending [2][]byte
	Done    [2]bool
	Labels  Labels
}

// Cut ends both connections of a pipe this process does not take over.
func (p *RestoredPipe) Cut() {
	_ = p.Conns[0].Close()
	_ = p.Conns[1].Close()
}

// ResumePipe carries a pipe taken over from the previous process on, until
// both directions ended (Pipe).
func (r *Registry) ResumePipe(pipe *RestoredPipe, cfg PipeConfig) error {
	return r.pipe(pipe.Conns[0], pipe.Conns[1], cfg, pipe.Pending, pipe.Done)
}

// Restore takes over what the previous process of daemonType handed over, if
// anything: call it once, early, before the daemon registers its endpoints
// with the relays or accepts new connections. The snapshot is taken once: it
// and the keeper's copies of the sockets are dropped at once, so a crash from
// here on cuts these connections but never hands them over twice. Sockets
// left in the keeper that no snapshot claims are ended.
func Restore(daemonType string, logger *slog.Logger) (*Restored, error) {
	return RestoreFrom(LauncherKeeper, daemonType, logger)
}

// RestoreFrom is Restore from keeper.
func RestoreFrom(keeper Keeper, daemonType string, logger *slog.Logger) (*Restored, error) {
	if logger == nil {
		logger = slog.Default()
	}
	defer releaseLeftovers(keeper, logger)
	file, ok := keeper.Take(stateName)
	if !ok {
		return nil, nil
	}
	_ = keeper.Drop(stateName)
	data, err := readSealedFile(file, maxSnapshotBytes)
	_ = file.Close()
	if err != nil {
		return nil, err
	}
	snapshot, err := DecodeSnapshot(data)
	if err != nil {
		return nil, err
	}
	if snapshot.DaemonType != daemonType {
		return nil, fmt.Errorf("handover: the snapshot belongs to a %s daemon", snapshot.DaemonType)
	}
	if age := time.Since(snapshot.CreatedAt); age > MaxSnapshotAge || age < -time.Minute {
		return nil, fmt.Errorf("handover: the snapshot is %s old", age.Round(time.Second))
	}
	restored := &Restored{FromVersion: snapshot.FromVersion, FrozenAt: snapshot.CreatedAt, Tombstones: snapshot.Tombstones}
	for i := range snapshot.Items {
		item := &snapshot.Items[i]
		connections, err := takeSockets(keeper, item)
		if err != nil {
			logger.Debug("a handed over connection did not come over", "error", err)
			restored.Lost++
			continue
		}
		switch item.Kind {
		case KindSession:
			state, err := item.sessionState()
			if err != nil {
				logger.Warn("a handed over stream could not be read", "error", err)
				_ = connections[0].Close()
				restored.Lost++
				continue
			}
			restored.Sessions = append(restored.Sessions, &RestoredSession{State: state, Conn: connections[0], Labels: item.Labels})
		case KindPipe:
			restored.Pipes = append(restored.Pipes, &RestoredPipe{Conns: [2]net.Conn{connections[0], connections[1]},
				Pending: [2][]byte{append([]byte(nil), item.Pending[0]...), append([]byte(nil), item.Pending[1]...)}, Done: item.Done,
				Labels: item.Labels})
		default:
			for _, connection := range connections {
				_ = connection.Close()
			}
			restored.Lost++
		}
	}
	// The keeper closes its copies (the drops) before this process carries a
	// byte: a copy it kept would hold a connection open after this one ended.
	if err := keeper.Flush(flushWait); err != nil {
		logger.Warn("the launcher did not take the dropped connections in time", "error", err)
	}
	return restored, nil
}

// takeSockets takes an item's sockets from the keeper and drops the keeper's
// copies. Every socket must be the one the snapshot names.
func takeSockets(keeper Keeper, item *SnapshotItem) ([]net.Conn, error) {
	var connections []net.Conn
	fail := func(err error) ([]net.Conn, error) {
		for _, connection := range connections {
			_ = connection.Close()
		}
		return nil, err
	}
	for i, name := range item.Conns {
		file, ok := keeper.Take(name)
		if !ok {
			// Take the item's other sockets anyway: they must not stay open.
			for _, other := range item.Conns[i+1:] {
				if file, ok := keeper.Take(other); ok {
					_ = keeper.Drop(other)
					if connection, err := net.FileConn(file); err == nil {
						connections = append(connections, &restoredConn{Conn: connection})
					}
					_ = file.Close()
				}
			}
			return fail(fmt.Errorf("socket %s was not handed over", name))
		}
		_ = keeper.Drop(name)
		connection, err := socketFromFile(file, item.Inodes[i])
		if err != nil {
			return fail(err)
		}
		connections = append(connections, connection)
	}
	return connections, nil
}

func socketFromFile(file *os.File, inode uint64) (net.Conn, error) {
	defer file.Close()
	got, err := inodeOf(file)
	if err != nil {
		return nil, err
	}
	connection, err := net.FileConn(file)
	if err != nil {
		return nil, err
	}
	restored := &restoredConn{Conn: connection}
	if got != inode {
		_ = restored.Close()
		return nil, errors.New("a handed over socket is not the one the snapshot names")
	}
	return restored, nil
}

// releaseLeftovers ends the sockets a handover left in the keeper that no
// snapshot claimed (a snapshot that did not come over, a crashed handover).
func releaseLeftovers(keeper Keeper, logger *slog.Logger) {
	for _, name := range keeper.Inherited(connPrefix) {
		file, ok := keeper.Take(name)
		if !ok {
			continue
		}
		_ = keeper.Drop(name)
		if connection, err := net.FileConn(file); err == nil {
			_ = (&restoredConn{Conn: connection}).Close()
		}
		_ = file.Close()
		logger.Debug("ended a handed over connection no snapshot claimed", "name", name)
	}
	if file, ok := keeper.Take(stateName); ok {
		_ = keeper.Drop(stateName)
		_ = file.Close()
	}
}
