package docker

import (
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
)

// maxHostPortPicks bounds how often a picked host port is skipped (another
// Gateway workload reserves it, or it was taken before Docker bound it)
// before a managed database create fails.
const maxHostPortPicks = 16

// pickManagedDatabaseHostPorts returns input with a free host port in place of
// every published port the controller leaves to the node (0) and reports
// whether it picked one.
//
// Docker picks an empty HostPort again on every container start, so the port
// has to be pinned in the container's binding. Picking it before the create
// lets the container be created once with that binding; replacing a started
// container to pin Docker's pick would start the engine, and load its
// dataset, twice. The kernel picks from the ephemeral range Docker picks
// from. Every port tried stays bound until all picks are made, so the picks
// differ from each other.
func pickManagedDatabaseHostPorts(input managedDatabaseCommand) (managedDatabaseCommand, bool, error) {
	if !input.PublishTCP {
		return input, false, nil
	}
	pickPrimary := input.PublishedPort == 0
	pickNative := input.Type == "clickhouse" && input.PublishNativeTCP && input.PublishedNativePort == 0
	if !pickPrimary && !pickNative {
		return input, false, nil
	}
	var held []net.Listener
	defer func() {
		for _, listener := range held {
			_ = listener.Close()
		}
	}()
	pick := func() (uint16, error) {
		for range maxHostPortPicks {
			listener, err := net.Listen("tcp", ":0")
			if err != nil {
				return 0, fmt.Errorf("pick a managed database host port: %w", err)
			}
			held = append(held, listener)
			port := uint16(listener.Addr().(*net.TCPAddr).Port)
			if !slices.Contains(input.ExcludedHostPorts, port) && port != input.PublishedPort && port != input.PublishedNativePort {
				return port, nil
			}
		}
		return 0, errors.New("every picked host port is reserved by another Opfield workload; publish a chosen port instead")
	}
	pinned := input
	if pickPrimary {
		port, err := pick()
		if err != nil {
			return input, false, err
		}
		pinned.PublishedPort = port
	}
	if pickNative {
		port, err := pick()
		if err != nil {
			return input, false, err
		}
		pinned.PublishedNativePort = port
	}
	return pinned, true, nil
}

// dockerHostPortTaken reports a container start Docker refused because a
// published host port is in use.
func dockerHostPortTaken(err error) bool {
	message := err.Error()
	return strings.Contains(message, "port is already allocated") || strings.Contains(message, "address already in use")
}
