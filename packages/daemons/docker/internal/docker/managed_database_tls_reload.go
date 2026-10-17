package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"net"

	mobyclient "github.com/moby/moby/client"
)

// managedDatabaseTLSReloadCommand is the `reload_tls` payload: renewed TLS
// material for a managed database, applied to the running engine without
// recreating the container. The owner credentials are used only for the
// engine's reload statement (Redis, ClickHouse) and a readiness check, and
// are never persisted.
type managedDatabaseTLSReloadCommand struct {
	OperationID         string `json:"operationId"`
	Type                string `json:"type"`
	OwnerUsername       string `json:"ownerUsername"`
	OwnerPassword       string `json:"ownerPassword"`
	DatabaseName        string `json:"databaseName"`
	TLSCertificatePEM   string `json:"tlsCertificatePem"`
	TLSPrivateKeyPEM    string `json:"tlsPrivateKeyPem"`
	TLSCACertificatePEM string `json:"tlsCaCertificatePem"`
	TLSCertificateID    string `json:"tlsCertificateId"`
	AllowRestart        bool   `json:"allowRestart"`
}

func parseManagedDatabaseTLSReloadCommand(raw string) (managedDatabaseTLSReloadCommand, servedCertificate, error) {
	var input managedDatabaseTLSReloadCommand
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return input, servedCertificate{}, fmt.Errorf("parse managed database TLS reload config: %w", err)
	}
	if input.Type != "postgres" && input.Type != "redis" && input.Type != "clickhouse" {
		return input, servedCertificate{}, errors.New("unsupported managed database type")
	}
	if input.OperationID != "" && !managedDatabaseIDPattern.MatchString(input.OperationID) {
		return input, servedCertificate{}, errors.New("managed database operation id is invalid")
	}
	if !managedDatabaseIDPattern.MatchString(input.TLSCertificateID) {
		return input, servedCertificate{}, errors.New("managed database TLS certificate id is invalid")
	}
	if input.Type == "redis" && input.OwnerUsername != "default" {
		return input, servedCertificate{}, errors.New("Redis owner username must be default")
	}
	if !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return input, servedCertificate{}, errors.New("database and owner names must be safe SQL identifiers")
	}
	if len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return input, servedCertificate{}, errors.New("managed database password must be between 16 and 512 characters")
	}
	if input.TLSCACertificatePEM == "" {
		return input, servedCertificate{}, errors.New("managed database TLS CA certificate is required")
	}
	leaf, err := leafCertificateFingerprint(input.TLSCertificatePEM, input.TLSPrivateKeyPEM)
	if err != nil {
		return input, servedCertificate{}, err
	}
	return input, leaf, nil
}

// engineInput is the lifecycle-shaped view of the payload used by the shared
// TLS staging and readiness helpers.
func (c managedDatabaseTLSReloadCommand) engineInput() managedDatabaseCommand {
	return managedDatabaseCommand{
		Type:                c.Type,
		OwnerUsername:       c.OwnerUsername,
		OwnerPassword:       c.OwnerPassword,
		DatabaseName:        c.DatabaseName,
		TLSEnabled:          true,
		TLSCertificatePEM:   c.TLSCertificatePEM,
		TLSPrivateKeyPEM:    c.TLSPrivateKeyPEM,
		TLSCACertificatePEM: c.TLSCACertificatePEM,
		TLSCertificateID:    c.TLSCertificateID,
	}
}

// reloadTLS stages renewed material in the TLS directory mounted into the
// container and makes the running engine serve it: PostgreSQL on SIGHUP,
// Redis on CONFIG SET of its certificate file, ClickHouse on SYSTEM RELOAD
// CONFIG. It is the update path's variant: the caller holds the manager lock
// for the whole operation. The certificate id is recorded only once the new
// leaf is served, so a later update carrying it does not recreate the
// container.
func (m *managedDatabaseManager) reloadTLS(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand, leaf servedCertificate, allowRestart bool) (tlsReloadResult, error) {
	plan, err := m.tlsReloadPlan(ctx, record, input, leaf, allowRestart)
	if err != nil {
		return tlsReloadResult{}, err
	}
	containerID := record.ContainerID
	plan.Restart = func(ctx context.Context) error {
		if err := m.client.RestartContainer(ctx, containerID, 30); err != nil {
			return err
		}
		return m.waitForDatabaseReady(ctx, containerID, input)
	}
	result, err := runTLSReload(ctx, plan)
	if err != nil {
		return result, err
	}
	if result.Status == tlsReloadStatusReloaded {
		record.TLSCertificateID = input.TLSCertificateID
	}
	return result, nil
}

// handleTLSReload is the `reload_tls` command. Staging and the engine trigger
// run under the manager lock; waiting for the engine, and a restart
// fallback's readiness, do not, so relay connections to every database on the
// node keep flowing. The certificate id is recorded afterwards under the lock
// only when no lifecycle operation changed the database meanwhile.
func (m *managedDatabaseManager) handleTLSReload(ctx context.Context, id, configJSON string) (string, error) {
	command, leaf, err := parseManagedDatabaseTLSReloadCommand(configJSON)
	if err != nil {
		return "", err
	}
	input := command.engineInput()
	unlockResource := m.tlsReloads.lock(id)
	defer unlockResource()

	m.mu.Lock()
	record, err := m.loadRecord(id)
	if err != nil {
		m.mu.Unlock()
		return "", err
	}
	// A set member never restarts for a certificate (L1): the member runtime
	// owns its starts; a certificate it did not load stays pending until a
	// switchover and a member restart.
	plan, err := m.tlsReloadPlan(ctx, &record, input, leaf, command.AllowRestart && record.AvailabilityMemberID == "")
	if err != nil {
		m.mu.Unlock()
		return "", err
	}
	generation := m.generations.bump(id)
	triggerErr, err := prepareTLSReload(ctx, plan)
	m.mu.Unlock()
	if err != nil {
		return "", err
	}

	containerID := record.ContainerID
	unchanged := func() bool {
		current, err := m.loadRecord(id)
		return err == nil && current.ContainerID == containerID && m.generations[id] == generation
	}
	plan.Restart = func(ctx context.Context) error {
		m.mu.Lock()
		if !unchanged() {
			m.mu.Unlock()
			return errChangedDuringTLSReload
		}
		err := m.client.RestartContainer(ctx, containerID, 30)
		m.mu.Unlock()
		if err != nil {
			return err
		}
		return m.waitForDatabaseReady(ctx, containerID, input)
	}
	result, err := awaitTLSReload(ctx, plan, triggerErr)
	if err != nil {
		return "", err
	}
	if result.Status == tlsReloadStatusReloaded {
		m.mu.Lock()
		if unchanged() {
			current, _ := m.loadRecord(id)
			current.TLSCertificateID = input.TLSCertificateID
			err = m.saveRecord(current)
		}
		m.mu.Unlock()
		if err != nil {
			return "", err
		}
	}
	return jsonString(result)
}

// handleTLSProbe reports the certificate the engine serves; the probe runs
// without the manager lock.
func (m *managedDatabaseManager) handleTLSProbe(ctx context.Context, id string) (string, error) {
	m.mu.Lock()
	record, err := m.loadRecord(id)
	m.mu.Unlock()
	if err != nil {
		return "", err
	}
	served, err := m.probeTLS(ctx, record)
	if err != nil {
		return "", fmt.Errorf("probe managed database TLS: %w", err)
	}
	return jsonString(served)
}

// tlsReloadPlan validates the running engine and builds its reload plan
// (without a restart step; each caller supplies its own).
func (m *managedDatabaseManager) tlsReloadPlan(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand, leaf servedCertificate, allowRestart bool) (tlsReloadPlan, error) {
	if !record.TLSEnabled {
		return tlsReloadPlan{}, errors.New("managed database TLS is not enabled; enable it with an update")
	}
	if input.Type != record.Type {
		return tlsReloadPlan{}, errors.New("managed database engine cannot be changed")
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.Config == nil || inspect.Container.State == nil || !inspect.Container.State.Running {
		return tlsReloadPlan{}, errors.New("managed database container is not running")
	}
	if inspect.Container.State.Paused {
		return tlsReloadPlan{}, errors.New("managed database is paused")
	}
	if inspect.Container.Config.Labels[managedDatabaseLabel] != record.ID {
		return tlsReloadPlan{}, errors.New("managed database container ownership mismatch")
	}
	containerID := record.ContainerID
	snapshot := *record
	return tlsReloadPlan{
		Expected:     leaf.FingerprintSHA256,
		Method:       managedDatabaseTLSReloadMethod(record.Type),
		Stage:        func() error { return writeManagedDatabaseTLS(m.tlsDirectory(snapshot), input) },
		Trigger:      func(ctx context.Context) error { return m.triggerTLSReload(ctx, containerID, input) },
		Probe:        func(ctx context.Context) (servedCertificate, error) { return m.probeTLS(ctx, snapshot) },
		Wait:         managedTLSReloadWait,
		AllowRestart: allowRestart,
	}, nil
}

func managedDatabaseTLSReloadMethod(engine string) string {
	switch engine {
	case "postgres":
		return tlsReloadMethodSignal
	case "redis":
		return tlsReloadMethodConfigSet
	default:
		return tlsReloadMethodSystemReload
	}
}

// triggerTLSReload asks the engine to reread its TLS files. Only fixed engine
// commands are run; passwords travel in the exec environment.
func (m *managedDatabaseManager) triggerTLSReload(ctx context.Context, containerID string, input managedDatabaseCommand) error {
	switch input.Type {
	case "postgres":
		// PID 1 is the postmaster. SIGHUP rereads the configuration and the
		// SSL files; a failed SSL reload keeps the previous context.
		return m.client.KillContainer(ctx, containerID, "SIGHUP")
	case "redis":
		// Setting any TLS parameter rebuilds the TLS context from the current
		// cert, key and CA files; existing connections keep working.
		return m.runManagedDatabaseExec(ctx, containerID,
			[]string{"redis-cli", "--no-auth-warning", "--user", "default", "-p", "6379", "CONFIG", "SET", "tls-cert-file", legacycompat.RunDirPrefix + "tls/cert.pem"},
			"", []string{"REDISCLI_AUTH=" + input.OwnerPassword})
	case "clickhouse":
		return m.runManagedDatabaseExec(ctx, containerID,
			[]string{"clickhouse-client", "--host", "127.0.0.1", "--user", input.OwnerUsername, "--query", "SYSTEM RELOAD CONFIG"},
			"", []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword})
	default:
		return errors.New("unsupported managed database engine")
	}
}

// probeTLS returns the certificate the engine serves on its TLS listener over
// the database's private network.
func (m *managedDatabaseManager) probeTLS(ctx context.Context, record managedDatabaseRecord) (servedCertificate, error) {
	if !record.TLSEnabled {
		return servedCertificate{}, errors.New("managed database TLS is not enabled")
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.Config == nil || inspect.Container.State == nil || !inspect.Container.State.Running || inspect.Container.NetworkSettings == nil {
		return servedCertificate{}, errors.New("managed database container is unavailable")
	}
	if inspect.Container.Config.Labels[managedDatabaseLabel] != record.ID {
		return servedCertificate{}, errors.New("managed database container ownership mismatch")
	}
	endpoint := inspect.Container.NetworkSettings.Networks[record.NetworkName]
	if endpoint == nil || !endpoint.IPAddress.IsValid() {
		return servedCertificate{}, errors.New("managed database private network is unavailable")
	}
	port, protocol := managedDatabaseTLSProbePort(record.Type)
	address := net.JoinHostPort(endpoint.IPAddress.String(), port)
	if m.probeServed != nil {
		return m.probeServed(ctx, address, protocol)
	}
	return probeServedCertificate(ctx, address, protocol)
}

func managedDatabaseTLSProbePort(engine string) (string, string) {
	switch engine {
	case "postgres":
		return "5432", managedTLSProtocolPostgres
	case "redis":
		return "6380", managedTLSProtocolDirect
	default:
		return "8443", managedTLSProtocolDirect
	}
}
