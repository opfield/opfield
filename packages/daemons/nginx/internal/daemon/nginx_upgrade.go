package daemon

import (
	"context"
	"strings"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
	"github.com/opfield/opfield/nginx-daemon/internal/nginxupgrade"
)

// startNginxUpgrade keeps the host's nginx at nginxupgrade.MinimumVersion once this start is confirmed (an update the
// launcher may still roll back does not touch the host's nginx).
func (p *NginxPlugin) startNginxUpgrade() {
	p.nginxUpgrade = nginxupgrade.New(nginxUpgradeHost{p}, p.logger)
	ctx, cancel := context.WithCancel(context.Background())
	p.nginxUpgradeCancel = cancel
	upgrader := p.nginxUpgrade
	lifecycle.OnStartConfirmed(func() { go upgrader.Run(ctx) })
}

// nginxUpgradeDeferReason: an upgrade waits while the configuration on disk is ahead of what nginx runs (the new
// master would load it unreviewed by a reload) and while the node's own ingress health fails (it may be in a
// failover, and a node that does not serve is no place to change nginx).
func (p *NginxPlugin) nginxUpgradeDeferReason() string {
	if p.mgr.ReloadPending() {
		return "a configuration change waits for its nginx reload"
	}
	if p.ingressHealth != nil {
		if status := p.ingressHealth.current(); !status.Serving {
			return "the node's ingress health check fails: " + strings.Join(status.Reasons, "; ")
		}
	}
	return ""
}

type nginxUpgradeHost struct{ p *NginxPlugin }

func (h nginxUpgradeHost) Version() (string, error) { return h.p.mgr.GetVersion() }

func (h nginxUpgradeHost) DeferReason() string { return h.p.nginxUpgradeDeferReason() }

func (h nginxUpgradeHost) MasterPID() (int, error) { return h.p.mgr.CachedPID() }

func (h nginxUpgradeHost) WithReloadLock(fn func() error) error { return h.p.mgr.WithReloadLock(fn) }

func (h nginxUpgradeHost) Swapped(version string) {
	h.p.mgr.ForgetMasterPID()
	if h.p.reporter != nil && version != "" {
		h.p.reporter.setVersion(version)
	}
	h.p.refreshRegistration()
}
