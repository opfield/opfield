package chha

import (
	"encoding/xml"
)

// WitnessPeerEndpoint is a member's Keeper as a witness reaches it.
type WitnessPeerEndpoint struct {
	ID   uint32
	Host string
	Port uint32
}

// RenderWitnessKeeperConfig is the Keeper configuration of a witness container
// on a docker node (clickhouse-keeper image): its own raft entry on the set's
// loopback host with priority 1 (data members lead), the members at theirs
// with priority 3, listening on its container's addresses, state under
// /var/lib/clickhouse-keeper (older images default elsewhere, P0-T02 item 9).
func RenderWitnessKeeperConfig(serverID, clientPort, raftPort uint32, raftHost string, peers []WitnessPeerEndpoint) ([]byte, error) {
	type server struct {
		ID       uint32 `xml:"id"`
		Hostname string `xml:"hostname"`
		Port     uint32 `xml:"port"`
		Priority int    `xml:"priority"`
	}
	servers := []server{{ID: serverID, Hostname: raftHost, Port: raftPort, Priority: WitnessPriority}}
	for _, peer := range peers {
		servers = append(servers, server{ID: peer.ID, Hostname: peer.Host, Port: peer.Port, Priority: MemberPriority})
	}
	type coordination struct {
		OperationTimeoutMs int    `xml:"operation_timeout_ms"`
		SessionTimeoutMs   int    `xml:"session_timeout_ms"`
		RaftLogsLevel      string `xml:"raft_logs_level"`
	}
	type keeper struct {
		TCPPort               uint32       `xml:"tcp_port"`
		ServerID              uint32       `xml:"server_id"`
		LogStoragePath        string       `xml:"log_storage_path"`
		SnapshotStoragePath   string       `xml:"snapshot_storage_path"`
		EnableReconfiguration bool         `xml:"enable_reconfiguration"`
		FourLetterWords       string       `xml:"four_letter_word_white_list"`
		Coordination          coordination `xml:"coordination_settings"`
		Servers               []server     `xml:"raft_configuration>server"`
	}
	type logger struct {
		Level   string `xml:"level"`
		Console int    `xml:"console"`
	}
	type document struct {
		XMLName    xml.Name `xml:"clickhouse"`
		Logger     logger   `xml:"logger"`
		ListenHost string   `xml:"listen_host"`
		Path       string   `xml:"path"`
		Keeper     keeper   `xml:"keeper_server"`
	}
	value := document{
		Logger: logger{Level: "information", Console: 1}, ListenHost: "0.0.0.0", Path: "/var/lib/clickhouse-keeper/",
		Keeper: keeper{
			TCPPort: clientPort, ServerID: serverID,
			LogStoragePath: "/var/lib/clickhouse-keeper/coordination/log", SnapshotStoragePath: "/var/lib/clickhouse-keeper/coordination/snapshots",
			EnableReconfiguration: true, FourLetterWords: "ruok,srvr,mntr,conf,isro",
			Coordination: coordination{OperationTimeoutMs: 10000, SessionTimeoutMs: 30000, RaftLogsLevel: "warning"},
			Servers:      servers,
		},
	}
	encoded, err := xml.MarshalIndent(value, "", "    ")
	if err != nil {
		return nil, err
	}
	return append(append([]byte(xml.Header), encoded...), '\n'), nil
}

// Keeper witness containers on docker nodes run this image binary and user.
const (
	WitnessKeeperEntrypoint = "/usr/bin/clickhouse-keeper"
	WitnessKeeperConfigPath = "/etc/gwkw/keeper.xml"
	WitnessKeeperDataPath   = "/var/lib/clickhouse-keeper"
)
