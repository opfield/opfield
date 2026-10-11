package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"

	mobyclient "github.com/moby/moby/client"
)

// pgSetMesh is how a Postgres member reaches its set's member mesh aliases on
// the set's private bridge: the generic mesh's API (contracts.md, ha-sw
// "set_member_mesh.go"). Until that lands on this branch, pgLocalMesh below
// implements the subset Postgres needs; at integration pgMesh returns the
// generic mesh and this file's implementation goes.
type pgSetMesh interface {
	// Ensure creates the set's private bridge (idempotent) and returns its name.
	Ensure(ctx context.Context, setID string) (string, error)
	// Expose serves host:port on the bridge's gateway, carrying connections
	// to the alias through BridgeSetPeer.
	Expose(setID, host string, port uint16, alias string)
	// ExtraHosts are "<host>:<gateway ip>" for every exposed host.
	ExtraHosts(setID string) []string
	// Release closes the set's listeners.
	Release(setID string)
}

// pgMesh is the member mesh Postgres members use.
func (p *DockerPlugin) pgMesh() pgSetMesh {
	p.pgMeshOnce.Do(func() { p.pgMeshLocal = &pgLocalMesh{plugin: p, sets: map[string]*pgLocalMeshSet{}} })
	return p.pgMeshLocal
}

type pgLocalMesh struct {
	plugin *DockerPlugin
	mu     sync.Mutex
	sets   map[string]*pgLocalMeshSet
}

type pgLocalMeshSet struct {
	network   string
	gateway   netip.Addr
	exposed   map[string]pgLocalExpose
	listeners map[string]net.Listener
}

type pgLocalExpose struct {
	port  uint16
	alias string
}

// pgSetNetworkName is the set's private bridge name.
func pgSetNetworkName(setID string) string {
	compact := strings.ReplaceAll(setID, "-", "")
	if len(compact) > 16 {
		compact = compact[:16]
	}
	return "gateway-set-" + compact
}

func (l *pgLocalMesh) set(setID string) *pgLocalMeshSet {
	set := l.sets[setID]
	if set == nil {
		set = &pgLocalMeshSet{network: pgSetNetworkName(setID), exposed: map[string]pgLocalExpose{}, listeners: map[string]net.Listener{}}
		l.sets[setID] = set
	}
	return set
}

func (l *pgLocalMesh) Ensure(ctx context.Context, setID string) (string, error) {
	name := pgSetNetworkName(setID)
	cli := l.plugin.client.cli
	inspected, err := cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{})
	if err != nil {
		if _, createErr := cli.NetworkCreate(ctx, name, mobyclient.NetworkCreateOptions{
			Driver: "bridge", Labels: map[string]string{managedDatabaseLabel: name, "wiolett.gateway.availability.set": setID},
		}); createErr != nil {
			return "", fmt.Errorf("create the set's private bridge: %w", createErr)
		}
		if inspected, err = cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{}); err != nil {
			return "", err
		}
	}
	gateway, err := managedDatabaseNetworkGatewayAddress(inspected.Network)
	if err != nil {
		return "", err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	set := l.set(setID)
	set.gateway = gateway
	for host := range set.exposed {
		l.listenLocked(setID, set, host)
	}
	return name, nil
}

func (l *pgLocalMesh) Expose(setID, host string, port uint16, alias string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	set := l.set(setID)
	set.exposed[host] = pgLocalExpose{port: port, alias: alias}
	if set.gateway.IsValid() {
		l.listenLocked(setID, set, host)
	}
}

func (l *pgLocalMesh) listenLocked(setID string, set *pgLocalMeshSet, host string) {
	if set.listeners[host] != nil {
		return
	}
	expose := set.exposed[host]
	listener, err := net.Listen("tcp", net.JoinHostPort(set.gateway.String(), strconv.Itoa(int(expose.port))))
	if err != nil {
		l.plugin.logger.Warn("could not serve a member mesh alias", "set_id", setID, "alias", expose.alias, "error", err)
		return
	}
	set.listeners[host] = listener
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				if errors.Is(err, net.ErrClosed) {
					return
				}
				continue
			}
			go func() {
				if err := l.plugin.BridgeSetPeer(conn, setID, expose.alias); err != nil {
					l.plugin.logger.Debug("member mesh connection not carried", "set_id", setID, "alias", expose.alias, "error", err)
				}
			}()
		}
	}()
}

func (l *pgLocalMesh) ExtraHosts(setID string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	set := l.sets[setID]
	if set == nil || !set.gateway.IsValid() {
		return nil
	}
	out := make([]string, 0, len(set.exposed))
	for host := range set.exposed {
		out = append(out, host+":"+set.gateway.String())
	}
	return out
}

func (l *pgLocalMesh) Release(setID string) {
	l.mu.Lock()
	set := l.sets[setID]
	delete(l.sets, setID)
	l.mu.Unlock()
	if set == nil {
		return
	}
	for _, listener := range set.listeners {
		_ = listener.Close()
	}
}
