package swha

import (
	"context"
	"log/slog"
	"net"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Role names one container of a member.
type Role string

const (
	RoleVolume Role = "volume"
	RoleFiler  Role = "filer"
	RoleMaster Role = "master"
)

// ContainerInfo is the Docker view of one member container.
type ContainerInfo struct {
	Exists     bool
	Running    bool
	ID         string
	CgroupPath string
	StartedAt  time.Time
	// Absent: the member's resource is not on this node (not created yet,
	// or deleted): see memberha.ContainerState.Absent.
	Absent bool
}

// Host is what the engine needs from the docker daemon for one member.
type Host interface {
	// Config is the member's current configuration (Opfield may have changed
	// the members since the engine was opened).
	Config() memberha.Config
	Container(ctx context.Context, role Role) (ContainerInfo, error)
	Start(ctx context.Context, role Role) error
	Stop(ctx context.Context, role Role, timeout time.Duration) error
	Kill(ctx context.Context, role Role) error
	CgroupEmpty(ctx context.Context, role Role) (bool, error)
	// EnsureNoRestart keeps Docker from starting the container on its own.
	EnsureNoRestart(ctx context.Context, role Role) error
	// DialContainer connects to a port of a member container on the set network.
	DialContainer(ctx context.Context, role Role, port uint16) (net.Conn, error)
	// Exec runs a command in a member container and returns its stdout.
	Exec(ctx context.Context, role Role, command []string, stdin string) ([]byte, error)
	// DialAlias carries a connection through the member mesh
	// ("primary-sw-master", "member-<id>-sw-filer", ...).
	DialAlias(ctx context.Context, alias string) (net.Conn, error)
	// Expose keeps the mesh listeners the member's containers use.
	Expose(exposures []Exposure)
	// SetLocalPrimary serves the primary aliases locally while the member's
	// master runs here (nil: through the relays).
	SetLocalPrimary(dial func(ctx context.Context, port string) (net.Conn, bool))
	// FilerToken is a write token for the member's own filer (its signing key).
	FilerToken() (string, error)
	// DiskFree is the free space of the member's data disk (0, false: unknown)
	// and whether the volume server stops taking writes there.
	DiskFree() (free uint64, full bool, ok bool)
	// PlanReclaim picks the volumes worth compacting from the master's
	// /vol/status answer and the fullest member disk (maintenance.go).
	PlanReclaim(volumeStatus []byte, fullest DiskSpace) (ReclaimPlan, error)
	// StateDir holds the engine's own files.
	StateDir() string
	// Serve attaches the member's direct publication (no-op without a port).
	Serve()
	Logger() *slog.Logger
}
