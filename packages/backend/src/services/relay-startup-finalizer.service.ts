import type { RelayControlClient, RelayHealthResponse } from '@/grpc/relay-control.client.js';
import {
  type RelayDockerRecoveryService,
  RelayRecoverySafetyError,
  type RelayStartupAction,
} from './relay-docker-recovery.service.js';

export interface RelayStartupFinalizerOptions {
  required: boolean;
  expectedVersion?: string;
  expectedProtocolMajor?: number;
  readinessWaitMs?: number;
  readinessPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Delivers the current policy snapshot to the local relay. */
  syncPolicy?: () => Promise<unknown>;
}

export type RelayStartupFinalizerResult =
  | { status: 'disabled'; action: null }
  | { status: 'active'; action: RelayStartupAction | null; buildVersion: string }
  /** error: the last failure seen on the way (a health probe, the policy delivery, a recovery step). */
  | { status: 'degraded'; action: RelayStartupAction | null; reason: string; error?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RelayStartupFinalizerService {
  private readonly expectedVersion: string;
  private readonly expectedProtocolMajor: number;
  private readonly readinessWaitMs: number;
  private readonly readinessPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastError: string | undefined;

  constructor(
    private readonly client: Pick<RelayControlClient, 'getHealth' | 'reloadIdentity'> | null,
    private readonly recovery: Pick<RelayDockerRecoveryService, 'ensureStarted' | 'recreateExpected'>,
    private readonly options: RelayStartupFinalizerOptions
  ) {
    this.expectedVersion = options.expectedVersion ?? 'dev';
    this.expectedProtocolMajor = options.expectedProtocolMajor ?? 1;
    this.readinessWaitMs = options.readinessWaitMs ?? 20_000;
    this.readinessPollMs = options.readinessPollMs ?? 1_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async finalize(): Promise<RelayStartupFinalizerResult> {
    if (!this.options.required || !this.client) return { status: 'disabled', action: null };

    let action: RelayStartupAction | null = null;
    try {
      // The app may have atomically refreshed the shared service-identity files
      // while the relay kept its external listener and tunnel sessions alive.
      // Apply those files before readiness is evaluated; a missing relay is
      // handled by the normal start/recreate path below.
      await this.client.reloadIdentity().catch((error) => {
        this.lastError = errorMessage(error);
        return false;
      });
      let initial = await this.probe();
      if (initial && this.isExpected(initial)) {
        return { status: 'active', action: null, buildVersion: initial.buildVersion };
      }
      // A relay that answers but is not ready lacks only a current policy: its lease ran out
      // while Opfield was down, or it refused the last one. Deliver it before judging the
      // container; recreating a live relay for that would only drop its sessions.
      if (!initial && this.options.syncPolicy && (await this.probeLive())) {
        await this.options.syncPolicy().catch((error) => {
          this.lastError = errorMessage(error);
        });
        initial = await this.probe();
        if (initial && this.isExpected(initial)) {
          return { status: 'active', action: null, buildVersion: initial.buildVersion };
        }
      }

      if (initial && !this.isExpected(initial)) {
        action = await this.recovery.recreateExpected();
      } else {
        try {
          action = await this.recovery.ensureStarted();
        } catch (error) {
          // A changed, signed relay version intentionally changes the expected
          // image. Only the startup finalizer may replace that owned old image.
          if (!(error instanceof RelayRecoverySafetyError) || error.reason !== 'unexpected_image') throw error;
          action = await this.recovery.recreateExpected();
        }
      }

      let ready = await this.waitForReadiness();
      if (!ready && action === 'already_running') {
        action = await this.recovery.recreateExpected();
        ready = await this.waitForReadiness();
      }
      if (ready && !this.isExpected(ready) && action !== 'recreate') {
        action = await this.recovery.recreateExpected();
        ready = await this.waitForReadiness();
      }
      if (!ready) return { status: 'degraded', action, reason: 'unreachable', ...this.errorDetail() };
      if (!this.isExpected(ready)) {
        return { status: 'degraded', action, reason: 'contract_mismatch' };
      }
      return { status: 'active', action, buildVersion: ready.buildVersion };
    } catch (error) {
      return {
        status: 'degraded',
        action,
        reason: error instanceof RelayRecoverySafetyError ? error.reason : 'unreachable',
        error: errorMessage(error),
      };
    }
  }

  private errorDetail(): { error?: string } {
    return this.lastError ? { error: this.lastError } : {};
  }

  private isExpected(response: RelayHealthResponse): boolean {
    return response.buildVersion === this.expectedVersion && response.protocolMajor === this.expectedProtocolMajor;
  }

  private async waitForReadiness(): Promise<RelayHealthResponse | null> {
    const deadline = Date.now() + this.readinessWaitMs;
    do {
      const response = await this.probe();
      if (response) return response;
      await this.sleep(this.readinessPollMs);
    } while (Date.now() < deadline);
    return null;
  }

  private async probeLive(): Promise<boolean> {
    try {
      return (await this.client!.getHealth(2_000)).liveness === true;
    } catch {
      return false;
    }
  }

  private async probe(): Promise<RelayHealthResponse | null> {
    try {
      const response = await this.client!.getHealth(2_000);
      return response.liveness && response.readiness ? response : null;
    } catch (error) {
      this.lastError = errorMessage(error);
      return null;
    }
  }
}
