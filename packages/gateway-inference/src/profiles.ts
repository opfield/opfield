import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from './errors.js';

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface GatewayProfile {
  origin: string;
  installationId: string;
  clientId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProfilesState {
  activeProfile?: string;
  profiles: Record<string, GatewayProfile>;
}

const EMPTY_STATE: ProfilesState = { profiles: {} };

export function validateProfileName(name: string): string {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new CliError('INVALID_PROFILE', 'Profile names must be 1-64 letters, numbers, dots, underscores, or dashes.');
  }
  return name;
}

export function normalizeGatewayOrigin(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch (error) {
    throw new CliError('INVALID_GATEWAY_ORIGIN', `Invalid Opfield URL: ${input}`, { cause: error });
  }
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new CliError('INVALID_GATEWAY_ORIGIN', 'Opfield URLs must use HTTPS (HTTP is allowed only for loopback).');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CliError(
      'INVALID_GATEWAY_ORIGIN',
      'Opfield URLs cannot include credentials, query parameters, or fragments.'
    );
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new CliError('INVALID_GATEWAY_ORIGIN', 'Opfield URL must be an origin without a path.');
  }
  return parsed.origin;
}

export class ProfileStore {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(): Promise<{ activeProfile?: string; profiles: Record<string, GatewayProfile> }> {
    const state = await this.read();
    return { activeProfile: state.activeProfile, profiles: structuredClone(state.profiles) };
  }

  async get(name: string): Promise<GatewayProfile | undefined> {
    return (await this.read()).profiles[validateProfileName(name)];
  }

  async getRequired(name: string): Promise<GatewayProfile> {
    const profile = await this.get(name);
    if (!profile) throw new CliError('PROFILE_NOT_FOUND', 'Opfield connection is not configured.');
    return profile;
  }

  async resolveName(requested?: string): Promise<string> {
    if (requested) return validateProfileName(requested);
    return (await this.read()).activeProfile ?? 'default';
  }

  credentialLockFile(name: string): string {
    return `${this.file}.oauth-${validateProfileName(name)}.lock`;
  }

  async upsert(name: string, origin: string, values: { clientId?: string | null } = {}): Promise<GatewayProfile> {
    validateProfileName(name);
    const state = await this.read();
    const existing = state.profiles[name];
    const timestamp = this.now().toISOString();
    const clientId = values.clientId === null ? undefined : (values.clientId ?? existing?.clientId);
    const profile: GatewayProfile = {
      origin: normalizeGatewayOrigin(origin),
      installationId: existing?.installationId ?? randomUUID(),
      ...(clientId ? { clientId } : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    state.profiles[name] = profile;
    state.activeProfile = name;
    await this.write(state);
    return profile;
  }

  async removeClient(name: string): Promise<void> {
    const state = await this.read();
    const profile = state.profiles[name];
    if (!profile) return;
    delete profile.clientId;
    profile.updatedAt = this.now().toISOString();
    await this.write(state);
  }

  private async read(): Promise<ProfilesState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<ProfilesState>;
      if (!parsed.profiles || typeof parsed.profiles !== 'object') throw new Error('Invalid profile state');
      return parsed as ProfilesState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_STATE);
      throw new CliError('PROFILE_STATE_INVALID', 'Opfield connection state is unreadable.', {
        cause: error,
      });
    }
  }

  private async write(state: ProfilesState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
