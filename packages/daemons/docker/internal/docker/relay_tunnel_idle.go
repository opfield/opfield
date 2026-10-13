package docker

import (
	"crypto/tls"
	"net"
	"time"
)

// relayTunnelIdleLimit ends a source tunnel of a route that has an idle limit (a backup run's route, the registry)
// once its connection carried no byte for that long, as the relay ends that route's idle tunnels; a variable for tests.
var relayTunnelIdleLimit = 5 * time.Minute

// relaySourceIdleLimit is the idle limit of the source tunnels of a connect assignment's owner kind (0: none).
// Workload links (database, storage and container links) keep their pooled connections open however long they idle:
// Opfield's route policy turns the relays' idle timeout off for them (relay-policy.service.ts relayRoutePolicy,
// disableIdleTimeout). A daemon is not told the policy, so it follows it by kind; every other route keeps the limit.
func relaySourceIdleLimit(ownerKind string) time.Duration {
	switch ownerKind {
	case linkKindManagedDatabaseBinding, linkKindManagedStorageBinding, containerLinkOwnerKind:
		return 0
	}
	return relayTunnelIdleLimit
}

// keepLocalAlive turns TCP keepalive on for the local side of a tunnel without an idle limit (Go's dialers and
// listeners already do; this holds whatever made the socket): a peer that vanished without a FIN or RST ends the
// tunnel after the probes instead of leaving it open for good. A Unix socket (the connector's egress stream) has none:
// the connector holds the workload's TCP connection with keepalive and closes the stream with it.
func keepLocalAlive(connection net.Conn) {
	for connection != nil {
		switch current := connection.(type) {
		case *net.TCPConn:
			// Zero idle, interval and count: Go's defaults (15 s, 15 s, 9 probes).
			_ = current.SetKeepAliveConfig(net.KeepAliveConfig{Enable: true})
			return
		case *tls.Conn:
			connection = current.NetConn()
		case *drainConn:
			connection = current.Conn
		case *connectorConn:
			connection = current.Conn
		case *linkFlowConn:
			connection = current.Conn
		case *linkCountedConn:
			connection = current.Conn
		default:
			return
		}
	}
}
