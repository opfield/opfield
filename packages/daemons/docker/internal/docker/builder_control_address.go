package docker

import (
	"time"

	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

// builderFenceRetry spaces the attempts to apply the builder egress policy
// again after a failure.
var builderFenceRetry = time.Minute

// reapplyBuilderEgressFence runs after the daemon switched its control
// connection to the address Opfield moved to (lifecycle.OnControlAddressChanged).
// A builder fences build steps off the control plane with its egress policy,
// rendered from the Gateway address at Init. Of the two options, applying that
// policy again for the new address or restarting the daemon, this is the
// smaller one: only the egress unit runs again, containerd and BuildKit keep
// running and builds in progress continue, and the daemon's relay tunnels stay
// up. A failure is retried until it succeeds or a newer move replaces it; a
// daemon restart applies the policy from the config file, which already holds
// the new address.
func (p *DockerPlugin) reapplyBuilderEgressFence(address string) {
	if p.builderRuntime == nil {
		return
	}
	for {
		err := p.builderRuntime.ReapplyEgressPolicy(address)
		if err == nil {
			p.logger.Info("builder egress policy applied for the new Opfield address", "address", address)
			return
		}
		p.logger.Error("could not apply the builder egress policy for the new Opfield address; retrying", "address", address, "error", err, "retry_in", builderFenceRetry)
		time.Sleep(builderFenceRetry)
		if lifecycle.ControlAddress(address) != address {
			return
		}
	}
}
