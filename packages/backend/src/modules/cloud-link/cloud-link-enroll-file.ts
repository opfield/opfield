import { readFile, rm } from 'node:fs/promises';
import { type OperationLeaseStore, operationLeaseKey } from '@/db/operation-lease.js';
import { createChildLogger } from '@/lib/logger.js';
import { CloudLinkRequestError, type CloudLinkService } from './cloud-link.service.js';
import { cloudBackoffDelay } from './cloud-link-agent.js';

const logger = createChildLogger('CloudLinkEnrollFile');

/** Left by the provisioning of a managed installation (cloud-init) inside the app container. */
export const CLOUD_ENROLL_FILE_PATH = '/var/lib/gateway/cloud-enroll.json';
/** One replica redeems the single-use code. */
const LEASE_KEY = operationLeaseKey('cloud-link', 'enroll-file');

interface EnrollFile {
  code: string;
  portalUrl?: string;
}

type ReadResult = { kind: 'missing' } | { kind: 'unreadable'; error: string } | { kind: 'file'; file: EnrollFile };

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
      },
    };
  } catch {
    return { kind: 'unreadable', error: 'The file is not JSON' };
  }
}

/**
 * Auto-enrolment of a managed installation: on start, an installation that is not enrolled redeems the code its
 * provisioning left in the enrolment file. Retries with backoff while the portal may still accept it (unreachable,
 * rate limited, failing on its side); removes the file once enrolled or once the portal calls the code invalid.
 */
export class CloudLinkEnrollFile {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private current: Promise<void> | null = null;

  constructor(
    private readonly service: CloudLinkService,
    private readonly leases: OperationLeaseStore,
    private readonly path = CLOUD_ENROLL_FILE_PATH,
    private readonly delay: (attempt: number) => number = cloudBackoffDelay
  ) {}

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

  /** One pass; true when another pass is due (a retryable failure, or another replica holds the code). */
  async runOnce(): Promise<boolean> {
    const read = await readEnrollFile(this.path);
    if (read.kind === 'missing') return false;
    if (await this.service.isEnrolled()) return false;
    if (read.kind === 'unreadable') {
      logger.warn('The cloud enrolment file cannot be read', { path: this.path, error: read.error });
      await this.service.recordEnrollFileEvent({ outcome: 'unreadable', path: this.path, error: read.error });
      return false;
    }
    const claim = await this.leases.claim([LEASE_KEY], {});
    if (!claim.acquired) return true;
    try {
      await this.service.connect(
        read.file.code,
        { userId: null },
        {
          source: 'enroll-file',
          ...(read.file.portalUrl ? { portalUrl: read.file.portalUrl } : {}),
          auditRetryableFailure: this.attempt === 0,
        }
      );
      await this.remove('enrolled');
      logger.info('Enrolled with the cloud account from the enrolment file');
      return false;
    } catch (error) {
      if (error instanceof CloudLinkRequestError && error.retryable) {
        logger.warn('Cloud enrolment from the file failed; retrying', { error: error.message, attempt: this.attempt });
        return true;
      }
      const code = error instanceof CloudLinkRequestError ? error.code : 'CLOUD_CONNECT_FAILED';
      if (code === 'CLOUD_CODE_INVALID') {
        await this.remove('code_invalid');
      } else {
        // Wrong installation or another refusal: the file stays for the operator, nothing retries it.
        await this.service.recordEnrollFileEvent({
          outcome: 'refused',
          path: this.path,
          errorCode: code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      logger.warn('The cloud account refused the enrolment file', { code });
      return false;
    } finally {
      await this.leases.release([LEASE_KEY], claim.token).catch(() => undefined);
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

  private async remove(outcome: 'enrolled' | 'code_invalid'): Promise<void> {
    try {
      await rm(this.path, { force: true });
      await this.service.recordEnrollFileEvent({ outcome, path: this.path, removed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Could not remove the cloud enrolment file', { path: this.path, error: message });
      await this.service.recordEnrollFileEvent({ outcome, path: this.path, removed: false, error: message });
    }
  }
}
