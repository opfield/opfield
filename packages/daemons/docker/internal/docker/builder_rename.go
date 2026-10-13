package docker

import (
	"time"

	builderruntime "github.com/opfield/opfield/docker-daemon/internal/builder"
)

// builderRenameRetry is how often a worker with builds running tries again to
// move its runtime to the Opfield names.
const builderRenameRetry = 30 * time.Second

// switchBuilderToOpfieldNaming moves the builder runtime of a worker set up
// before Opfield to its Opfield names once this start is confirmed, at the
// first moment no build runs; builds that arrive meanwhile wait for it.
func (p *DockerPlugin) switchBuilderToOpfieldNaming() {
	for {
		if p.builderManager.TryPause() {
			break
		}
		time.Sleep(builderRenameRetry)
	}
	err := p.builderRuntime.SwitchToOpfieldNaming()
	config := p.builderRuntime.Config
	p.builderManager.Resume(config, config.Naming.GitAskpassPath())
	if err != nil {
		p.logger.Warn("builder runtime keeps its pre-Opfield names; retried on the next start", "error", err)
		return
	}
	p.logger.Info("builder runtime moved to its Opfield names; its build cache is kept")
}

// legacyBuilderUnits and legacyBuilderPaths count the pre-Opfield builder
// runtime names still on this worker.
func legacyBuilderUnits() uint32 { return builderruntime.LegacyUnits() }
func legacyBuilderPaths() uint32 { return builderruntime.LegacyPaths() }
