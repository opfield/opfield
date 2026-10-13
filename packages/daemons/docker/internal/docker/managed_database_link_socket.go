package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// The link socket (F-3): a TLS-enabled managed PostgreSQL also listens on a
// unix socket in a host directory only root reaches, and the daemon serves a
// relay client that does not negotiate TLS itself (every app database link)
// over it instead of speaking TLS to PostgreSQL over the bridge. The
// connection is a plain socket, so a daemon update hands it to the next
// process like any other link; TLS state that lives in this process cannot be
// handed over and was cut (postgres_tls).
//
// PostgreSQL authenticates a socket connection with the role's password
// (`local all all scram-sha-256` in the managed pg_hba), as it does a TCP one;
// the engine's own tools pass the owner password. A container gets the socket
// when it is next created (a settings change, an engine update, a repair),
// never just for this; until then its links use TLS over the bridge, and a
// socket that does not answer falls back to it too.
const (
	pgLinkSocketContainerDir = "/run/opfield-link"
	pgLinkSocketName         = ".s.PGSQL.5432"
	pgLinkSocketsDirName     = "link-sockets"
)

// pgLinkSocketChown gives the socket directory to the engine's account
// (replaceable in tests, which do not run as root).
var pgLinkSocketChown = os.Chown

// pgLinkSocketRoot reports whether this daemon can give a database a link
// socket: only root can make a directory the engine's account owns behind one
// nobody else may enter (replaceable in tests).
var pgLinkSocketRoot = func() bool { return os.Geteuid() == 0 }

// linkSocketDir is the host directory of record's link socket:
// <root>/link-sockets (root, 0700) / <id> (the engine's account, 0700). The
// first directory keeps every other host account out, the second is the one
// the container binds.
func (m *managedDatabaseManager) linkSocketDir(record managedDatabaseRecord) string {
	return filepath.Join(m.root, pgLinkSocketsDirName, record.ID)
}

// linkSocketWanted reports whether a container created now for record gets
// the link socket: a TLS-enabled single-node PostgreSQL (an availability set
// member has its own pg_hba), on a start the launcher can no longer roll back
// (an older daemon's engine tools rely on the old pg_hba), by a root daemon.
func linkSocketWanted(record managedDatabaseRecord, input managedDatabaseCommand) bool {
	return input.Type == "postgres" && input.TLSEnabled && record.AvailabilitySetID == "" &&
		pgLinkSocketRoot() && pgLinkSocketConfirmed()
}

// pgLinkSocketConfirmed reports whether this start is confirmed (replaceable
// in tests).
var pgLinkSocketConfirmed = lifecycle.StartConfirmed

// prepareLinkSocketDir makes the link socket directory of record and returns
// it.
func (m *managedDatabaseManager) prepareLinkSocketDir(record managedDatabaseRecord) (string, error) {
	parent := filepath.Join(m.root, pgLinkSocketsDirName)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return "", err
	}
	dir := m.linkSocketDir(record)
	if info, err := os.Lstat(dir); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return "", fmt.Errorf("%s is not a directory", dir)
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	uid, gid, err := managedDatabaseTLSOwner("postgres")
	if err != nil {
		return "", err
	}
	if err := pgLinkSocketChown(dir, uid, gid); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// removeLinkSocketDir removes record's link socket directory (the database is
// deleted).
func (m *managedDatabaseManager) removeLinkSocketDir(record managedDatabaseRecord) {
	_ = os.RemoveAll(m.linkSocketDir(record))
}

var errNoLinkSocket = errors.New("the database has no link socket")

// dialLinkSocket connects to record's link socket. Every dial looks at the
// socket itself, not at record.PostgresLinkSocket: a relay dial reads the
// record without the manager lock, and while a recreate runs the record on
// disk is still the previous container's (it is saved when the command ends),
// so the flag can say "no socket" for a container that already serves one
// (R-5). A socket only exists in a container created with the scram pg_hba;
// a stale one nobody listens on is refused and the link falls back. The host
// path is longer than a socket address may be, so the connection goes through
// the directory's descriptor (/proc/self/fd/N/.s.PGSQL.5432).
func (m *managedDatabaseManager) dialLinkSocket(ctx context.Context, record managedDatabaseRecord) (net.Conn, error) {
	if record.AvailabilitySetID != "" {
		return nil, errNoLinkSocket
	}
	return dialSocketIn(ctx, m.linkSocketDir(record), pgLinkSocketName)
}

// noteLinkSocketDial logs a link that falls back to TLS over the bridge, once
// per database and reason (a link socket that answers again resets it).
func (m *managedDatabaseManager) noteLinkSocketDial(record managedDatabaseRecord, err error) {
	if err == nil {
		m.linkFallbacks.Delete(record.ID)
		return
	}
	reason := err.Error()
	if previous, loaded := m.linkFallbacks.Swap(record.ID, reason); loaded && previous == reason {
		return
	}
	if m.logger == nil {
		return
	}
	if errors.Is(err, errNoLinkSocket) && !record.PostgresLinkSocket {
		m.logger.Info("managed PostgreSQL links use TLS over the bridge: the container has no link socket yet (it gets one when it is next recreated)", "id", record.ID)
		return
	}
	m.logger.Warn("managed PostgreSQL link falls back to TLS over the bridge: the link socket did not answer", "id", record.ID, "error", err)
}

// dialSocketIn connects to the unix socket name in dir.
func dialSocketIn(ctx context.Context, dir, name string) (net.Conn, error) {
	fd, err := unix.Open(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, fmt.Errorf("%w: no directory %s", errNoLinkSocket, dir)
	}
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	address := "/proc/self/fd/" + strconv.Itoa(fd) + "/" + name
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", address)
	if err != nil {
		var opErr *net.OpError
		if errors.As(err, &opErr) && errors.Is(opErr.Err, syscall.ENOENT) {
			return nil, fmt.Errorf("%w: no socket in %s", errNoLinkSocket, dir)
		}
		return nil, err
	}
	return connection, nil
}
