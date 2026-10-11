import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { type OperationLeaseStore, operationLeaseKey } from '@/db/operation-lease.js';
import { createChildLogger } from '@/lib/logger.js';
import { LicenseServerRequestError, type LicenseService } from '@/modules/license/license.service.js';
import type { LicenseModuleService } from '@/modules/license/license-module.service.js';
import { type CloudEnrollFileContract, parseCloudEnrollOwner, parseCloudEnrollSso } from './cloud-enroll-contract.js';
import { CloudLinkRequestError, type CloudLinkService } from './cloud-link.service.js';
import { cloudBackoffDelay } from './cloud-link-agent.js';
import type { ManagedSsoInput, ManagedSsoOutcome } from './cloud-link-managed-sso.js';

const logger = createChildLogger('CloudLinkEnrollFile');

/** Left by the provisioning of a managed installation (cloud-init) inside the app container. */
export const CLOUD_ENROLL_FILE_PATH = '/var/lib/gateway/cloud-enroll.json';
/** One replica redeems the single-use code and activates the key. */
const LEASE_KEY = operationLeaseKey('cloud-link', 'enroll-file');

/** The file as read (see CloudEnrollFileContract); a malformed sso or owner is left out. */
type EnrollFile = CloudEnrollFileContract;

/** The Opfield account sign-in of a managed installation (CloudManagedSso). */
export interface EnrollFileSso {
  apply(input: ManagedSsoInput): Promise<ManagedSsoOutcome>;
}

type ReadResult = { kind: 'missing' } | { kind: 'unreadable'; error: string } | { kind: 'file'; file: EnrollFile };

/** How a step of the file ended in one pass: done, refused for good, or worth another try. */
type StepOutcome = ManagedSsoOutcome;

async function readEnrollFile(path: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || typeof value.code !== 'string' || !value.code.trim()) {
      return { kind: 'unreadable', error: 'The file has no code' };
    }
    return {
      kind: 'file',
      file: {
        code: value.code,
        ...(typeof value.portalUrl === 'string' && value.portalUrl.trim() ? { portalUrl: value.portalUrl.trim() } : {}),
        ...(typeof value.licenseKey === 'string' && value.licenseKey.trim()
          ? { licenseKey: value.licenseKey.trim() }
          : {}),
        ...(typeof value.publicUrl === 'string' && value.publicUrl.trim() ? { publicUrl: value.publicUrl.trim() } : {}),
        ...(parseCloudEnrollSso(value.sso) ? { sso: parseCloudEnrollSso(value.sso)! } : {}),
        ...(parseCloudEnrollOwner(value.owner) ? { owner: parseCloudEnrollOwner(value.owner)! } : {}),
      },
    };
  } catch {
    return { kind: 'unreadable', error: 'The file is not JSON' };
  }
}

/** The license side of the file: activation as Settings → General → Update license does it. */
export interface EnrollFileLicense {
  /** Whether this key is active on the installation already (an earlier pass activated it). */
  isActive(licenseKey: string): Promise<boolean>;
  /** Activates the key and prepares the paid module; resolves with the plan. */
  activate(licenseKey: string): Promise<{ plan: string; moduleRestarting: boolean | null; moduleError?: string }>;
  /** Whether the license server may still accept the key later (unreachable, failing on its side, rate limited). */
  isRetryable(error: unknown): boolean;
}

/** Settings → General → Update license: `activateKey`, then the paid module for this version. */
export function createEnrollFileLicense(
  licenseService: Pick<LicenseService, 'activateKey' | 'getStatus'>,
  licenseModule: Pick<LicenseModuleService, 'ensureAvailable'>
): EnrollFileLicense {
  return {
    async isActive(licenseKey) {
      const status = await licenseService.getStatus();
      return status.hasKey && status.licensed && status.keyLast4 === licenseKey.slice(-4);
    },
    async activate(licenseKey) {
      const status = await licenseService.activateKey(licenseKey);
      try {
        const module = await licenseModule.ensureAvailable();
        return { plan: status.plan, moduleRestarting: module.restarting };
      } catch (error) {
        // The key is active; paid features can still be enabled from Settings ("Enable paid features").
        return {
          plan: status.plan,
          moduleRestarting: null,
          moduleError: error instanceof Error ? error.message : String(error),
        };
      }
    },
    isRetryable(error) {
      if (!(error instanceof LicenseServerRequestError)) return true;
      return error.code === 'LICENSE_SERVER_UNAVAILABLE' || error.status >= 500 || error.status === 429;
    },
  };
}

/**
 * Auto-enrolment of a managed installation. On start, the code its provisioning left in the enrolment file enrols an
 * installation that is not enrolled, and the paid license key in it is activated. With `sso` and `owner` in the file,
 * sign-in with the Opfield account is set up first (CloudManagedSso) and the client secret leaves the file. A step
 * that may still succeed is retried with backoff; the file is removed once every step succeeded or was refused for good.
 */
export class CloudLinkEnrollFile {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private current: Promise<void> | null = null;
  /** Steps this process settled already: refused for good is not asked again until the next start. */
  private enrollSettled: StepOutcome | null = null;
  private licenseSettled: StepOutcome | null = null;
  private ssoSettled: StepOutcome | null = null;
  private sso: EnrollFileSso | null = null;

  constructor(
    private readonly service: CloudLinkService,
    private readonly leases: OperationLeaseStore,
    private readonly license: EnrollFileLicense,
    private readonly path = CLOUD_ENROLL_FILE_PATH,
    private readonly delay: (attempt: number) => number = cloudBackoffDelay
  ) {}

  /** Sign-in with the Opfield account from the file's sso and owner; without it they are ignored. */
  setManagedSso(sso: EnrollFileSso): void {
    this.sso = sso;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current?.catch(() => undefined);
  }

  /** One pass; true when another pass is due (a retryable failure, or another replica holds the file). */
  async runOnce(): Promise<boolean> {
    const read = await readEnrollFile(this.path);
    if (read.kind === 'missing') return false;
    if (read.kind === 'unreadable') {
      if (await this.service.isEnrolled()) return false;
      logger.warn('The cloud enrolment file cannot be read', { path: this.path, error: read.error });
      await this.service.recordEnrollFileEvent({ outcome: 'unreadable', path: this.path, error: read.error });
      return false;
    }
    const claim = await this.leases.claim([LEASE_KEY], {});
    if (!claim.acquired) return true;
    try {
      // Sign-in first: it is local, so the owner can sign in while the account or the license server is still away.
      const hasSso = Boolean(this.sso && (read.file.sso || read.file.owner));
      const sso = hasSso ? (this.ssoSettled ?? (await this.applySso(read.file))) : 'done';
      if (sso !== 'retry') {
        this.ssoSettled = sso;
        if (read.file.sso?.clientSecret) await this.removeClientSecret(sso);
      }
      const enroll = this.enrollSettled ?? (await this.enroll(read.file));
      if (enroll !== 'retry') this.enrollSettled = enroll;
      const license = read.file.licenseKey
        ? (this.licenseSettled ?? (await this.activate(read.file.licenseKey)))
        : 'done';
      if (license !== 'retry') this.licenseSettled = license;
      if (sso === 'retry' || enroll === 'retry' || license === 'retry') return true;
      await this.remove({
        enroll,
        license: read.file.licenseKey ? license : 'none',
        ...(hasSso ? { sso } : {}),
      });
      return false;
    } finally {
      await this.leases.release([LEASE_KEY], claim.token).catch(() => undefined);
    }
  }

  private async applySso(file: EnrollFile): Promise<StepOutcome> {
    return this.sso!.apply({
      ...(file.publicUrl ? { publicUrl: file.publicUrl } : {}),
      ...(file.sso ? { sso: file.sso } : {}),
      ...(file.owner ? { owner: file.owner } : {}),
    });
  }

  /**
   * The client secret is stored encrypted (or refused for good): it leaves the file at once, as the other secrets
   * leave with the file, even while enrolment or activation is still retried. Written to a temporary file and renamed,
   * so a crash never leaves a half-written file.
   */
  private async removeClientSecret(outcome: StepOutcome): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      const sso = value.sso as Record<string, unknown> | undefined;
      if (!sso || typeof sso !== 'object' || !('clientSecret' in sso)) return;
      delete sso.clientSecret;
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      await this.service.recordManagedSso({ step: 'secret_removed', path: this.path, outcome });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Could not remove the client secret from the cloud enrolment file', {
        path: this.path,
        error: message,
      });
      await this.service.recordManagedSso({
        step: 'secret_removed',
        path: this.path,
        outcome,
        removed: false,
        error: message,
      });
    }
  }

  private async enroll(file: EnrollFile): Promise<StepOutcome> {
    if (await this.service.isEnrolled()) return 'done';
    try {
      await this.service.connect(
        file.code,
        { userId: null },
        {
          source: 'enroll-file',
          ...(file.portalUrl ? { portalUrl: file.portalUrl } : {}),
          auditRetryableFailure: this.attempt === 0,
        }
      );
      logger.info('Enrolled with the cloud account from the enrolment file');
      return 'done';
    } catch (error) {
      if (error instanceof CloudLinkRequestError && error.retryable) {
        logger.warn('Cloud enrolment from the file failed; retrying', { error: error.message, attempt: this.attempt });
        return 'retry';
      }
      const code = error instanceof CloudLinkRequestError ? error.code : 'CLOUD_CONNECT_FAILED';
      logger.warn('The cloud account refused the enrolment file', { code });
      return 'rejected';
    }
  }

  private async activate(licenseKey: string): Promise<StepOutcome> {
    try {
      if (await this.license.isActive(licenseKey)) return 'done';
      const result = await this.license.activate(licenseKey);
      await this.service.recordLicenseActivation({
        success: true,
        source: 'enroll-file',
        plan: result.plan,
        moduleRestarting: result.moduleRestarting,
        ...(result.moduleError ? { moduleError: result.moduleError } : {}),
      });
      logger.info('License key from the enrolment file activated', { plan: result.plan });
      return 'done';
    } catch (error) {
      const retryable = this.license.isRetryable(error);
      const message = error instanceof Error ? error.message : String(error);
      if (!retryable || this.attempt === 0) {
        await this.service.recordLicenseActivation({
          success: false,
          source: 'enroll-file',
          retryable,
          errorCode: error instanceof LicenseServerRequestError ? error.code : 'LICENSE_ACTIVATION_FAILED',
          error: message.replaceAll(licenseKey, '[REDACTED]'),
        });
      }
      logger.warn(
        retryable
          ? 'License activation from the enrolment file failed; retrying'
          : 'The license server refused the key in the enrolment file',
        {
          code: error instanceof LicenseServerRequestError ? error.code : undefined,
          attempt: this.attempt,
        }
      );
      return retryable ? 'retry' : 'rejected';
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = this.runOnce()
        .catch((error) => {
          logger.warn('Cloud enrolment from the file failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return true;
        })
        .then((again) => {
          if (!again) return;
          const wait = this.delay(this.attempt);
          this.attempt += 1;
          this.schedule(wait);
        })
        .finally(() => {
          this.current = null;
        });
    }, delayMs);
    this.timer.unref?.();
  }

  /** Both steps are settled: the file goes, with what became of each step in the audit. */
  private async remove(outcome: {
    enroll: StepOutcome;
    license: StepOutcome | 'none';
    sso?: StepOutcome;
  }): Promise<void> {
    const details = {
      path: this.path,
      enrollment: outcome.enroll,
      license: outcome.license,
      ...(outcome.sso ? { sso: outcome.sso } : {}),
    };
    try {
      await rm(this.path, { force: true });
      await this.service.recordEnrollFileEvent({ outcome: 'settled', ...details, removed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Could not remove the cloud enrolment file', { path: this.path, error: message });
      await this.service.recordEnrollFileEvent({ outcome: 'settled', ...details, removed: false, error: message });
    }
  }
}
