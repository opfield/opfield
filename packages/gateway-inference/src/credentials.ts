import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from './errors.js';
import type { InferenceHarness, OAuthCredential, RuntimeCredential } from './types.js';

const SERVICE = 'net.wiolett.gateway.inference-cli';

export interface CredentialBackend {
  readonly name: string;
  available(): Promise<boolean>;
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface CredentialStore {
  get(profile: string): Promise<OAuthCredential | null>;
  set(profile: string, credential: OAuthCredential): Promise<void>;
  delete(profile: string): Promise<void>;
  getRuntime(profile: string, harness?: InferenceHarness): Promise<RuntimeCredential | null>;
  setRuntime(profile: string, credential: RuntimeCredential, harness?: InferenceHarness): Promise<void>;
  deleteRuntime(profile: string, harness?: InferenceHarness): Promise<void>;
}

type KeyringModule = typeof import('@napi-rs/keyring');

class NativeKeyringBackend implements CredentialBackend {
  readonly name = 'operating system credential store';
  private module?: KeyringModule;

  async available(): Promise<boolean> {
    try {
      this.module = await import('@napi-rs/keyring');
      return true;
    } catch {
      return false;
    }
  }

  async get(account: string): Promise<string | null> {
    try {
      return this.entry(account).getPassword();
    } catch (error) {
      if (/not found|no entry|no matching/i.test(String(error))) return null;
      throw error;
    }
  }

  async set(account: string, value: string): Promise<void> {
    this.entry(account).setPassword(value);
  }

  async delete(account: string): Promise<void> {
    try {
      this.entry(account).deletePassword();
    } catch (error) {
      if (!/not found|no entry|no matching/i.test(String(error))) throw error;
    }
  }

  private entry(account: string) {
    if (!this.module) throw new Error('Native keyring module is unavailable');
    return new this.module.Entry(SERVICE, account);
  }
}

export class FileCredentialBackend implements CredentialBackend {
  readonly name = 'mode-0600 credential file';

  constructor(private readonly file: string) {}

  async available(): Promise<boolean> {
    return true;
  }

  async exists(): Promise<boolean> {
    try {
      const info = await stat(this.file);
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        throw new CliError('INSECURE_CREDENTIAL_FILE', `Credential file permissions must be 0600: ${this.file}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async get(account: string): Promise<string | null> {
    if (!(await this.exists())) return null;
    const values = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    return values[account] ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    const values = (await this.exists())
      ? (JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>)
      : {};
    values[account] = value;
    await this.write(values);
  }

  async delete(account: string): Promise<void> {
    if (!(await this.exists())) return;
    const values = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    delete values[account];
    await this.write(values);
  }

  private async write(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
    await chmod(this.file, 0o600);
  }
}

export interface SecureCredentialStoreOptions {
  allowFileCredentials?: boolean;
  preferFileCredentials?: boolean;
  interactive?: boolean;
  confirmFileFallback?: (file: string) => Promise<boolean>;
}

export class SecureCredentialStore implements CredentialStore {
  constructor(
    private readonly platformBackend: CredentialBackend,
    private readonly fileBackend: FileCredentialBackend,
    private readonly options: SecureCredentialStoreOptions = {}
  ) {}

  static forPlatform(file: string, _secureDirectory: string, options: SecureCredentialStoreOptions = {}) {
    return new SecureCredentialStore(new NativeKeyringBackend(), new FileCredentialBackend(file), options);
  }

  async get(profile: string): Promise<OAuthCredential | null> {
    const encoded = await this.withFallback('get', `oauth:${profile}`);
    if (!encoded) return null;
    try {
      return JSON.parse(encoded) as OAuthCredential;
    } catch (error) {
      throw new CliError('CREDENTIAL_INVALID', 'Stored Opfield credentials are unreadable.', { cause: error });
    }
  }

  async set(profile: string, credential: OAuthCredential): Promise<void> {
    await this.withFallback('set', `oauth:${profile}`, JSON.stringify(credential));
  }

  async delete(profile: string): Promise<void> {
    await this.withFallback('delete', `oauth:${profile}`);
  }

  async getRuntime(profile: string, harness: InferenceHarness = 'codex'): Promise<RuntimeCredential | null> {
    const encoded = await this.withFallback('get', runtimeAccount(profile, harness));
    if (!encoded) return null;
    try {
      return JSON.parse(encoded) as RuntimeCredential;
    } catch (error) {
      throw new CliError('RUNTIME_CREDENTIAL_INVALID', 'Stored Opfield runtime credential is unreadable.', {
        cause: error,
      });
    }
  }

  async setRuntime(
    profile: string,
    credential: RuntimeCredential,
    harness: InferenceHarness = credential.harness
  ): Promise<void> {
    await this.withFallback('set', runtimeAccount(profile, harness), JSON.stringify(credential));
  }

  async deleteRuntime(profile: string, harness: InferenceHarness = 'codex'): Promise<void> {
    await this.withFallback('delete', runtimeAccount(profile, harness));
  }

  private async withFallback(operation: 'get', profile: string): Promise<string | null>;
  private async withFallback(operation: 'set', profile: string, value: string): Promise<void>;
  private async withFallback(operation: 'delete', profile: string): Promise<void>;
  private async withFallback(operation: 'get' | 'set' | 'delete', profile: string, value?: string) {
    const fileExists = await this.fileBackend.exists();
    if (this.options.preferFileCredentials) {
      if (operation === 'get') return fileExists ? this.fileBackend.get(profile) : null;
      if (operation === 'set') return this.fileBackend.set(profile, value!);
      return fileExists ? this.fileBackend.delete(profile) : undefined;
    }
    try {
      if (await this.platformBackend.available()) {
        if (operation === 'get') {
          const stored = await this.platformBackend.get(profile);
          return stored ?? (fileExists ? this.fileBackend.get(profile) : null);
        }
        if (operation === 'set') {
          await this.platformBackend.set(profile, value!);
          if (fileExists) await this.fileBackend.delete(profile);
          return;
        }
        await this.platformBackend.delete(profile);
        if (fileExists) await this.fileBackend.delete(profile);
        return;
      }
    } catch (error) {
      if (!fileExists && operation === 'set' && !(await this.allowFallback())) {
        throw new CliError('SECURE_CREDENTIAL_STORE_UNAVAILABLE', `${this.platformBackend.name} is unavailable.`, {
          cause: error,
        });
      }
    }

    if (!fileExists && operation !== 'set') return operation === 'get' ? null : undefined;
    if (!fileExists && !(await this.allowFallback())) {
      throw new CliError(
        'SECURE_CREDENTIAL_STORE_UNAVAILABLE',
        'No operating-system credential store is available, and file credential storage was not approved.'
      );
    }
    if (operation === 'get') return this.fileBackend.get(profile);
    if (operation === 'set') return this.fileBackend.set(profile, value!);
    return this.fileBackend.delete(profile);
  }

  private async allowFallback(): Promise<boolean> {
    if (this.options.allowFileCredentials) return true;
    if (!this.options.interactive) return false;
    return this.options.confirmFileFallback?.('') ?? false;
  }
}

function runtimeAccount(profile: string, harness: InferenceHarness): string {
  return harness === 'codex' ? `runtime:${profile}` : `runtime:${profile}:${harness}`;
}
