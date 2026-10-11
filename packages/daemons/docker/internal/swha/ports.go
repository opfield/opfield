package swha

import (
	"fmt"
	"strconv"
)

// Ports are the same on every member of a set: a component's address
// ("member-<id>-sw-volume:<port>") is advertised to every other member, which
// reaches it on that port through its own mesh listener.
const (
	MasterHTTPPort = 9333
	MasterGRPCPort = 19333
	// S3Port is the filer's S3 listener (the member's client endpoint).
	S3Port = 9000
	// memberPortBase: member index i has volume HTTP 20000+2i and filer HTTP
	// 20001+2i, their gRPC ports 10000 above (SeaweedFS's default offset).
	memberPortBase = 20000
	grpcOffset     = 10000
	// MaxMemberIndex keeps every port below 32768 and the snowflake id
	// (index + 1) within its 10 bits.
	MaxMemberIndex = 1022
)

// Peer port names on the member mesh (relay peer endpoints).
const (
	PortMaster     = "sw-master"
	PortMasterGRPC = "sw-master-grpc"
	PortVolume     = "sw-volume"
	PortVolumeGRPC = "sw-volume-grpc"
	PortFiler      = "sw-filer"
	PortFilerGRPC  = "sw-filer-grpc"
)

// VolumePorts are the HTTP and gRPC ports of member index's volume server.
func VolumePorts(index uint32) (uint16, uint16) {
	http := uint16(memberPortBase + 2*index)
	return http, http + grpcOffset
}

// FilerPorts are the HTTP and gRPC ports of member index's filer.
func FilerPorts(index uint32) (uint16, uint16) {
	http := uint16(memberPortBase + 2*index + 1)
	return http, http + grpcOffset
}

// MasterHost, VolumeHost and FilerHost are the mesh host names.
const MasterHost = "primary-sw-master"

func VolumeHost(memberID string) string { return "member-" + memberID + "-sw-volume" }
func FilerHost(memberID string) string  { return "member-" + memberID + "-sw-filer" }

// VolumeURL is a volume server's address as SeaweedFS advertises it.
func VolumeURL(memberID string, index uint32) string {
	port, _ := VolumePorts(index)
	return VolumeHost(memberID) + ":" + strconv.Itoa(int(port))
}

// FilerURL is a filer's HTTP address.
func FilerURL(memberID string, index uint32) string {
	port, _ := FilerPorts(index)
	return FilerHost(memberID) + ":" + strconv.Itoa(int(port))
}

// MasterAddress is the master address every component dials.
func MasterAddress() string { return MasterHost + ":" + strconv.Itoa(MasterHTTPPort) }

// SnowflakeID is the master's sequencer id of member index (0 makes SeaweedFS
// derive one from its address, so it is never used).
func SnowflakeID(index uint32) (uint32, error) {
	if index > MaxMemberIndex {
		return 0, fmt.Errorf("member index %d is above %d", index, MaxMemberIndex)
	}
	return index + 1, nil
}

// Exposure is one mesh listener: host:port on the set network carried to alias.
type Exposure struct {
	Host  string
	Port  uint16
	Alias string
}

// Exposures are the mesh listeners a member needs: the primary's master and
// every other member's volume server and filer. The member's own components
// are reached on the set network directly (their container aliases).
func Exposures(self string, members []MemberRef) []Exposure {
	out := []Exposure{
		{Host: MasterHost, Port: MasterHTTPPort, Alias: "primary-" + PortMaster},
		{Host: MasterHost, Port: MasterGRPCPort, Alias: "primary-" + PortMasterGRPC},
	}
	for _, member := range members {
		if member.ID == self {
			continue
		}
		vh, vg := VolumePorts(member.Index)
		fh, fg := FilerPorts(member.Index)
		out = append(out,
			Exposure{Host: VolumeHost(member.ID), Port: vh, Alias: "member-" + member.ID + "-" + PortVolume},
			Exposure{Host: VolumeHost(member.ID), Port: vg, Alias: "member-" + member.ID + "-" + PortVolumeGRPC},
			Exposure{Host: FilerHost(member.ID), Port: fh, Alias: "member-" + member.ID + "-" + PortFiler},
			Exposure{Host: FilerHost(member.ID), Port: fg, Alias: "member-" + member.ID + "-" + PortFilerGRPC},
		)
	}
	return out
}

// MemberRef is a member as the ports need it.
type MemberRef struct {
	ID    string
	Index uint32
}
