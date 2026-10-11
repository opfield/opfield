package daemon

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
)

// Version is set via -ldflags at build time; falls back to "dev".
var Version = "dev"

// stopSessionCloseWait bounds how long a stopping daemon waits, once its
// Secure Link sockets were handed over, for the control session to close
// before it exits. Closing it under traffic took 0.6-1.3 s on the stand, and
// the next process starts only after this one exited: every connection waits
// in the backlog meanwhile, on every Route. An idle session closes within
// milliseconds; a slower close is cut by the exit, as a crash or an update cuts
// it, and Gateway sees the next process register a moment later.
const stopSessionCloseWait = 100 * time.Millisecond

// Daemon wraps the shared DaemonBase with nginx-specific behavior.
type Daemon struct {
	base   *lifecycle.DaemonBase
	plugin *NginxPlugin
	logger *slog.Logger
	// handedOver is closed once a stop handed the Secure Link sockets over.
	handedOver     chan struct{}
	handedOverOnce sync.Once
}

// New creates a new nginx Daemon.
func New(cfg *config.Config, cfgPath string, logger *slog.Logger) (*Daemon, error) {
	// Set shared lifecycle version
	lifecycle.Version = Version

	// Build base config from the nginx config
	baseCfg := &lifecycle.BaseConfig{
		Gateway: lifecycle.GatewayConfig{
			Address:     cfg.Gateway.Address,
			Token:       cfg.Gateway.Token,
			CertSHA256:  cfg.Gateway.CertSHA256,
			NextAddress: cfg.Gateway.NextAddress,
		},
		TLS: lifecycle.TLSConfig{
			CACert:     cfg.TLS.CACert,
			ClientCert: cfg.TLS.ClientCert,
			ClientKey:  cfg.TLS.ClientKey,
		},
		Console:          cfg.Console,
		Files:            cfg.Files,
		StateDir:         cfg.StateDir,
		HostIdentityPath: cfg.HostIdentityPath,
		LogLevel:         cfg.LogLevel,
		LogFormat:        cfg.LogFormat,
	}

	plugin := NewNginxPlugin(cfg)

	base, err := lifecycle.NewDaemonBase(baseCfg, cfgPath, plugin, logger)
	if err != nil {
		return nil, err
	}

	// Give the plugin access to the shared state
	plugin.SetState(base.GetState())

	return &Daemon{
		base:       base,
		plugin:     plugin,
		logger:     logger,
		handedOver: make(chan struct{}),
	}, nil
}

// Run starts the daemon lifecycle. Once a stop handed the Secure Link sockets
// over, it returns as soon as the lifecycle did, or after
// stopSessionCloseWait: nothing this process still closes is worth keeping
// the next one from starting.
func (d *Daemon) Run(ctx context.Context) error {
	stopped, err := runUntilHandedOver(ctx, d.base.Run, d.handedOver, stopSessionCloseWait)
	if !stopped {
		return err
	}
	if d.logger != nil {
		d.logger.Info("shutting down without waiting for the control session to close", "waited", stopSessionCloseWait.String())
	}
	d.plugin.Shutdown()
	return nil
}

// runUntilHandedOver runs run until it returns. Once handedOver is closed it
// waits at most wait more, and reports stopped when run is still running
// then.
func runUntilHandedOver(ctx context.Context, run func(context.Context) error, handedOver <-chan struct{}, wait time.Duration) (stopped bool, err error) {
	result := make(chan error, 1)
	go func() { result <- run(ctx) }()
	select {
	case err := <-result:
		return false, err
	case <-handedOver:
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case err := <-result:
		return false, err
	case <-timer.C:
		return true, nil
	}
}

// HandOverListeners runs once the daemon is asked to stop, before Run's
// context is cancelled: the Secure Link sockets go to the next daemon process
// while this one still reaches Gateway and the relays to finish its requests.
func (d *Daemon) HandOverListeners() {
	d.plugin.HandOverSecureLinks()
	d.handedOverOnce.Do(func() { close(d.handedOver) })
}
