package lifecycle

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"github.com/opfield/opfield/daemon-shared/exec"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	"github.com/opfield/opfield/daemon-shared/stream"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
	"google.golang.org/grpc"
)

const maxAsyncCommandHandlers = 4

// Long-running command families get their own bounded slots so they neither
// block the receive loop nor starve each other or the generic handlers. A
// command waits for a free slot of its family until it expires.
const (
	maxAsyncComposeHandlers = 2
	// Managed storage and backup commands keep the one-at-a-time execution
	// they had inline: storage serializes on its manager lock anyway, and
	// the backup runtime is initialized lazily by its first command.
	maxAsyncStorageHandlers = 1
	maxAsyncBackupHandlers  = 1
)

// commandExpiryTolerance is how far past its deadline a command may arrive,
// on the Opfield clock, before it is dropped. It absorbs delivery jitter.
const commandExpiryTolerance = 5 * time.Second

const registrationRejectedCommandID = "__registration_rejected__"

// RegistrationRejectedError reports that Opfield terminally rejected this
// daemon's registration (for example the node was removed). Retrying quickly
// cannot succeed, so the daemon backs off for a long time instead.
type RegistrationRejectedError struct {
	Message string
}

func (e *RegistrationRejectedError) Error() string {
	return "registration rejected by Opfield: " + e.Message
}

// asyncCommandPool bounds concurrent handlers for one command family. A pool
// that waits queues commands for a slot; otherwise a full pool rejects.
type asyncCommandPool struct {
	slots chan struct{}
	wait  bool
}

func newAsyncCommandPool(size int, wait bool) *asyncCommandPool {
	return &asyncCommandPool{slots: make(chan struct{}, size), wait: wait}
}

// commandClock judges command deadlines on the Opfield clock, so a host whose
// clock is off does not drop commands. Opfield stamps each command with
// its send time. The smallest (local receive - Opfield send) seen in a session
// is the clock offset plus the fastest delivery; subtracting it from local time
// estimates the Opfield clock, late only by the extra delay a command incurred.
// Local time advances on the monotonic clock so a wall clock step on this host
// during the session does not move the estimate.
type commandClock struct {
	base     time.Time
	mu       sync.Mutex
	minDelta int64
	seen     bool
}

func newCommandClock() *commandClock {
	return &commandClock{base: time.Now()}
}

func (c *commandClock) localUnixMs(now time.Time) int64 {
	return c.base.UnixMilli() + now.Sub(c.base).Milliseconds()
}

// observe records a received command. Call it for every command, before its
// deadline is checked, with the time it was received.
func (c *commandClock) observe(cmd *pb.OpfieldCommand, receivedAt time.Time) {
	sentAt := cmd.GetSentAtUnixMs()
	if sentAt <= 0 {
		return
	}
	delta := c.localUnixMs(receivedAt) - sentAt
	c.mu.Lock()
	if !c.seen || delta < c.minDelta {
		c.minDelta = delta
		c.seen = true
	}
	c.mu.Unlock()
}

// remaining returns how long cmd may still wait before it expires, including
// the tolerance. It is false when the command has no deadline or no send
// time: an older Opfield's deadline can only be compared against this host's
// clock, which is unsafe, so such commands never expire.
func (c *commandClock) remaining(cmd *pb.OpfieldCommand, now time.Time) (time.Duration, bool) {
	expiresAt, sentAt := cmd.GetExpiresAtUnixMs(), cmd.GetSentAtUnixMs()
	if expiresAt <= 0 || sentAt <= 0 {
		return 0, false
	}
	c.mu.Lock()
	minDelta, seen := c.minDelta, c.seen
	c.mu.Unlock()
	if !seen {
		return 0, false
	}
	opfieldNow := c.localUnixMs(now) - minDelta
	return time.Duration(expiresAt-opfieldNow)*time.Millisecond + commandExpiryTolerance, true
}

func (c *commandClock) expired(cmd *pb.OpfieldCommand, now time.Time) bool {
	remaining, ok := c.remaining(cmd, now)
	return ok && remaining < 0
}

// buildRegistration returns the registration the session sends: the plugin's
// message plus the markers the shared lifecycle owns (protected mode, disabled
// host access, launcher features). Each capability is listed once, even when
// the plugin already reports one the lifecycle adds (the relay supervisor
// reports protected mode in its runtime status too).
func (d *DaemonBase) buildRegistration() *pb.RegisterMessage {
	regMsg := d.plugin.BuildRegisterMessage(d.state.NodeID)
	protectRegistration(d.protected, regMsg)
	regMsg.Capabilities = append(regMsg.Capabilities, protectedCapabilities(d.protected)...)
	regMsg.Capabilities = append(regMsg.Capabilities, d.cfg.hostAccessCapabilities()...)
	if d.cfg.Console.IsEnabled() && exec.AgentSandboxSupported() {
		regMsg.Capabilities = append(regMsg.Capabilities, exec.AgentConsoleSandboxCapability)
	}
	if d.consoleUserRefusal != "" {
		regMsg.Capabilities = append(regMsg.Capabilities, NodeConsoleUserUnavailableCapability)
	}
	regMsg.Capabilities = append(regMsg.Capabilities, CommandResultsResentCapability, OpfieldNextAddressCapability)
	launcher := LauncherFeatures()
	regMsg.Capabilities = append(regMsg.Capabilities, launcher.Capabilities()...)
	regMsg.Capabilities = uniqueCapabilities(regMsg.Capabilities)
	regMsg.LauncherVersion = launcher.Version
	regMsg.ProcessInstanceId = processInstanceID
	return regMsg
}

// uniqueCapabilities drops repeated capabilities, keeping the first
// occurrence of each in order.
func uniqueCapabilities(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	unique := values[:0]
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		unique = append(unique, value)
	}
	return unique
}

// runSession connects to Opfield, registers, and runs the command loop.
func runSession(ctx context.Context, conn *grpc.ClientConn, d *DaemonBase) error {
	// Enable log streaming by default — backend can disable via SetDaemonLogStream command
	stream.SetDaemonLogStreaming(true, "info")

	cmdStream, err := connector.OpenCommandStream(ctx, conn)
	if err != nil {
		return err
	}

	// Wrap stream for thread-safe Send calls
	writer := stream.NewWriter(cmdStream)

	// Send registration message
	regMsg := d.buildRegistration()
	if err := writer.Send(&pb.DaemonMessage{
		Payload: &pb.DaemonMessage_Register{Register: regMsg},
	}); err != nil {
		return err
	}

	d.logger.Info("connected to Opfield", "node_id", d.state.NodeID)

	// Install gRPC log forwarder so daemon logs are streamed to Opfield
	sessionLogger := slog.New(stream.NewGrpcLogHandlerWithWriter(writer, d.baseHandler))
	d.logger = sessionLogger
	// Update plugin's logger so its logs also forward to gRPC
	d.plugin.SetLogger(sessionLogger)

	// Notify plugin of session start
	sessionCtx, sessionCancel := context.WithCancel(ctx)
	defer sessionCancel()
	var registrationChanged <-chan struct{}
	if refresher, ok := d.plugin.(RegistrationRefreshPlugin); ok {
		registrationChanged = refresher.RegistrationChanged()
	}
	go func() {
		select {
		case <-sessionCtx.Done():
		case <-d.controlReconnect:
			d.logger.Info("reconnecting control session to present the renewed certificate")
			_ = conn.Close()
		case <-registrationChanged:
			d.logger.Info("reconnecting control session to refresh the node capabilities")
			_ = conn.Close()
		case <-d.launcherChanged:
			d.logger.Info("reconnecting control session to report the launcher that updated itself")
			_ = conn.Close()
		case plan := <-afterUpdateRestarts:
			// launcher_after_update.go: the session ends, and the daemon
			// restarts its whole service.
			d.afterUpdateRestart.Store(plan)
			_ = conn.Close()
		}
	}()

	// Create shared node-level exec manager for host console
	nodeExecMgr := exec.NewManager(d.logger, writer)
	defer nodeExecMgr.CloseAll()

	if err := d.plugin.OnSessionStart(sessionCtx, writer); err != nil {
		d.logger.Warn("plugin session start failed", "error", err)
	}
	defer d.plugin.OnSessionEnd()

	if logStreamer, ok := d.plugin.(LogStreamPlugin); ok {
		go logStreamer.RunLogStream(sessionCtx, conn)
	}
	if migrationStreamer, ok := d.plugin.(MigrationStreamPlugin); ok {
		go migrationStreamer.RunMigrationStream(sessionCtx, conn, d.state.NodeID)
	}
	// Async results go through the outbox: one produced while the control session reconnects (or whose send fails as
	// the session ends) is delivered once the next session is accepted, and Opfield keeps its command pending
	// meanwhile (CommandResultsResentCapability).
	defer d.results.detach(writer)
	sendAsyncResult := func(result *pb.CommandResult, what string) {
		failed, kept, err := d.results.send(result, time.Now())
		if kept {
			d.logger.Info("keeping "+what+" for the next control session", "command_id", result.CommandId, "error", err)
		}
		if failed == writer {
			sessionCancel()
			_ = cmdStream.CloseSend()
		}
	}
	clock := newCommandClock()
	genericPool := newAsyncCommandPool(maxAsyncCommandHandlers, false)
	composePool := newAsyncCommandPool(maxAsyncComposeHandlers, true)
	storagePool := newAsyncCommandPool(maxAsyncStorageHandlers, true)
	backupPool := newAsyncCommandPool(maxAsyncBackupHandlers, true)
	// dispatchAsync runs handle off the receive loop. A nil pool runs it
	// immediately without a slot (reserved for short, urgent commands).
	dispatchAsync := func(pool *asyncCommandPool, c *pb.OpfieldCommand, handle func(*pb.OpfieldCommand) *pb.CommandResult) {
		if pool != nil && !pool.wait {
			select {
			case pool.slots <- struct{}{}:
			default:
				go sendAsyncResult(&pb.CommandResult{
					CommandId: c.CommandId,
					Success:   false,
					Error:     "daemon is busy handling long-running commands; retry shortly",
				}, "async command overload result")
				return
			}
		}
		go func() {
			if pool != nil {
				if pool.wait {
					var expired <-chan time.Time
					if remaining, ok := clock.remaining(c, time.Now()); ok {
						timer := time.NewTimer(remaining)
						defer timer.Stop()
						expired = timer.C
					}
					select {
					case pool.slots <- struct{}{}:
					case <-sessionCtx.Done():
						// Opfield keeps the command pending across the reconnect: answer it on the next session.
						sendAsyncResult(&pb.CommandResult{
							CommandId: c.CommandId,
							Success:   false,
							Error:     "the control session ended before the command started; retry",
						}, "unstarted command result")
						return
					case <-expired:
						sendAsyncResult(&pb.CommandResult{
							CommandId: c.CommandId,
							Success:   false,
							Error:     "command expired while waiting for a free handler slot",
						}, "async command expiry result")
						return
					}
				}
				defer func() { <-pool.slots }()
			}
			sendAsyncResult(handle(c), "async command result")
		}()
	}
	sendAsyncCommandResult := func(c *pb.OpfieldCommand, handle func(*pb.OpfieldCommand) *pb.CommandResult) {
		dispatchAsync(genericPool, c, handle)
	}
	var grantSyncs *grantSyncWorker
	if relayPlugin, ok := d.plugin.(RelayTunnelPlugin); ok {
		grantSyncs = newGrantSyncWorker(sessionCtx, &d.grantSyncs, relayPlugin.SyncRelayGrants, func(result *pb.CommandResult) {
			sendAsyncResult(result, "relay grant sync result")
		})
	}
	controlReady := false

	// Start health reporter in background
	go runHealthReporter(sessionCtx, d, writer)

	// Main command loop
	for {
		cmd, err := cmdStream.Recv()
		if err == io.EOF {
			return err
		}
		if err != nil {
			return err
		}
		receivedAt := time.Now()
		clock.observe(cmd, receivedAt)
		if contact, ok := d.plugin.(OpfieldContactPlugin); ok {
			contact.NoteOpfieldContact()
		}

		// Terminal registration rejection: stop this session and back off.
		if cmd.CommandId == registrationRejectedCommandID {
			if ac, ok := cmd.Payload.(*pb.OpfieldCommand_ApplyConfig); ok && ac.ApplyConfig != nil && ac.ApplyConfig.ConfigContent != "" {
				return &RegistrationRejectedError{Message: ac.ApplyConfig.ConfigContent}
			}
			return &RegistrationRejectedError{Message: "no reason given"}
		}

		// Any other command proves Opfield accepted this registration
		// (it always sends SetDaemonLogStream right after Register). A pending
		// daemon update commits only after this.
		if !controlReady {
			controlReady = true
			d.sessionReceivedCommand = true
			d.move.sessionStarted()
			notifyLauncherControlReady(d.logger)
			if err := recordControlSession(d.cfg.StateDir, receivedAt); err != nil {
				d.logger.Warn("could not record the Opfield session for the installer", "error", err)
			}
			if d.tunnelIdentityPending.CompareAndSwap(true, false) {
				d.notifyTunnelIdentityChanged()
			}
			delivered, err := d.results.attach(writer, receivedAt)
			if delivered > 0 {
				d.logger.Info("delivered command results kept across the control reconnect", "results", delivered)
			}
			if err != nil {
				return err
			}
		}

		// A command Opfield already stopped waiting for must not run.
		if clock.expired(cmd, receivedAt) {
			d.logger.Warn("dropping expired Opfield command", "command_id", cmd.CommandId)
			if cmd.CommandId != "" {
				if err := writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_CommandResult{CommandResult: &pb.CommandResult{
						CommandId: cmd.CommandId,
						Success:   false,
						Error:     "command expired before the daemon received it",
					}},
				}); err != nil {
					return err
				}
			}
			continue
		}

		// Protected mode: refuse everything that is not known to be safe, before any handler sees it.
		if refused := refuseProtectedCommand(d.protected, d.plugin, cmd); refused != nil {
			if _, input := cmd.Payload.(*pb.OpfieldCommand_ExecInput); input || cmd.CommandId == "" {
				// Console input is fire-and-forget: there is no session to answer for.
				continue
			}
			d.logger.Warn("refused a command in protected mode", "command_id", cmd.CommandId, "command", commandKind(cmd))
			if failed, _, err := d.results.send(refused, time.Now()); failed != nil {
				return err
			}
			continue
		}

		// Handle RequestHealth and RequestStats inline
		switch cmd.Payload.(type) {
		case *pb.OpfieldCommand_RequestHealth:
			report := collectFullHealth(d)
			writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_HealthReport{HealthReport: report},
			})
			continue
		case *pb.OpfieldCommand_RequestStats:
			report := d.plugin.CollectStats()
			if report != nil {
				writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_StatsReport{StatsReport: report},
				})
			}
			continue
		case *pb.OpfieldCommand_ExecInput:
			// Fire-and-forget: try shared node exec manager first, then fall through to plugin
			if input := cmd.GetExecInput(); input != nil && nodeExecMgr.HasSession(input.ExecId) {
				nodeExecMgr.HandleInput(input.ExecId, input.Data)
			} else {
				d.plugin.HandleCommand(cmd)
			}
			continue
		case *pb.OpfieldCommand_NodeExec:
			// Handle node-level console exec (create/resize)
			sendAsyncCommandResult(cmd, func(c *pb.OpfieldCommand) *pb.CommandResult {
				if refused := refuseDisabledNodeExec(d.cfg, c); refused != nil {
					return refused
				}
				if refused := refuseUnavailableConsoleUser(d.consoleUserRefusal, c); refused != nil {
					return refused
				}
				return handleNodeExec(sessionCtx, nodeExecMgr, c, d.cfg.Console.User)
			})
			continue
		case *pb.OpfieldCommand_NodeFile:
			// Handle node-level filesystem operations in shared lifecycle so all daemon types support them.
			sendAsyncCommandResult(cmd, func(c *pb.OpfieldCommand) *pb.CommandResult {
				if refused := refuseDisabledNodeFile(d.cfg, c); refused != nil {
					return refused
				}
				return handleNodeFile(sessionCtx, c, d.cfg.HostIdentityPath)
			})
			continue
		case *pb.OpfieldCommand_DockerImage,
			*pb.OpfieldCommand_DockerLogs,
			*pb.OpfieldCommand_DockerDeployment,
			*pb.OpfieldCommand_DockerVolume,
			*pb.OpfieldCommand_DockerFile,
			*pb.OpfieldCommand_DockerExec,
			*pb.OpfieldCommand_DockerMigration,
			*pb.OpfieldCommand_DockerDatabase:
			// Long-running Docker I/O must not block the command receive loop.
			sendAsyncCommandResult(cmd, d.plugin.HandleCommand)
			continue
		case *pb.OpfieldCommand_DockerCompose:
			if cmd.GetDockerCompose().GetAction() == "cancel" {
				// Cancellation must reach the executor while the operation it
				// cancels still holds a compose slot.
				dispatchAsync(nil, cmd, d.plugin.HandleCommand)
			} else {
				dispatchAsync(composePool, cmd, d.plugin.HandleCommand)
			}
			continue
		case *pb.OpfieldCommand_DockerStorage:
			dispatchAsync(storagePool, cmd, d.plugin.HandleCommand)
			continue
		case *pb.OpfieldCommand_DockerBackup:
			dispatchAsync(backupPool, cmd, d.plugin.HandleCommand)
			continue
		case *pb.OpfieldCommand_SyncRelayGrants:
			if grantSyncs == nil {
				if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_CommandResult{CommandResult: &pb.CommandResult{
					CommandId: cmd.CommandId, Success: false, Error: "daemon does not support relay grants",
				}}}); err != nil {
					return err
				}
				continue
			}
			// Applied in order on its own worker: the commands behind it are served meanwhile (S6).
			grantSyncs.submit(cmd)
			continue
		case *pb.OpfieldCommand_SyncProxySecureLinks:
			sendAsyncCommandResult(cmd, func(c *pb.OpfieldCommand) *pb.CommandResult {
				result := &pb.CommandResult{CommandId: c.CommandId, Success: true}
				secureLinkPlugin, ok := d.plugin.(ProxySecureLinkPlugin)
				if !ok {
					result.Success = false
					result.Error = "daemon does not support proxy secure links"
				} else if detail, err := secureLinkPlugin.SyncProxySecureLinks(c.GetSyncProxySecureLinks()); err != nil {
					result.Success = false
					result.Error = err.Error()
				} else {
					result.Detail = detail
				}
				return result
			})
			continue
		case *pb.OpfieldCommand_ProbeProxySecureLink:
			sendAsyncCommandResult(cmd, func(c *pb.OpfieldCommand) *pb.CommandResult {
				result := &pb.CommandResult{CommandId: c.CommandId, Success: true}
				secureLinkPlugin, ok := d.plugin.(ProxySecureLinkProbePlugin)
				if !ok {
					result.Success = false
					result.Error = "daemon does not support proxy secure-link probes"
				} else if detail, err := secureLinkPlugin.ProbeProxySecureLink(c.GetProbeProxySecureLink()); err != nil {
					result.Success = false
					result.Error = err.Error()
				} else {
					result.Detail = detail
				}
				return result
			})
			continue
		case *pb.OpfieldCommand_ProbePagesRoute:
			sendAsyncCommandResult(cmd, func(c *pb.OpfieldCommand) *pb.CommandResult {
				result := &pb.CommandResult{CommandId: c.CommandId, Success: true}
				pagesPlugin, ok := d.plugin.(PagesRouteProbePlugin)
				if !ok {
					result.Success = false
					result.Error = "daemon does not support Pages Route probes"
				} else if detail, err := pagesPlugin.ProbePagesRoute(c.GetProbePagesRoute()); err != nil {
					result.Success = false
					result.Error = err.Error()
				} else {
					result.Detail = detail
				}
				return result
			})
			continue
		case *pb.OpfieldCommand_RenewRelayIdentity, *pb.OpfieldCommand_UpdateRelayWorker, *pb.OpfieldCommand_SetRelayServicePort:
			// Relay supervisor work that takes tens of seconds. Handled off the
			// receive loop, so policy pushes and drains for the relay are not
			// queued behind it until they time out.
			sendAsyncCommandResult(cmd, d.plugin.HandleCommand)
			continue
		case *pb.OpfieldCommand_ProbeRelayCandidate:
			sendAsyncCommandResult(cmd, func(c *pb.OpfieldCommand) *pb.CommandResult {
				result := &pb.CommandResult{CommandId: c.CommandId, Success: true}
				probePlugin, ok := d.plugin.(RelayCandidateProbePlugin)
				if !ok {
					result.Success = false
					result.Error = "daemon does not support relay candidate probes"
				} else if detail, err := probePlugin.ProbeRelayCandidate(c.GetProbeRelayCandidate()); err != nil {
					result.Success = false
					result.Error = err.Error()
				} else {
					result.Detail = detail
				}
				return result
			})
			continue
		case *pb.OpfieldCommand_SetOpfieldNextAddress:
			// A small config file edit: answered inline.
			if failed, _, err := d.results.send(d.handleSetOpfieldNextAddress(cmd), time.Now()); failed != nil {
				return err
			}
			continue
		case *pb.OpfieldCommand_UpdateDaemon:
			// Self-update: download new binary, replace it on disk, acknowledge the
			// command to Opfield, then exit so systemd restarts the daemon.
			updateCmd := cmd.GetUpdateDaemon()
			result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
			var serviceRestart *launcherServiceRestart
			if refusal := d.protectedUpdateRefusal(updateCmd.TargetVersion); refusal != "" {
				result.Success = false
				result.Error = refusal
			} else if err := SelfUpdate(
				updateCmd.DownloadUrl,
				updateCmd.TargetVersion,
				updateCmd.Checksum,
				updateCmd.SignedManifest,
				d.plugin.Type(),
				d.logger,
			); err != nil {
				result.Success = false
				result.Error = err.Error()
			} else if serviceRestart = planUpdateRestart(); serviceRestart != nil {
				// A launcher that does not update itself: the update restarts the
				// whole service once, or says why it cannot.
				result.Detail = serviceRestart.detail
				d.logger.Info(serviceRestart.detail, "target_version", updateCmd.TargetVersion)
			}
			sendErr := writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_CommandResult{CommandResult: result},
			})
			if result.Success {
				// The new binary is staged: restart even when the acknowledgement could not be sent (the
				// stream broke during the download). Opfield treats a lost result as "wait for the
				// reconnect", and a daemon that kept running the old binary would refuse every retry
				// while its update stays pending.
				if sendErr != nil {
					d.logger.Warn("self-update staged but the result could not be sent; restarting anyway", "target_version", updateCmd.TargetVersion, "error", sendErr)
				} else {
					d.logger.Info("self-update staged successfully, exiting for restart", "target_version", updateCmd.TargetVersion)
				}
				return &RestartRequestedError{Message: "self-update staged successfully", serviceRestart: serviceRestart}
			}
			if sendErr != nil {
				return sendErr
			}
			d.logger.Error("self-update failed", "target_version", updateCmd.TargetVersion, "error", result.Error)
			continue
		}

		// Process command and send result (kept for the next session when this one just ended).
		result := d.plugin.HandleCommand(cmd)
		if failed, _, err := d.results.send(result, time.Now()); failed != nil {
			return err
		}
	}
}

// runHealthReporter periodically sends health reports to Opfield, and at once when the plugin asks for one.
func runHealthReporter(ctx context.Context, d *DaemonBase, writer *stream.Writer) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	var refresh <-chan struct{}
	if plugin, ok := d.plugin.(HealthRefreshPlugin); ok {
		refresh = plugin.HealthRefreshRequested()
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-refresh:
		}
		report := collectFullHealth(d)
		if err := writer.Send(&pb.DaemonMessage{
			Payload: &pb.DaemonMessage_HealthReport{HealthReport: report},
		}); err != nil {
			d.logger.Debug("failed to send health report", "error", err)
			return
		}
	}
}

// collectFullHealth gathers system metrics and enriches them with plugin-specific data.
func collectFullHealth(d *DaemonBase) *pb.HealthReport {
	var system *pb.HealthReport
	if d.protected {
		system = d.sysReporter.CollectAggregateHealth(nil)
	} else {
		system = d.sysReporter.CollectSystemHealth(nil)
	}
	report := d.plugin.CollectHealth(system)
	if report != nil {
		report.RelayLatencies = relaybridge.Latency.Samples()
		addLegacyNames(report, "paths", LegacyHostPaths())
		if d.cfg.UsesLegacyControlSection() {
			addLegacyNames(report, "config", 1)
		}
	}
	return report
}

// addLegacyNames adds count objects of kind still under their pre-Opfield
// names to report.
func addLegacyNames(report *pb.HealthReport, kind string, count uint32) {
	if count == 0 {
		return
	}
	if report.LegacyNames == nil {
		report.LegacyNames = map[string]uint32{}
	}
	report.LegacyNames[kind] += count
}

// AddLegacyNames is addLegacyNames for plugins.
func AddLegacyNames(report *pb.HealthReport, kind string, count uint32) {
	addLegacyNames(report, kind, count)
}

// Client certificate renewal timing. The node renews once a third of the
// certificate lifetime remains, so an outage of up to that long (about four
// months for a one-year certificate) never forces a re-enrollment.
const (
	certRenewalCheckInterval = time.Hour
	certRenewalRetryBase     = 5 * time.Minute
	certRenewalRetryMax      = time.Hour
	// certRenewalAssumedLifetime is used when the certificate file cannot be
	// parsed and only the expiry recorded in the state is known.
	certRenewalAssumedLifetime = 365 * 24 * time.Hour
)

// clientCertRenewalDue reports whether a certificate valid from notBefore to
// notAfter should be renewed at now: once the remaining lifetime is at most a
// third of the total lifetime. A window that is empty or inverted is due.
func clientCertRenewalDue(notBefore, notAfter, now time.Time) bool {
	lifetime := notAfter.Sub(notBefore)
	if lifetime <= 0 {
		return true
	}
	return notAfter.Sub(now) <= lifetime/3
}

// certRenewalRetryDelay is the wait before the next renewal attempt after
// the given number of consecutive failures: 5m, 10m, 20m, 40m, then 1h.
// It returns 0 when there were no failures.
func certRenewalRetryDelay(failures int) time.Duration {
	if failures <= 0 {
		return 0
	}
	delay := certRenewalRetryBase
	for i := 1; i < failures; i++ {
		delay *= 2
		if delay >= certRenewalRetryMax {
			return certRenewalRetryMax
		}
	}
	return min(delay, certRenewalRetryMax)
}

// loadCertificateValidity returns the validity window of the first
// certificate in the PEM file at path.
func loadCertificateValidity(path string) (notBefore, notAfter time.Time, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			return time.Time{}, time.Time{}, fmt.Errorf("no certificate found in %s", path)
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("parse certificate %s: %w", path, err)
		}
		return cert.NotBefore, cert.NotAfter, nil
	}
}

// clientCertValidityWindow returns the validity window of the client
// certificate at certPath. When the file cannot be parsed it falls back to
// fallbackExpiresAt (unix seconds, from the daemon state) with an assumed
// one-year lifetime. ok is false when neither source knows the expiry.
func clientCertValidityWindow(certPath string, fallbackExpiresAt int64) (notBefore, notAfter time.Time, source string, ok bool, loadErr error) {
	notBefore, notAfter, loadErr = loadCertificateValidity(certPath)
	if loadErr == nil {
		return notBefore, notAfter, "certificate", true, nil
	}
	if fallbackExpiresAt == 0 {
		return time.Time{}, time.Time{}, "", false, loadErr
	}
	notAfter = time.Unix(fallbackExpiresAt, 0)
	return notAfter.Add(-certRenewalAssumedLifetime), notAfter, "state", true, loadErr
}

// runCertRenewal checks the mTLS client certificate hourly and renews it once
// a third of its lifetime remains. Failed attempts are retried with
// exponential backoff (5m doubling up to 1h) until one succeeds.
func runCertRenewal(ctx context.Context, d *DaemonBase) {
	failures := 0
	// pendingExpiresAt is the expiry of a renewed certificate that was saved
	// to disk but not loaded yet; the next attempt only finishes installing it.
	var pendingExpiresAt int64

	timer := time.NewTimer(0) // run immediately
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}

		var err error
		if pendingExpiresAt != 0 {
			err = d.installRenewedClientCert(pendingExpiresAt)
			if err == nil {
				pendingExpiresAt = 0
			}
		} else {
			pendingExpiresAt, err = d.renewClientCertIfDue(ctx)
		}
		if ctx.Err() != nil {
			return
		}

		next := certRenewalCheckInterval
		if err != nil {
			failures++
			next = min(next, certRenewalRetryDelay(failures))
			d.logger.Warn("mTLS cert renewal attempt failed",
				"error", err,
				"consecutive_failures", failures,
				"next_retry", next,
			)
		} else {
			if failures > 0 {
				d.logger.Info("mTLS cert renewal recovered", "previous_failures", failures)
			}
			failures = 0
		}
		timer.Reset(next)
	}
}

// renewClientCertIfDue renews the client certificate when it is due. It
// returns nil when no renewal was needed or it succeeded. When the renewed
// certificate was saved but could not be loaded, it returns its expiry so
// the caller retries only the install step.
func (d *DaemonBase) renewClientCertIfDue(ctx context.Context) (int64, error) {
	notBefore, notAfter, source, ok, loadErr := clientCertValidityWindow(d.cfg.TLS.ClientCert, d.state.GetCertExpiry())
	if !ok {
		d.logger.Debug("cert renewal: client certificate expiry unknown, skipping", "error", loadErr)
		return 0, nil
	}
	if loadErr != nil {
		d.logger.Warn("cert renewal: cannot parse client certificate, using stored expiry with assumed lifetime",
			"error", loadErr,
			"assumed_lifetime", certRenewalAssumedLifetime,
		)
	}
	now := time.Now()
	if !clientCertRenewalDue(notBefore, notAfter, now) {
		return 0, nil
	}

	d.logger.Info("mTLS cert renewal due, renewing",
		"remaining", notAfter.Sub(now).Round(time.Second),
		"lifetime", notAfter.Sub(notBefore).Round(time.Second),
		"expires_at", notAfter.UTC().Format(time.RFC3339),
		"source", source,
	)

	conn, err := d.connector.Connect(ctx)
	if err != nil {
		return 0, fmt.Errorf("connect: %w", err)
	}
	defer conn.Close()

	client := pb.NewNodeEnrollmentClient(conn)
	renewCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	resp, err := client.RenewCertificate(renewCtx, &pb.RenewCertRequest{
		NodeId: d.state.NodeID,
	})
	if err != nil {
		return 0, fmt.Errorf("renew RPC: %w", err)
	}

	if err := d.saveCertificates(nil, resp.ClientCertificate, resp.ClientKey); err != nil {
		return 0, fmt.Errorf("save: %w", err)
	}

	if err := d.installRenewedClientCert(resp.CertExpiresAt); err != nil {
		return resp.CertExpiresAt, err
	}
	return 0, nil
}

// installRenewedClientCert hot-swaps a renewed certificate that is already
// saved to disk, records its expiry and reconnects the control session.
func (d *DaemonBase) installRenewedClientCert(expiresAt int64) error {
	// Hot-swap the TLS credentials
	if err := d.connector.TLSMgr.LoadCredentials(); err != nil {
		return fmt.Errorf("hot-swap: %w", err)
	}

	d.state.SetCertExpiry(expiresAt)
	if err := d.state.Save(); err != nil {
		d.logger.Warn("cert renewal: state save failed", "error", err)
	}
	// Opfield promotes the renewed certificate (and tells relays its
	// fingerprint) when the control session registers with it. Reconnect
	// that session first; the tunnel switches once it is accepted.
	d.requestControlReconnect()
	d.logger.Info("mTLS cert renewed successfully", "expires_at", time.Unix(expiresAt, 0).UTC().Format(time.RFC3339))
	return nil
}

// handleNodeExec handles node-level console commands: the browser console's
// PTY session (create/resize) and agents' one-shot commands (run), which run
// in the agent sandbox without the container runtime (exec.RunAgentCommand).
// Both run as console.user when it is set, as root otherwise.
func handleNodeExec(ctx context.Context, mgr *exec.Manager, cmd *pb.OpfieldCommand, consoleUser string) *pb.CommandResult {
	nodeExec := cmd.GetNodeExec()
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
	sessionKey := nodeConsoleSessionKey(nodeExec.GetSessionKey())

	switch nodeExec.GetAction() {
	case "run":
		runCtx, cancel := context.WithTimeout(ctx, agentCommandTimeout(nodeExec.GetTimeoutSeconds()))
		defer cancel()
		commandResult, err := exec.RunAgentCommand(runCtx, nodeExec.GetCommand(), consoleUser, 128*1024)
		detailJSON, _ := json.Marshal(commandResult)
		result.Detail = string(detailJSON)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "create":
		shell := ""
		if cmds := nodeExec.GetCommand(); len(cmds) > 0 {
			shell = cmds[0]
		}
		execID, isNew, err := mgr.CreatePTYSession(ctx, sessionKey, shell, int(nodeExec.GetRows()), int(nodeExec.GetCols()), consoleUser)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

		// Build detail JSON with exec_id, is_new, and buffered output
		detail := map[string]interface{}{
			"exec_id": execID,
			"is_new":  isNew,
		}
		if !isNew {
			detail["buffer"] = mgr.GetBufferBase64(sessionKey)
		}
		detailJSON, _ := json.Marshal(detail)
		result.Detail = string(detailJSON)

	case "resize":
		// Find the session and resize
		session := mgr.GetSessionByKey(sessionKey)
		if session != nil {
			if err := mgr.Resize(session.ID, int(nodeExec.GetRows()), int(nodeExec.GetCols())); err != nil {
				result.Success = false
				result.Error = err.Error()
			}
		}

	default:
		result.Success = false
		result.Error = "unknown node exec action: " + nodeExec.GetAction()
	}

	return result
}

// Agent console commands run 30 s unless Opfield asks for another limit, up
// to 5 minutes (package installs, long diagnostics).
const (
	defaultAgentCommandTimeout = 30 * time.Second
	maxAgentCommandTimeout     = 5 * time.Minute
)

func agentCommandTimeout(seconds int32) time.Duration {
	if seconds <= 0 {
		return defaultAgentCommandTimeout
	}
	return min(time.Duration(seconds)*time.Second, maxAgentCommandTimeout)
}

func nodeConsoleSessionKey(ownerKey string) string {
	if ownerKey == "" {
		return "node-console"
	}
	return "node-console:" + ownerKey
}

// newSystemReporter creates the system metrics reporter of a daemon: the
// mounts holding its state directory and the plugin's data directories get
// their roles in each health report.
func newSystemReporter(stateDir string, plugin DaemonPlugin) *sysmetrics.SystemReporter {
	reporter := sysmetrics.NewSystemReporter()
	reporter.SetDiskRolePaths(func() sysmetrics.DiskRolePaths { return daemonDiskRolePaths(stateDir, plugin) })
	return reporter
}

// daemonDiskRolePaths is where a daemon keeps its data: its state directory
// plus what the plugin names (see DiskRolePlugin).
func daemonDiskRolePaths(stateDir string, plugin DaemonPlugin) sysmetrics.DiskRolePaths {
	var paths sysmetrics.DiskRolePaths
	if rolePlugin, ok := plugin.(DiskRolePlugin); ok {
		paths = rolePlugin.DiskRolePaths()
	}
	if stateDir != "" {
		paths.StateDirs = append([]string{stateDir}, paths.StateDirs...)
	}
	return paths
}
