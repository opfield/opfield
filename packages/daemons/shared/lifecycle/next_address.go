package lifecycle

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// OpfieldNextAddressCapability marks a daemon that takes the address Opfield
// moves to (SetOpfieldNextAddressCommand): an installation exported and
// restored on another host tells every node its new address before the old
// host is shut down.
//
// The daemon keeps the address next to its current one (opfield.next_address
// in its config file) and changes nothing while the current address works.
// Once the control session has failed for nextAddressAfter, it tries the next
// address once every nextAddressProbeInterval with its own mTLS identity and
// the usual server verification: the restored Opfield has the same System CA,
// and its certificate names the new address. When that connection becomes
// ready the next address becomes opfield.address, on disk and in the running
// process: the control session dials it on its next attempt. Relay lanes and
// tunnel connections that are up are not touched, and no daemon restarts.
const OpfieldNextAddressCapability = "gateway_next_address_v1"

const (
	// nextAddressAfter is how long the control session must have failed
	// before the daemon tries the next address. A restart or an update of
	// Opfield on its old host is over well within it.
	nextAddressAfter = 10 * time.Minute
	// nextAddressProbeInterval spaces the attempts to reach the next address.
	nextAddressProbeInterval = time.Minute
	// nextAddressProbeTimeout bounds one attempt.
	nextAddressProbeTimeout = 10 * time.Second
	// nextAddressTick is how often the daemon checks whether an attempt is due.
	nextAddressTick = 10 * time.Second
)

// activeControlAddress is the Opfield address the daemon dials now.
var activeControlAddress atomic.Pointer[string]

// ControlAddress returns the Opfield address the daemon's control session
// dials now, or fallback before the daemon lifecycle started. Plugins that
// open their own control connections (the nginx maintenance access channel)
// use it so they follow a move of Opfield to another address.
func ControlAddress(fallback string) string {
	if address := activeControlAddress.Load(); address != nil && *address != "" {
		return *address
	}
	return fallback
}

func setActiveControlAddress(address string) {
	activeControlAddress.Store(&address)
}

var (
	controlAddressListenersMu sync.Mutex
	controlAddressListeners   []func(address string)
	// controlAddressNotifyMu runs the listeners one change at a time.
	controlAddressNotifyMu sync.Mutex
)

// OnControlAddressChanged registers fn to run after the daemon switched its
// control connection to the address Opfield moved to. fn runs off the control
// session, one change at a time, with the address switched to.
func OnControlAddressChanged(fn func(address string)) {
	controlAddressListenersMu.Lock()
	defer controlAddressListenersMu.Unlock()
	controlAddressListeners = append(controlAddressListeners, fn)
}

// notifyControlAddressChanged runs the listeners in the background and
// returns a channel closed once they ran.
func notifyControlAddressChanged(address string) <-chan struct{} {
	controlAddressListenersMu.Lock()
	listeners := append(([]func(string))(nil), controlAddressListeners...)
	controlAddressListenersMu.Unlock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		controlAddressNotifyMu.Lock()
		defer controlAddressNotifyMu.Unlock()
		for _, listener := range listeners {
			listener(address)
		}
	}()
	return done
}

// normalizeOpfieldAddress checks that value is host:port the way the control
// session dials it: a hostname, an IPv4 address or a bracketed IPv6 address,
// and a port from 1 to 65535, without a scheme, path or spaces.
func normalizeOpfieldAddress(value string) (string, error) {
	if value == "" {
		return "", errors.New("address is empty")
	}
	if strings.Contains(value, "://") {
		return "", fmt.Errorf("address %q must be host:port without a scheme", value)
	}
	if strings.ContainsAny(value, "/?#@ \t\r\n") {
		return "", fmt.Errorf("address %q must be host:port without a path or spaces", value)
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return "", fmt.Errorf("address %q must be host:port: %v", value, err)
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port {
		return "", fmt.Errorf("address %q has an invalid port (1-65535)", value)
	}
	if host == "" {
		return "", fmt.Errorf("address %q has no host", value)
	}
	bracketed := strings.HasPrefix(value, "[")
	if strings.Contains(host, ":") {
		addr, err := netip.ParseAddr(host)
		if err != nil || !addr.Is6() || addr.Zone() != "" || !bracketed {
			return "", fmt.Errorf("address %q has an invalid IPv6 host (use [address]:port)", value)
		}
		return net.JoinHostPort(addr.String(), port), nil
	}
	if bracketed {
		return "", fmt.Errorf("address %q brackets a host that is not an IPv6 address", value)
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if !addr.Is4() {
			return "", fmt.Errorf("address %q has an invalid host", value)
		}
		return net.JoinHostPort(addr.String(), port), nil
	}
	if !validHostname(host) {
		return "", fmt.Errorf("address %q has an invalid hostname", value)
	}
	return net.JoinHostPort(strings.ToLower(host), port), nil
}

// validHostname accepts DNS names of letters, digits and hyphens (labels of
// 1-63 characters, not starting or ending with a hyphen, up to 253 in all)
// whose last label is not all digits (that would be a malformed IPv4 address).
func validHostname(host string) bool {
	if len(host) > 253 {
		return false
	}
	labels := strings.Split(host, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
				return false
			}
		}
	}
	last := labels[len(labels)-1]
	_, numeric := strconv.Atoi(last)
	return numeric != nil
}

// sameOpfieldAddress compares two addresses as the control session dials
// them (hostnames are case-insensitive, IP addresses in their usual form).
func sameOpfieldAddress(left, right string) bool {
	if normalized, err := normalizeOpfieldAddress(left); err == nil {
		left = normalized
	}
	if normalized, err := normalizeOpfieldAddress(right); err == nil {
		right = normalized
	}
	return strings.EqualFold(left, right)
}

// controlConfigFileMu serializes the edits of the daemon config file.
var controlConfigFileMu sync.Mutex

// editControlConfigFile changes keys of the control section of the config
// file at path: every key in set gets its value, every key in remove goes.
// Everything else in the file (other keys, their order and comments) stays,
// and the file keeps its permissions. The file is replaced atomically.
func editControlConfigFile(path string, set map[string]string, remove ...string) error {
	controlConfigFileMu.Lock()
	defer controlConfigFileMu.Unlock()
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return errors.New("config file is not a YAML mapping")
	}
	root := document.Content[0]
	// The section the daemon loaded: opfield:, else the pre-Opfield gateway:.
	var section *yaml.Node
	for _, key := range ControlSectionKeys {
		if section = yamlMappingValue(root, key); section != nil {
			break
		}
	}
	if section == nil {
		section = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		root.Content = append(root.Content, yamlString(ControlSectionKeys[0]), section)
	}
	if section.Kind != yaml.MappingNode {
		return errors.New("config file has no opfield mapping")
	}
	for _, key := range remove {
		yamlMappingDelete(section, key)
	}
	for key, value := range set {
		if existing := yamlMappingValue(section, key); existing != nil {
			replacement := yamlString(value)
			replacement.LineComment = existing.LineComment
			*existing = *replacement
			continue
		}
		section.Content = append(section.Content, yamlString(key), yamlString(value))
	}
	var out bytes.Buffer
	encoder := yaml.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return err
	}
	if err := encoder.Close(); err != nil {
		return err
	}
	return atomicfile.WriteFile(path, out.Bytes(), info.Mode().Perm())
}

func yamlString(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

func yamlMappingValue(mapping *yaml.Node, key string) *yaml.Node {
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index].Value == key {
			return mapping.Content[index+1]
		}
	}
	return nil
}

func yamlMappingDelete(mapping *yaml.Node, key string) {
	for index := 0; index+1 < len(mapping.Content); {
		if mapping.Content[index].Value == key {
			mapping.Content = append(mapping.Content[:index], mapping.Content[index+2:]...)
			continue
		}
		index += 2
	}
}

// opfieldMove holds the address Opfield moves to and switches the control
// connection to it (OpfieldNextAddressCapability).
type opfieldMove struct {
	cfgPath string
	logger  *slog.Logger
	now     func() time.Time
	// probe reports whether a control connection to address becomes ready.
	probe func(ctx context.Context, address string) error
	// apply makes the running daemon dial address from now on.
	apply func(address string)

	mu      sync.Mutex
	current string
	next    string
	// connected is set while a control session Opfield accepted runs.
	connected bool
	// failingSince is when the last accepted session ended, or the start.
	failingSince time.Time
	lastProbe    time.Time
	// unsaved is set while next could not be written to the config file.
	unsaved bool
}

func newOpfieldMove(cfgPath, current, next string, now func() time.Time, logger *slog.Logger, probe func(context.Context, string) error, apply func(string)) *opfieldMove {
	m := &opfieldMove{
		cfgPath:      cfgPath,
		logger:       logger,
		now:          now,
		probe:        probe,
		apply:        apply,
		current:      current,
		failingSince: now(),
	}
	if next != "" {
		normalized, err := normalizeOpfieldAddress(next)
		switch {
		case err != nil:
			logger.Warn("ignoring the invalid Opfield next address in the config file", "next_address", next, "error", err)
		case sameOpfieldAddress(normalized, current):
		default:
			m.next = normalized
			logger.Info("Opfield announced a move; switching to its next address if the current one stays unreachable",
				"address", current, "next_address", normalized, "after", nextAddressAfter)
		}
	}
	return m
}

// set stores the next address (empty, or the current address, clears it).
// It returns the stored address. An invalid address changes nothing.
func (m *opfieldMove) set(value string) (string, error) {
	value = strings.TrimSpace(value)
	address := ""
	if value != "" {
		normalized, err := normalizeOpfieldAddress(value)
		if err != nil {
			return "", err
		}
		address = normalized
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if address != "" && sameOpfieldAddress(address, m.current) {
		address = ""
	}
	if address == m.next && !m.unsaved {
		return address, nil
	}
	if address != m.next {
		m.next = address
		m.lastProbe = time.Time{}
	}
	var err error
	if address == "" {
		err = editControlConfigFile(m.cfgPath, nil, "next_address")
	} else {
		err = editControlConfigFile(m.cfgPath, map[string]string{"next_address": address})
	}
	m.unsaved = err != nil
	if err != nil {
		return address, fmt.Errorf("the next Opfield address is kept until the daemon restarts, but the config file could not be updated: %w", err)
	}
	return address, nil
}

func (m *opfieldMove) sessionStarted() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.connected = true
	m.mu.Unlock()
}

func (m *opfieldMove) sessionEnded() {
	if m == nil {
		return
	}
	m.mu.Lock()
	if m.connected {
		m.connected = false
		m.failingSince = m.now()
	}
	m.mu.Unlock()
}

// tick tries the next address when it is due and switches to it when it
// answers. It reports whether it switched.
func (m *opfieldMove) tick(ctx context.Context) bool {
	m.mu.Lock()
	now := m.now()
	next := m.next
	due := next != "" && !m.connected && now.Sub(m.failingSince) >= nextAddressAfter &&
		(m.lastProbe.IsZero() || now.Sub(m.lastProbe) >= nextAddressProbeInterval)
	if due {
		m.lastProbe = now
	}
	failingFor := now.Sub(m.failingSince)
	m.mu.Unlock()
	if !due {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, nextAddressProbeTimeout)
	err := m.probe(probeCtx, next)
	cancel()
	if err != nil {
		m.logger.Warn("the address Opfield moves to does not answer yet", "next_address", next, "unreachable_for", failingFor.Round(time.Second), "error", err)
		return false
	}
	m.mu.Lock()
	if m.next != next || m.connected {
		// Cleared, replaced, or the current address answered meanwhile.
		m.mu.Unlock()
		return false
	}
	previous := m.current
	persistErr := editControlConfigFile(m.cfgPath, map[string]string{"address": next}, "next_address")
	m.current = next
	m.next = ""
	m.failingSince = m.now()
	m.mu.Unlock()
	m.apply(next)
	m.logger.Warn("Opfield moved: the control connection now uses its new address",
		"previous_address", previous, "address", next, "unreachable_for", failingFor.Round(time.Second))
	if persistErr != nil {
		m.logger.Warn("could not save the new Opfield address in the config file; the daemon uses it until it restarts", "address", next, "error", persistErr)
	}
	return true
}

func (m *opfieldMove) run(ctx context.Context) {
	ticker := time.NewTicker(nextAddressTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.tick(ctx)
		}
	}
}

// startOpfieldMove sets the daemon up to follow a move of Opfield: called
// once the connector exists.
func (d *DaemonBase) startOpfieldMove(ctx context.Context) {
	setActiveControlAddress(d.connector.Address())
	d.move = newOpfieldMove(
		d.cfgPath,
		d.connector.Address(),
		d.cfg.Control.NextAddress,
		time.Now,
		slog.New(d.baseHandler),
		func(ctx context.Context, address string) error {
			return d.connector.Probe(ctx, address, nextAddressProbeTimeout)
		},
		d.switchControlAddress,
	)
	go d.move.run(ctx)
}

// switchControlAddress makes the control session (and the lanes to the relay
// at the Opfield address, once they are down) dial address from the next
// attempt on. Open connections keep their target.
func (d *DaemonBase) switchControlAddress(address string) {
	d.connector.SetAddress(address)
	setActiveControlAddress(address)
	notifyControlAddressChanged(address)
}

// handleSetOpfieldNextAddress stores the address Opfield moves to.
func (d *DaemonBase) handleSetOpfieldNextAddress(cmd *pb.OpfieldCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: cmd.GetCommandId(), Success: true}
	if d.move == nil {
		result.Success = false
		result.Error = "daemon is not connected to Opfield yet"
		return result
	}
	address, err := d.move.set(cmd.GetSetOpfieldNextAddress().GetAddress())
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		if address != "" {
			d.logger.Warn("could not save the next Opfield address", "next_address", address, "error", err)
		}
		return result
	}
	if address == "" {
		result.Detail = "next Opfield address cleared"
		d.logger.Info("Opfield next address cleared")
	} else {
		result.Detail = "next Opfield address set to " + address
		d.logger.Info("Opfield announced a move; switching to its next address if the current one stays unreachable",
			"next_address", address, "after", nextAddressAfter)
	}
	return result
}
