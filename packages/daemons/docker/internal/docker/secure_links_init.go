package docker

import (
	"context"
	"fmt"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

// initProxySecureLinks starts the proxy Secure Link manager and restores its
// committed bindings, with the egress listeners of the persisted relay grant
// bundle (the connector serves both).
func (p *DockerPlugin) initProxySecureLinks() error {
	secureLinks, err := newDockerSecureLinkManager(p)
	if err != nil {
		return fmt.Errorf("initialize proxy secure links: %w", err)
	}
	p.secureLinks = secureLinks
	p.secureLinkState, err = securelink.NewStateStore(p.cfg.StateDir)
	if err != nil {
		return fmt.Errorf("initialize proxy secure-link state: %w", err)
	}
	// In the control directory newDockerSecureLinkManager prepared (or set aside after a mode switch), before the
	// connector is started: its egress listeners connect here.
	if err := p.startSecureLinkEgressSocket(); err != nil {
		return err
	}
	if p.relayGrants != nil {
		p.secureLinks.setDesiredEgress(p.relayGrants.get())
	}
	if p.client != nil {
		// Consumers of a database link served by the connector resolve its alias through Docker's DNS (C6).
		p.client.databaseLinkOnConnector = p.databaseLinkOnConnector
	}
	pending, hasPending, pendingErr := p.secureLinkState.Pending()
	if pendingErr != nil {
		return fmt.Errorf("read pending proxy secure-link state: %w", pendingErr)
	}
	restored := p.secureLinkState.Get()
	egressApplied := false
	if hasPending && len(pending.Bindings) == 0 {
		// An interrupted last-link teardown must win over the older committed
		// snapshot; otherwise restart would recreate the connector that the
		// cleanup had already removed (it stays for egress).
		if cleanupErr := p.secureLinks.releaseIngress(context.Background()); cleanupErr != nil {
			p.logger.Warn("proxy secure-link pending cleanup deferred", "error", cleanupErr)
		} else if commitErr := p.secureLinkState.Commit(pending); commitErr != nil {
			return fmt.Errorf("commit pending proxy secure-link cleanup: %w", commitErr)
		}
		egressApplied = true
	} else if len(restored.Bindings) > 0 {
		statuses, restoreErr := p.secureLinks.restore(restored)
		if restoreErr != nil {
			p.logger.Warn("proxy secure-link restore deferred", "error", restoreErr)
		} else {
			egressApplied = true
			if saveErr := p.secureLinkState.Commit(normalizeTargetBindings(restored, statuses)); saveErr != nil {
				return fmt.Errorf("persist restored proxy secure links: %w", saveErr)
			}
		}
	} else if hasPending {
		// No committed bindings means an interrupted first apply or teardown.
		// Empty cleanup discovers any surviving managed connector by name.
		if cleanupErr := p.secureLinks.releaseIngress(context.Background()); cleanupErr != nil {
			p.logger.Warn("proxy secure-link pending cleanup deferred", "error", cleanupErr)
		} else if discardErr := p.secureLinkState.DiscardPending(); discardErr != nil {
			return fmt.Errorf("clear proxy secure-link pending state: %w", discardErr)
		}
		egressApplied = true
	}
	if !egressApplied {
		p.secureLinks.resyncEgress()
	}
	// A connector that starts again (it crashed, dockerd restarted) has no listeners: resync it at once.
	go p.secureLinks.followConnectorStarts(context.Background())
	return nil
}
