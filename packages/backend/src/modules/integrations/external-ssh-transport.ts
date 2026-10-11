import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import { AppError } from '@/middleware/error-handler.js';

export const SSH_CONNECT_TIMEOUT_MS = 10_000;
type Sock = Parameters<Client['connect']>[0]['sock'];

export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function limitOutput(current: string, next: string): string {
  return `${current}${next}`.slice(0, 128 * 1024);
}

export function mapSshConnectionError(error: unknown, role: 'jump' | 'target'): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : '';
  const level = (error as { level?: unknown } | null)?.level;
  const connectorLabel = role === 'jump' ? 'jump connector' : 'SSH connector';
  const serverLabel = role === 'jump' ? 'jump server' : 'SSH server';
  if (/cannot parse privatekey|unsupported key format/i.test(message)) {
    return new AppError(
      409,
      role === 'jump' ? 'SSH_JUMP_CREDENTIAL_INVALID' : 'SSH_CREDENTIAL_INVALID',
      `The ${connectorLabel} contains an incompatible private key. Recreate it and install the newly generated public key.`
    );
  }
  if (level === 'client-authentication' || /authentication methods failed|permission denied/i.test(message)) {
    return new AppError(
      401,
      role === 'jump' ? 'SSH_JUMP_AUTHENTICATION_FAILED' : 'SSH_AUTHENTICATION_FAILED',
      `Opfield could not authenticate to the ${serverLabel}. Check that the configured password or generated public key is installed for the SSH user, then try again.`
    );
  }
  return new AppError(
    502,
    role === 'jump' ? 'SSH_JUMP_CONNECTION_FAILED' : 'SSH_CONNECTION_FAILED',
    `Opfield could not connect to the ${serverLabel} with the configured SSH credential.`
  );
}

export function readHostFingerprint(host: string, port: number, sock?: Sock, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new AppError(499, 'SSH_OPERATION_CANCELLED', 'SSH host-key check was cancelled'));
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    client.once('error', fail);
    client.connect({
      host,
      port,
      username: 'gateway-host-key-probe',
      ...(sock ? { sock } : {}),
      hostVerifier: (key: Buffer) => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', abort);
          resolve(fingerprint(key));
        }
        queueMicrotask(() => client.end());
        return false;
      },
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    });
  });
}

export function forwardThroughJump(
  client: Client,
  targetAddress: string,
  port: number,
  signal?: AbortSignal
): Promise<Sock> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, socket?: Sock) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (socket) resolve(socket);
    };
    const abort = () => finish(new AppError(499, 'SSH_OPERATION_CANCELLED', 'SSH operation was cancelled'));
    const timeout = setTimeout(
      () => finish(new AppError(504, 'SSH_CONNECT_TIMEOUT', 'SSH connection timed out after 10 seconds')),
      SSH_CONNECT_TIMEOUT_MS
    );
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    client.forwardOut('127.0.0.1', 0, targetAddress, port, (error, socket) => finish(error ?? undefined, socket));
  });
}

export function isSshOperationCancelled(error: unknown): boolean {
  return error instanceof AppError && error.code === 'SSH_OPERATION_CANCELLED';
}

/**
 * Runs one command. An abort ends the session at once and rejects with SSH_OPERATION_CANCELLED;
 * the remote command may or may not have run, so callers treat it as dispatched.
 */
export function execOnClient(client: Client, command: string, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      finish();
    };
    const cancel = () =>
      settle(() => {
        client.end();
        reject(new AppError(499, 'SSH_OPERATION_CANCELLED', 'SSH command was cancelled'));
      });
    if (signal?.aborted) return cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    client.exec(command, (error, channel) => {
      if (error) return settle(() => reject(error));
      let stdout = '';
      let stderr = '';
      channel.on('data', (chunk: Buffer) => (stdout = limitOutput(stdout, chunk.toString())));
      channel.stderr.on('data', (chunk: Buffer) => (stderr = limitOutput(stderr, chunk.toString())));
      channel.on('close', (code: number | null) => settle(() => resolve({ stdout, stderr, exitCode: code })));
    });
  });
}

/** Authenticates with a private key against exactly one pinned host key; never trusts a new key here. */
export function connectWithKey(input: {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  hostFingerprint: string;
}): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let hostKeyChanged = false;
    client.once('ready', () => resolve(client));
    client.once('error', (error) =>
      reject(
        hostKeyChanged
          ? new AppError(
              409,
              'HOSTING_SSH_HOST_KEY_MISMATCH',
              'The server presented a different SSH host key than the one pinned on first use; nothing was sent'
            )
          : error
      )
    );
    client.connect({
      host: input.host,
      port: input.port,
      username: input.username,
      privateKey: input.privateKey,
      hostVerifier: (key: Buffer) => {
        hostKeyChanged = fingerprint(key) !== input.hostFingerprint;
        return !hostKeyChanged;
      },
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    });
  });
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('127.')) return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const halves = normalized.split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const dotted = right.at(-1)?.includes('.') ? right.pop() : left.at(-1)?.includes('.') ? left.pop() : undefined;
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    right.push(((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16));
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return false;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((word) =>
    Number.parseInt(word, 16)
  );
  return (
    words.length === 8 &&
    words.slice(0, 5).every((word) => word === 0) &&
    words[5] === 0xffff &&
    (words[6] ?? 0) >> 8 === 127
  );
}
