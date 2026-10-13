package docker

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// Link networks (C5): every new link network (container links, new storage and database links) gets an explicit /26
// from Opfield's own pool instead of Docker's default address pools, so links never use up the subnets users'
// networks are given. The connector holds base+2 on it (its static address, outside the network's dynamic range);
// workloads get the addresses Docker assigns from the upper /27 (managedConnectorIPAM): about 30 per link.
const (
	defaultLinkSubnetPool  = "10.213.0.0/16"
	linkNetworkPrefixBits  = 26
	linkNetworkLabel       = "secure-link"
	linkNetworkCreateTries = 8
)

// legacy-name: gateway- link networks of links created before 2.12.1 or for a node without docker_opfield_names_v1 — remove once every node reports none
var linkNetworkNamePattern = regexp.MustCompile(`^(?:opfield|gateway)-(?:link|db|storage)-(?:av-)?[0-9a-f]{16}$`)

// linkNetworkCreate serializes the subnet choice of concurrent creates.
var linkNetworkCreate sync.Mutex

// hostRoutePrefixes lists the IPv4 destinations of the host's routes, the default route left out (a variable for
// tests).
var hostRoutePrefixes = readHostRoutePrefixes

type linkNetworkResult struct {
	ID               string `json:"id"`
	Subnet           string `json:"subnet"`
	ConnectorAddress string `json:"connectorAddress"`
}

// linkSubnetPool is the pool of the daemon's configuration (docker.secure_links.subnet_pool), else the default.
func (p *DockerPlugin) linkSubnetPool() (netip.Prefix, error) {
	value := defaultLinkSubnetPool
	if p.cfg != nil && strings.TrimSpace(p.cfg.Docker.SecureLinks.SubnetPool) != "" {
		value = strings.TrimSpace(p.cfg.Docker.SecureLinks.SubnetPool)
	}
	pool, err := netip.ParsePrefix(value)
	if err != nil || !pool.Addr().Is4() || pool.Bits() > linkNetworkPrefixBits {
		return netip.Prefix{}, fmt.Errorf("secure-link subnet pool %q must be an IPv4 network of /%d or larger", value, linkNetworkPrefixBits)
	}
	return pool.Masked(), nil
}

// createLinkNetwork creates the internal bridge network of a link with the first free /26 of the pool. A network of
// that name that already is a link network is returned as it is, so a retried command succeeds.
func (p *DockerPlugin) createLinkNetwork(ctx context.Context, name string) (linkNetworkResult, error) {
	if !linkNetworkNamePattern.MatchString(name) {
		return linkNetworkResult{}, errors.New("invalid secure-link network name")
	}
	pool, err := p.linkSubnetPool()
	if err != nil {
		return linkNetworkResult{}, err
	}
	linkNetworkCreate.Lock()
	defer linkNetworkCreate.Unlock()
	existing, err := p.client.cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{})
	if err == nil {
		return linkNetworkResultOf(existing.Network)
	}
	if !isNotFoundErr(err) {
		return linkNetworkResult{}, fmt.Errorf("inspect secure-link network: %w", err)
	}
	used, err := p.usedIPv4Prefixes(ctx)
	if err != nil {
		return linkNetworkResult{}, err
	}
	for range linkNetworkCreateTries {
		subnet, err := allocateLinkSubnet(pool, used)
		if err != nil {
			return linkNetworkResult{}, err
		}
		ipam, reserved, err := managedConnectorIPAM(subnet.String(), "")
		if err != nil {
			return linkNetworkResult{}, err
		}
		created, err := p.client.cli.NetworkCreate(ctx, name, mobyclient.NetworkCreateOptions{
			Driver: "bridge", Internal: true,
			Labels: map[string]string{"net.opfield.managed": linkNetworkLabel},
			IPAM:   &network.IPAM{Driver: "default", Config: []network.IPAMConfig{ipam}},
		})
		if err != nil && strings.Contains(strings.ToLower(err.Error()), "overlap") {
			// Taken meanwhile by a network of another client: the next free one.
			used = append(used, subnet)
			continue
		}
		if err != nil {
			return linkNetworkResult{}, fmt.Errorf("create secure-link network: %w", err)
		}
		return linkNetworkResult{ID: created.ID, Subnet: subnet.String(), ConnectorAddress: reserved}, nil
	}
	return linkNetworkResult{}, errors.New("no free secure-link subnet could be claimed; try again")
}

// linkNetworkResultOf describes an existing network of the requested name, which must be a link network.
func linkNetworkResultOf(inspected network.Inspect) (linkNetworkResult, error) {
	reserved, static := linkNetworkReservedAddress(inspected)
	if !static || inspected.Driver != "bridge" || !inspected.Internal {
		return linkNetworkResult{}, fmt.Errorf("network %s exists and is not an Opfield link network", inspected.Name)
	}
	for _, config := range inspected.IPAM.Config {
		if config.Subnet.IsValid() && config.Subnet.Addr().Is4() {
			return linkNetworkResult{ID: inspected.ID, Subnet: config.Subnet.Masked().String(), ConnectorAddress: reserved.String()}, nil
		}
	}
	return linkNetworkResult{}, fmt.Errorf("network %s has no IPv4 subnet", inspected.Name)
}

// linkNetworkReservedAddress returns the connector's static address on a network of createLinkNetwork: its label,
// and an IPv4 subnet whose dynamic range leaves the reserved address out. Networks created before have none.
func linkNetworkReservedAddress(inspected network.Inspect) (netip.Addr, bool) {
	if inspected.Labels["net.opfield.managed"] != linkNetworkLabel || !linkNetworkNamePattern.MatchString(inspected.Name) {
		return netip.Addr{}, false
	}
	for _, config := range inspected.IPAM.Config {
		if !config.Subnet.IsValid() || !config.Subnet.Addr().Is4() || !config.IPRange.IsValid() {
			continue
		}
		gateway := ""
		if config.Gateway.IsValid() {
			gateway = config.Gateway.String()
		}
		_, value, err := managedConnectorIPAM(config.Subnet.String(), gateway)
		if err != nil {
			continue
		}
		reserved, err := netip.ParseAddr(value)
		if err == nil && config.Subnet.Contains(reserved) && !config.IPRange.Contains(reserved) {
			return reserved, true
		}
	}
	return netip.Addr{}, false
}

// usedIPv4Prefixes lists the IPv4 subnets of every Docker network and the host's routes and interface networks.
func (p *DockerPlugin) usedIPv4Prefixes(ctx context.Context) ([]netip.Prefix, error) {
	listed, err := p.client.cli.NetworkList(ctx, mobyclient.NetworkListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list networks: %w", err)
	}
	var used []netip.Prefix
	for _, item := range listed.Items {
		for _, config := range item.IPAM.Config {
			if config.Subnet.IsValid() && config.Subnet.Addr().Is4() {
				used = append(used, config.Subnet.Masked())
			}
		}
	}
	routes, err := hostRoutePrefixes()
	if err != nil {
		return nil, fmt.Errorf("read the host's routes: %w", err)
	}
	used = append(used, routes...)
	if addresses, err := net.InterfaceAddrs(); err == nil {
		for _, address := range addresses {
			if prefix, err := netip.ParsePrefix(address.String()); err == nil && prefix.Addr().Is4() && !prefix.Addr().IsLoopback() {
				used = append(used, prefix.Masked())
			}
		}
	}
	return used, nil
}

// allocateLinkSubnet returns the first /26 of pool that overlaps none of used.
func allocateLinkSubnet(pool netip.Prefix, used []netip.Prefix) (netip.Prefix, error) {
	pool = pool.Masked()
	if !pool.Addr().Is4() || pool.Bits() > linkNetworkPrefixBits {
		return netip.Prefix{}, errors.New("secure-link subnet pool is not an IPv4 network of /26 or larger")
	}
	start := pool.Addr().As4()
	base := binary.BigEndian.Uint32(start[:])
	step := uint32(1) << (32 - linkNetworkPrefixBits)
	count := uint64(1) << (linkNetworkPrefixBits - pool.Bits())
	for index := uint64(0); index < count; index++ {
		var bytes [4]byte
		binary.BigEndian.PutUint32(bytes[:], base+uint32(index)*step)
		candidate := netip.PrefixFrom(netip.AddrFrom4(bytes), linkNetworkPrefixBits)
		free := true
		for _, prefix := range used {
			if prefix.IsValid() && prefix.Addr().Is4() && candidate.Overlaps(prefix) {
				free = false
				break
			}
		}
		if free {
			return candidate, nil
		}
	}
	return netip.Prefix{}, fmt.Errorf("the secure-link subnet pool %s has no free /%d left", pool, linkNetworkPrefixBits)
}

// readHostRoutePrefixes reads the IPv4 route destinations of /proc/net/route, the default route left out.
func readHostRoutePrefixes() ([]netip.Prefix, error) {
	file, err := os.Open("/proc/net/route")
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return parseRouteTable(bufio.NewScanner(file))
}

func parseRouteTable(scanner *bufio.Scanner) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	first := true
	for scanner.Scan() {
		if first {
			// The header line.
			first = false
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 8 {
			continue
		}
		destination, destinationErr := routeTableAddress(fields[1])
		mask, maskErr := routeTableAddress(fields[7])
		if destinationErr != nil || maskErr != nil {
			continue
		}
		maskBytes := mask.As4()
		bits := 0
		for _, value := range maskBytes {
			for bit := 7; bit >= 0 && value&(1<<bit) != 0; bit-- {
				bits++
			}
		}
		if bits == 0 {
			continue
		}
		prefixes = append(prefixes, netip.PrefixFrom(destination, bits).Masked())
	}
	return prefixes, scanner.Err()
}

// routeTableAddress decodes an address of /proc/net/route: eight hex digits in host (little-endian) byte order.
func routeTableAddress(value string) (netip.Addr, error) {
	raw, err := hex.DecodeString(value)
	if err != nil || len(raw) != 4 {
		return netip.Addr{}, errors.New("invalid route table address")
	}
	return netip.AddrFrom4([4]byte{raw[3], raw[2], raw[1], raw[0]}), nil
}
