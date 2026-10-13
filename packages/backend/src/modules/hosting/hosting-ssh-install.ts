import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import ssh2 from 'ssh2';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import { normalizeIp } from '@/lib/ip-cidr.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { isSshOperationCancelled } from '@/modules/integrations/external-ssh-transport.js';
import { createNodeEnrollmentToken, nodeEnrollmentTokenExpiresAt } from '@/modules/nodes/node-enrollment-token.js';
import type { HostingOperationRow, HostingOperationsService } from './hosting-operations.service.js';
import type { HostingProviderAdapter, HostingResourceSnapshot } from './hosting-provider.types.js';

/** Enrollment tokens sent over the one-time SSH channel are single use and expire quickly. */
export const SSH_INSTALL_TOKEN_TTL_MS = 30 * 60 * 1000;
const SSH_USER = 'root';
const MAX_PROVIDER_KEY_ATTEMPTS = 20;
const MAX_GUEST_KEY_ATTEMPTS = 3;
const KEY_REMOVED = 'OPFIELD_INSTALL_KEY_REMOVED';

/** Private key lives only in the operation's encrypted bootstrap payload, which finish() clears. */
export type SshInstallKey = { privateKey: string; publicKey: string };
type Outcome = {
  phase: 'ready' | 'failed';
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};
/** Persisted in `result.sshInstall`: the TOFU pin and both key cleanups. Never holds key material. */
export interface SshInstallState {
  address?: string;
  hostFingerprint?: string;
  pinnedAt?: string;
  exitCode?: number | null;
  providerKey: 'pending' | 'deleted' | 'failed';
  providerKeyAttempts: number;
  providerKeyError?: string;
  guestKey: 'pending' | 'removed' | 'failed' | 'retained';
  guestKeyAttempts: number;
  /** Set once the installer was sent again after its first session was lost with an Opfield restart. */
  redispatched?: boolean;
  /** Tail of a failed installer's output, without colours or enrollment tokens. */
  diagnostics?: string;
  deferred?: Outcome;
}

export function createSshInstallKey(marker: string): SshInstallKey {
  const pair = ssh2.utils.generateKeyPairSync('ed25519', { comment: marker });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}
const INSTALL_DIAGNOSTICS_MAX_CHARS = 4000;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** The end of a failed installer's output, so the operator sees why without guest access. */
export function installDiagnostics(output: { stdout: string; stderr?: string }): string {
  const text = [output.stdout, output.stderr ?? '']
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .replace(ANSI_ESCAPE, '')
    .replace(/opf_node_[A-Za-z0-9_]+/g, 'opf_node_[redacted]')
    // legacy-name: node enrollment tokens issued before 2.12.1 — remove once 2.12.0 is no longer an update source
    .replace(/gw_node_[A-Za-z0-9_]+/g, 'opf_node_[redacted]')
    .replace(/(--token\s+)\S+/g, '$1[redacted]')
    .trim();
  return text.length > INSTALL_DIAGNOSTICS_MAX_CHARS ? text.slice(-INSTALL_DIAGNOSTICS_MAX_CHARS) : text;
}

/** The operation error for an installer that exited non-zero, naming its last output line. */
export function installFailure(output: { exitCode: number | null; stdout?: string; stderr?: string }): {
  code: string;
  message: string;
} {
  const diagnostics = installDiagnostics({ stdout: output.stdout ?? '', stderr: output.stderr });
  return {
    code: 'HOSTING_INSTALL_FAILED',
    message: `Installation exited with code ${output.exitCode ?? 'unknown'}${
      diagnostics ? `: ${lastDiagnosticLine(diagnostics)}` : ''
    }. Fix the cause, then retry installation on this VM.`,
  };
}

function lastDiagnosticLine(diagnostics: string): string {
  const line =
    diagnostics
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

export function initialSshInstallState(): SshInstallState {
  return { providerKey: 'pending', providerKeyAttempts: 0, guestKey: 'pending', guestKeyAttempts: 0 };
}
function keyBlob(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/)[1] ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new AppError(500, 'HOSTING_SSH_KEY_INVALID', 'Invalid install key');
  return blob;
}
/** Removes exactly this one-time key and prints a sentinel only when it is gone. */
export function sshKeyRemovalCommand(publicKey: string): string {
  const blob = keyBlob(publicKey);
  return [
    'f="$HOME/.ssh/authorized_keys"',
    `if [ -f "$f" ]; then grep -vF '${blob}' "$f" > "$f.opfield" ; cat "$f.opfield" > "$f"; rm -f "$f.opfield"; fi`,
    `if [ ! -f "$f" ] || ! grep -qF '${blob}' "$f"; then echo ${KEY_REMOVED}; fi`,
  ].join('\n');
}
/** The installer runs from a private temp file (it carries the enrollment token), never from stdin. */
export function sshInstallCommand(script: string, publicKey: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return [
    'umask 077',
    'script="$(mktemp)"',
    `printf '%s' '${encoded}' | base64 -d > "$script"`,
    'bash "$script"',
    'status=$?',
    'rm -f "$script"',
    `if [ "$status" -eq 0 ]; then\n${sshKeyRemovalCommand(publicKey)}\nfi`,
    'exit "$status"',
  ].join('\n');
}

/** Rotates the pending node token right before dispatch: 30 minutes, single use (cleared at enrollment). */
export async function rotateSshInstallToken(db: DrizzleClient, nodeId: string): Promise<string> {
  const token = createNodeEnrollmentToken();
  const [node] = await db
    .update(nodes)
    .set({
      enrollmentTokenHash: await bcrypt.hash(token.token, 10),
      enrollmentTokenSelector: token.selector,
      enrollmentTokenExpiresAt: nodeEnrollmentTokenExpiresAt(new Date(), SSH_INSTALL_TOKEN_TTL_MS),
    })
    .where(and(eq(nodes.id, nodeId), eq(nodes.status, 'pending'), isNull(nodes.certificateSerial)))
    .returning({ id: nodes.id });
  if (!node)
    throw new AppError(409, 'HOSTING_NODE_ALREADY_ENROLLED', 'The node already enrolled; no installer was sent');
  return token.token;
}

export function sshInstallState(row: Pick<HostingOperationRow, 'result'>): SshInstallState | null {
  const state = row.result?.sshInstall;
  return state && typeof state === 'object' ? (state as SshInstallState) : null;
}

type Deps = {
  operations: Pick<HostingOperationsService, 'update' | 'dispatch' | 'finish'>;
  ssh: Pick<ExternalSshService, 'readHostKeyForHosting' | 'executeWithKeyForHosting'>;
  audit: Pick<AuditService, 'log'>;
};

/**
 * Installs Opfield on a server created without user data: SSH as root with the operation's one-time key,
 * host key trusted on first use and pinned for the rest of the operation, then both key cleanups.
 */
export class HostingSshInstaller {
  /** Operations whose SSH session runs in this process; a dispatched one missing here lost its session. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: Deps) {}

  isInFlight(operationId: string): boolean {
    return this.inFlight.has(operationId);
  }

  private save(row: HostingOperationRow, state: SshInstallState, patch: Record<string, unknown> = {}) {
    return this.deps.operations.update(row, { ...patch, result: { ...row.result, sshInstall: state } });
  }
  private async audit(row: HostingOperationRow, action: string, details: Record<string, unknown>) {
    await this.deps.audit.log({
      userId: row.actorId ?? null,
      action,
      resourceType: 'hosting-operation',
      resourceId: row.id,
      details: { resourceId: row.resourceId, nodeId: row.nodeId, ...details },
    });
  }
  private wait(row: HostingOperationRow, message: string) {
    return this.deps.operations.update(row, {
      phase: 'provisioning',
      errorCode: 'HOSTING_SSH_INSTALL_WAITING',
      errorMessage: message,
    });
  }

  /** One installation tick on a running server. Anything before `prepare` provably sent nothing. */
  async install(
    row: HostingOperationRow,
    resource: HostingResourceSnapshot,
    key: SshInstallKey,
    script: () => Promise<string>,
    adapter: HostingProviderAdapter,
    signal?: AbortSignal
  ): Promise<HostingOperationRow> {
    let state = sshInstallState(row) ?? initialSshInstallState();
    const direct = resource.addresses.filter((address) => address.direct).map((address) => address.ip);
    const address = direct.find((ip) => !ip.includes(':')) ?? direct[0];
    if (!address) return this.wait(row, 'Waiting for the new server to receive a public address');
    if (state.address && normalizeIp(state.address) !== normalizeIp(address))
      throw new AppError(
        409,
        'HOSTING_SSH_TARGET_CHANGED',
        'The server address changed after its SSH host key was pinned; no installer was sent'
      );
    if (!state.hostFingerprint) {
      let hostFingerprint: string;
      try {
        hostFingerprint = await this.deps.ssh.readHostKeyForHosting(address);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 403) throw error;
        return this.wait(row, 'Waiting for SSH on the new server');
      }
      state = { ...state, address, hostFingerprint, pinnedAt: new Date().toISOString() };
      row = await this.save(row, state);
      await this.audit(row, 'hosting.install.ssh_host_key_pinned', { address, hostFingerprint });
    }
    let output: { exitCode: number | null; stdout: string; stderr?: string };
    this.inFlight.add(row.id);
    try {
      output = await this.deps.ssh.executeWithKeyForHosting({
        address,
        username: SSH_USER,
        privateKey: key.privateKey,
        hostFingerprint: state.hostFingerprint!,
        prepare: async () => {
          const command = sshInstallCommand(await script(), key.publicKey);
          row = await this.deps.operations.update(row, {
            dispatchStartedAt: null,
            errorCode: null,
            errorMessage: null,
          });
          row = await this.deps.operations.dispatch(row, 'installing');
          await this.audit(row, 'hosting.install.ssh_dispatched', { address, hostFingerprint: state.hostFingerprint });
          return command;
        },
        signal,
      });
    } catch (error) {
      this.inFlight.delete(row.id);
      if (isSshOperationCancelled(error)) {
        // Opfield is shutting down and ended the session. Before dispatch nothing was sent. After it,
        // the installer outcome is unknown, exactly as after a crash: the operation stays dispatched
        // and completes when the node enrolls, or fails at its bootstrap deadline.
        if ((error as { sent?: boolean }).sent !== false)
          await this.audit(row, 'hosting.install.ssh_interrupted', { address }).catch(() => undefined);
        return row;
      }
      const code = error instanceof AppError ? error.code : '';
      if ((error as { sent?: boolean }).sent === false && code !== 'HOSTING_SSH_HOST_KEY_MISMATCH')
        return this.wait(
          row,
          `Waiting for SSH login on the new server${error instanceof AppError ? `: ${error.message}` : ''}`
        );
      throw error;
    }
    this.inFlight.delete(row.id);
    const installed = output.exitCode === 0;
    const diagnostics = installed ? undefined : installDiagnostics(output);
    state = {
      ...state,
      exitCode: output.exitCode,
      guestKey: installed ? (output.stdout.includes(KEY_REMOVED) ? 'removed' : 'failed') : 'retained',
      guestKeyAttempts: installed ? 1 : 0,
      diagnostics,
    };
    row = await this.save(row, state);
    await this.audit(row, 'hosting.install.ssh_completed', { exitCode: output.exitCode, guestKey: state.guestKey });
    if (state.guestKey === 'failed') row = await this.removeGuestKey(row, key);
    // finish() owns the key cleanup attempt (and its deferral) for the failure outcome.
    if (!installed) return this.finish(adapter, row, 'failed', undefined, installFailure(output));
    row = await this.releaseProviderKey(row, adapter);
    return this.deps.operations.update(row, { phase: 'installing', dispatchStartedAt: null });
  }

  /** Reconnects only with the pinned host key; never re-trusts a new one. */
  private async removeGuestKey(row: HostingOperationRow, key: SshInstallKey): Promise<HostingOperationRow> {
    const state = sshInstallState(row)!;
    let removed = false;
    try {
      const output = await this.deps.ssh.executeWithKeyForHosting({
        address: state.address!,
        username: SSH_USER,
        privateKey: key.privateKey,
        hostFingerprint: state.hostFingerprint!,
        prepare: async () => sshKeyRemovalCommand(key.publicKey),
      });
      removed = output.exitCode === 0 && output.stdout.includes(KEY_REMOVED);
    } catch {
      removed = false;
    }
    const next = { ...state, guestKey: removed ? 'removed' : 'failed', guestKeyAttempts: state.guestKeyAttempts + 1 };
    row = await this.save(row, next as SshInstallState);
    if (removed) await this.audit(row, 'hosting.install.ssh_guest_key_removed', {});
    return row;
  }

  async releaseProviderKey(row: HostingOperationRow, adapter: HostingProviderAdapter): Promise<HostingOperationRow> {
    const state = sshInstallState(row);
    if (!state || state.providerKey === 'deleted') return row;
    try {
      if (!adapter.releaseInstallKey)
        throw new AppError(409, 'HOSTING_SSH_KEY_CLEANUP_UNSUPPORTED', 'Provider cannot delete install keys');
      const { deleted } = await adapter.releaseInstallKey(`gw-${row.id}`);
      row = await this.save(row, {
        ...state,
        providerKey: 'deleted',
        providerKeyAttempts: state.providerKeyAttempts + 1,
        providerKeyError: undefined,
      });
      await this.audit(row, 'hosting.install.ssh_key_released', { deleted });
      return row;
    } catch (error) {
      const attempts = state.providerKeyAttempts + 1;
      row = await this.save(row, {
        ...state,
        providerKey: 'failed',
        providerKeyAttempts: attempts,
        providerKeyError: error instanceof AppError ? error.message : 'Provider key cleanup failed',
      });
      if (attempts >= MAX_PROVIDER_KEY_ATTEMPTS)
        await this.audit(row, 'hosting.install.ssh_key_cleanup_failed', { attempts });
      return row;
    }
  }

  /**
   * Terminal outcomes wait for the provider key cleanup (bounded). A deferred outcome keeps the operation
   * reconcilable in `unknown` and drops the private key immediately.
   */
  async finish(
    adapter: HostingProviderAdapter | undefined,
    row: HostingOperationRow,
    phase: 'ready' | 'failed',
    result?: Record<string, unknown>,
    error?: { code: string; message: string }
  ) {
    if (sshInstallState(row) && sshInstallState(row)!.providerKey !== 'deleted' && adapter)
      row = await this.releaseProviderKey(row, adapter);
    const state = sshInstallState(row);
    if (!state || state.providerKey === 'deleted' || state.providerKeyAttempts >= MAX_PROVIDER_KEY_ATTEMPTS)
      return this.deps.operations.finish(row, phase, result, error);
    return this.save(
      row,
      { ...state, deferred: { phase, result, error } },
      {
        phase: 'unknown',
        encryptedBootstrap: null,
        errorCode: 'HOSTING_SSH_KEY_CLEANUP_PENDING',
        errorMessage: 'Waiting to delete the one-time SSH install key from the provider account',
      }
    );
  }

  /** Runs first on every tick: deferred outcomes and pending cleanups. `done` stops the tick. */
  async resume(
    row: HostingOperationRow,
    adapter: HostingProviderAdapter,
    key: () => SshInstallKey | undefined
  ): Promise<{ row: HostingOperationRow; done: boolean }> {
    const state = sshInstallState(row);
    if (!state) return { row, done: false };
    if (state.deferred) {
      const outcome = state.deferred;
      row = await this.releaseProviderKey(row, adapter);
      const current = sshInstallState(row)!;
      if (current.providerKey !== 'deleted' && current.providerKeyAttempts < MAX_PROVIDER_KEY_ATTEMPTS)
        return { row, done: true };
      const { deferred: _deferred, ...recorded } = current;
      await this.deps.operations.finish(row, outcome.phase, { ...outcome.result, sshInstall: recorded }, outcome.error);
      return { row, done: true };
    }
    if (state.exitCode !== undefined && state.providerKey !== 'deleted')
      row = await this.releaseProviderKey(row, adapter);
    const installKey = row.encryptedBootstrap ? key() : undefined;
    if (state.guestKey === 'failed' && state.guestKeyAttempts < MAX_GUEST_KEY_ATTEMPTS && installKey)
      row = await this.removeGuestKey(row, installKey);
    return { row, done: false };
  }
}
