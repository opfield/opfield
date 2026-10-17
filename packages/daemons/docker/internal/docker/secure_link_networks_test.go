package docker

import (
	"bufio"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"net/netip"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/network"
)

// New link networks take the first /26 of the pool that no Docker network and no host route uses; the connector's
// address (base+2) stays out of the range Docker assigns workloads (the upper /27).
func TestLinkSubnetAllocation(t *testing.T) {
	pool := netip.MustParsePrefix("10.213.0.0/16")
	used := []netip.Prefix{
		netip.MustParsePrefix("10.213.0.0/26"),  // a link network
		netip.MustParsePrefix("10.213.0.64/29"), // part of the next /26: a host route
		netip.MustParsePrefix("172.17.0.0/16"),  // Docker's default bridge
	}
	subnet, err := allocateLinkSubnet(pool, used)
	if err != nil || subnet.String() != "10.213.0.128/26" {
		t.Fatalf("allocated %s, %v; want 10.213.0.128/26", subnet, err)
	}
	if _, err := allocateLinkSubnet(netip.MustParsePrefix("10.213.0.0/25"), append(used, netip.MustParsePrefix("10.213.0.0/24"))); err == nil {
		t.Fatal("allocated from a pool without a free /26")
	}
	// A host route over the whole pool (a VPN, a routed LAN) leaves no subnet in it.
	if _, err := allocateLinkSubnet(pool, []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}); err == nil {
		t.Fatal("allocated a subnet the host routes elsewhere")
	}

	ipam, reserved, err := managedConnectorIPAM(subnet.String(), "")
	if err != nil {
		t.Fatal(err)
	}
	if reserved != "10.213.0.130" || ipam.Gateway.String() != "10.213.0.129" || ipam.IPRange.String() != "10.213.0.160/27" ||
		ipam.IPRange.Contains(netip.MustParseAddr(reserved)) {
		t.Fatalf("IPAM %+v reserved %s", ipam, reserved)
	}
	inspected := network.Inspect{Network: network.Network{
		Name: legacycompat.ContainerLinkNetworkPrefix + "0123456789abcdef", Labels: map[string]string{"net.opfield.managed": linkNetworkLabel},
		IPAM: network.IPAM{Config: []network.IPAMConfig{ipam}},
	}}
	if address, static := linkNetworkReservedAddress(inspected); !static || address.String() != reserved {
		t.Fatalf("reserved address of a link network %s %v", address, static)
	}
	// A database network created before the pool (Docker's subnet, no reserved address): the connector gets a
	// dynamic address there.
	inspected.Name, inspected.Labels = legacycompat.DatabaseLinkNetworkPrefix+"0123456789abcdef", nil
	if _, static := linkNetworkReservedAddress(inspected); static {
		t.Fatal("a network created before the pool was taken for a link network")
	}
}

func TestHostRouteTable(t *testing.T) {
	table := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
		"eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n" +
		"wg0\t0000D50A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"
	prefixes, err := parseRouteTable(bufio.NewScanner(strings.NewReader(table)))
	if err != nil {
		t.Fatal(err)
	}
	if len(prefixes) != 2 || prefixes[0].String() != "192.168.0.0/24" || prefixes[1].String() != "10.213.0.0/16" {
		t.Fatalf("routes %v", prefixes)
	}
}
