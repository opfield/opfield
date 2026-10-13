package docker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	runtimemanager "github.com/opfield/opfield/docker-daemon/internal/runtime"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
)

// Secure Runtime (runsc) verification at daemon start.
//
// The Docker smoke test starts six gVisor containers one after another and
// takes about 8 s. Run inside Init it held back the Gateway connection and so
// the relay endpoint registrations: every workload on a node with Secure
// Runtime installed was unreachable for those 8 s after each daemon restart,
// including every automatic daemon update (rc.20 N-9). The daemon now connects
// first and verifies in the background. Until the verification finishes it
// reports the last verified result for the same installed runsc version, so a
// runtime that worked before a restart stays usable across it; without one it
// reports the verification as pending.

const (
	runtimeStatusFileName      = "runtime-status.json"
	runtimeVerificationTimeout = 90 * time.Second
)

// runtimeVerifier is the part of the runsc manager the start-up verification uses.
type runtimeVerifier interface {
	PreflightWithoutSmokeTest(ctx context.Context) (runtimemanager.Status, bool)
	VerifyRuntime(ctx context.Context, pending runtimemanager.Status) runtimemanager.Status
}

// startRuntimeVerification records the Secure Runtime status without waiting
// for the Docker smoke test; the returned channel closes once the status is
// final.
func (p *DockerPlugin) startRuntimeVerification(ctx context.Context, verifier runtimeVerifier) <-chan struct{} {
	done := make(chan struct{})
	pending, verify := verifier.PreflightWithoutSmokeTest(ctx)
	if !verify {
		p.setRuntimeStatus(pending)
		close(done)
		return done
	}
	gen := p.setRuntimeStatus(p.provisionalRuntimeStatus(pending))
	go func() {
		defer close(done)
		verifyCtx, cancel := context.WithTimeout(context.Background(), runtimeVerificationTimeout)
		defer cancel()
		verified := verifier.VerifyRuntime(verifyCtx, pending)
		if !p.replaceRuntimeStatus(gen, verified) {
			return
		}
		if p.logger != nil {
			p.logger.Info("Secure Runtime verified", "state", verified.State, "reason", verified.ReasonCode)
		}
	}()
	return done
}

// provisionalRuntimeStatus is what the node reports while its smoke test runs:
// the last verified healthy result for the same runsc, else the pending status.
func (p *DockerPlugin) provisionalRuntimeStatus(pending runtimemanager.Status) runtimemanager.Status {
	last, ok := p.loadVerifiedRuntimeStatus()
	if ok && last.State == runtimemanager.StateHealthy && last.InstalledVersion != "" &&
		last.InstalledVersion == pending.InstalledVersion && last.TargetVersion == pending.TargetVersion {
		return last
	}
	return pending
}

func (p *DockerPlugin) runtimeStatusPath() string {
	if p.cfg == nil || p.cfg.StateDir == "" {
		return ""
	}
	return filepath.Join(p.cfg.StateDir, runtimeStatusFileName)
}

func (p *DockerPlugin) loadVerifiedRuntimeStatus() (runtimemanager.Status, bool) {
	path := p.runtimeStatusPath()
	if path == "" {
		return runtimemanager.Status{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return runtimemanager.Status{}, false
	}
	var status runtimemanager.Status
	if json.Unmarshal(data, &status) != nil {
		return runtimemanager.Status{}, false
	}
	return status, true
}

// persistVerifiedRuntimeStatus keeps the last final status for the next start.
// Pending and in-progress states are not results and are never kept.
func (p *DockerPlugin) persistVerifiedRuntimeStatus(status runtimemanager.Status) {
	if status.State == runtimemanager.StateInstalling || status.ReasonCode == "verification_pending" {
		return
	}
	path := p.runtimeStatusPath()
	if path == "" {
		return
	}
	data, err := json.Marshal(status)
	if err != nil {
		return
	}
	if err := atomicfile.WriteFile(path, data, 0o600); err != nil {
		p.logRuntimeStatusPersistError(err)
	}
}

func (p *DockerPlugin) logRuntimeStatusPersistError(err error) {
	if p.logger != nil {
		p.logger.Warn("Secure Runtime status could not be kept for the next start", "error", err)
	}
}
