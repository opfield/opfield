package sysmetrics

import (
	"bufio"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"unicode"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// GetNetworkInterfaces reads /proc/net/dev and returns per-interface stats, skipping lo.
func GetNetworkInterfaces() []*pb.NetworkInterface {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return nil
	}

	var ifaces []*pb.NetworkInterface

	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		// Skip the first two header lines
		if lineNum <= 2 {
			continue
		}
		line := scanner.Text()
		// Format: "  iface: rx_bytes rx_packets rx_errs rx_drop ... tx_bytes tx_packets tx_errs tx_drop ..."
		colonIdx := strings.Index(line, ":")
		if colonIdx < 0 {
			continue
		}
		name := strings.TrimSpace(line[:colonIdx])
		if name == "lo" {
			continue
		}

		rest := strings.TrimSpace(line[colonIdx+1:])
		fields := strings.Fields(rest)
		if len(fields) < 16 {
			continue
		}

		rxBytes, _ := strconv.ParseInt(fields[0], 10, 64)
		rxPackets, _ := strconv.ParseInt(fields[1], 10, 64)
		rxErrors, _ := strconv.ParseInt(fields[2], 10, 64)
		txBytes, _ := strconv.ParseInt(fields[8], 10, 64)
		txPackets, _ := strconv.ParseInt(fields[9], 10, 64)
		txErrors, _ := strconv.ParseInt(fields[10], 10, 64)
		ipAddresses := interfaceIPAddresses(name)

		ifaces = append(ifaces, &pb.NetworkInterface{
			Name:        name,
			RxBytes:     rxBytes,
			TxBytes:     txBytes,
			RxPackets:   rxPackets,
			TxPackets:   txPackets,
			RxErrors:    rxErrors,
			TxErrors:    txErrors,
			IpAddresses: ipAddresses,
		})
	}

	return ifaces
}

func interfaceIPAddresses(name string) []string {
	iface, err := net.InterfaceByName(name)
	if err != nil || iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || !isLocalAddressInterface(name) {
		return nil
	}
	addresses, err := iface.Addrs()
	if err != nil {
		return nil
	}
	return normalizeLocalIPAddresses(addresses)
}

// GetInterfaceIPAddresses returns usable addresses assigned to active,
// non-loopback host interfaces, split into local and publicly routable groups.
// CIDR prefixes are intentionally omitted because Gateway displays these as
// node identities rather than route definitions.
func GetInterfaceIPAddresses() (local []string, public []string) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, nil
	}

	var addresses []net.Addr
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || !isLocalAddressInterface(iface.Name) {
			continue
		}
		interfaceAddresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		addresses = append(addresses, interfaceAddresses...)
	}

	return classifyInterfaceIPAddresses(normalizeLocalIPAddresses(addresses))
}

// isLocalAddressInterface excludes container-runtime interfaces whose
// addresses identify an internal container network rather than the host.
// Conventional host bridges such as br0 and vmbr0 remain eligible.
func isLocalAddressInterface(name string) bool {
	lowerName := strings.ToLower(name)
	if lowerName == "docker0" || lowerName == "docker_gwbridge" || lowerName == "cni0" || lowerName == "podman0" {
		return false
	}

	for _, prefix := range []string{
		"veth",
		"cali",
		"flannel.",
		"kube-",
		"weave",
		"virbr",
		"lxcbr",
		"lxdbr",
	} {
		if strings.HasPrefix(lowerName, prefix) {
			return false
		}
	}

	return !isDockerBridgeName(lowerName)
}

func isDockerBridgeName(name string) bool {
	const prefix = "br-"
	const networkIDLength = 12
	if !strings.HasPrefix(name, prefix) || len(name) != len(prefix)+networkIDLength {
		return false
	}
	for _, char := range name[len(prefix):] {
		if !unicode.Is(unicode.ASCII_Hex_Digit, char) {
			return false
		}
	}
	return true
}

func normalizeLocalIPAddresses(addresses []net.Addr) []string {
	unique := make(map[string]struct{}, len(addresses))
	result := make([]string, 0, len(addresses))
	for _, address := range addresses {
		var ip net.IP
		switch value := address.(type) {
		case *net.IPNet:
			ip = value.IP
		case *net.IPAddr:
			ip = value.IP
		default:
			parsedIP, _, err := net.ParseCIDR(address.String())
			if err == nil {
				ip = parsedIP
			} else {
				ip = net.ParseIP(address.String())
			}
		}

		if ip == nil || !ip.IsGlobalUnicast() || ip.IsLinkLocalUnicast() {
			continue
		}
		normalized := ip.String()
		if _, exists := unique[normalized]; exists {
			continue
		}
		unique[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func classifyInterfaceIPAddresses(addresses []string) (local []string, public []string) {
	for _, value := range addresses {
		address, err := netip.ParseAddr(value)
		if err != nil {
			continue
		}
		if isPublicIPAddress(address.Unmap()) {
			public = append(public, address.Unmap().String())
		} else {
			local = append(local, address.Unmap().String())
		}
	}
	return local, public
}
