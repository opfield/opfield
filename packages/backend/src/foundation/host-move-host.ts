import { chmod, lstat, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DOCKER_COMPOSE_CLI_IMAGE_REF } from '@/config/docker-compose-cli-image.js';
import { DockerService } from '@/services/docker.service.js';
import type { ClickHouseSpec, HostMoveHost, NetworkMember, ServiceContainer } from './host-move.js';

const DOCKER_SOCKET = '/var/run/docker.sock';
const API = '/v1.46';

interface RawContainer {
  Id: string;
  Name: string;
  Config: { Image: string; Env?: string[]; Labels?: Record<string, string> };
  State: { Running: boolean; Status: string; Health?: { Status: string } };
  HostConfig: {
    Binds?: string[] | null;
    RestartPolicy?: { Name?: string };
    LogConfig?: { Type: string; Config?: Record<string, string> };
  };
  NetworkSettings: { Networks?: Record<string, { Aliases?: string[] | null }> };
}

function dockerRequest(method: string, apiPath: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: `${API}${apiPath}`,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        timeout: 5 * 60_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    request.on('timeout', () => request.destroy(new Error(`Docker API ${method} ${apiPath} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function inspectRaw(id: string): Promise<RawContainer | null> {
  const response = await dockerRequest('GET', `/containers/${encodeURIComponent(id)}/json`);
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`Docker inspect failed (${response.status}): ${response.body}`);
  return JSON.parse(response.body) as RawContainer;
}

function toServiceContainer(raw: RawContainer): ServiceContainer {
  return {
    id: raw.Id,
    name: raw.Name.replace(/^\//, ''),
    running: raw.State.Running,
    health: raw.State.Health?.Status ?? raw.State.Status,
    labels: raw.Config.Labels ?? {},
  };
}

/** The host move on the real host: Docker over its socket, files through the bind mounts of the move container. */
export class DockerHostMoveHost implements HostMoveHost {
  private readonly docker = new DockerService(DOCKER_SOCKET, '');

  async exists(file: string): Promise<boolean> {
    return stat(file)
      .then(() => true)
      .catch(() => false);
  }

  async isSymlink(file: string): Promise<boolean> {
    return lstat(file)
      .then((entry) => entry.isSymbolicLink())
      .catch(() => false);
  }

  readFile(file: string): Promise<string> {
    return readFile(file, 'utf8');
  }

  async writeFile(file: string, content: string, mode = 0o600): Promise<void> {
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === content) {
      await chmod(file, mode);
      return;
    }
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  }

  rename(from: string, to: string): Promise<void> {
    return rename(from, to);
  }

  symlink(target: string, file: string): Promise<void> {
    return symlink(target, file);
  }

  unlink(file: string): Promise<void> {
    return unlink(file);
  }

  async mkdir(dir: string, mode = 0o700): Promise<void> {
    await mkdir(dir, { recursive: true, mode });
    await chmod(dir, mode);
  }

  removeTree(dir: string): Promise<void> {
    return rm(dir, { recursive: true, force: true });
  }

  async compose(
    target: { project: string; dir: string; file: string; envFile?: string },
    args: string[]
  ): Promise<void> {
    const binds = [`${target.dir}:${target.dir}`, `${DOCKER_SOCKET}:${DOCKER_SOCKET}`];
    const fileDir = path.dirname(target.file);
    if (!fileDir.startsWith(`${target.dir}/`) && fileDir !== target.dir) binds.push(`${fileDir}:${fileDir}`);
    const result = await this.docker.runOneShot({
      Image: DOCKER_COMPOSE_CLI_IMAGE_REF,
      Cmd: [
        'docker',
        'compose',
        '--project-name',
        target.project,
        '--project-directory',
        target.dir,
        '-f',
        target.file,
        ...(target.envFile ? ['--env-file', target.envFile] : []),
        ...args,
      ],
      HostConfig: { Binds: binds },
    });
    if (result.exitCode !== 0) {
      throw new Error(`docker compose ${args.join(' ')} failed: ${result.output.trim().slice(-1500)}`);
    }
  }

  async projectContainers(project: string): Promise<ServiceContainer[]> {
    const items = await this.docker.listContainersByLabel(`com.docker.compose.project=${project}`);
    const containers: ServiceContainer[] = [];
    for (const item of items) {
      const raw = await inspectRaw(item.Id);
      if (raw) containers.push(toServiceContainer(raw));
    }
    return containers;
  }

  async containerByName(name: string): Promise<ServiceContainer | null> {
    const raw = await inspectRaw(name);
    return raw ? toServiceContainer(raw) : null;
  }

  exec(containerId: string, command: string[]): Promise<{ exitCode: number; output: string }> {
    return this.docker.execInContainer(containerId, command);
  }

  stopContainer(id: string, timeoutSeconds: number): Promise<void> {
    return this.docker.stopContainer(id, timeoutSeconds);
  }

  startContainer(id: string): Promise<void> {
    return this.docker.startContainer(id);
  }

  removeContainer(id: string): Promise<void> {
    return this.docker.removeContainer(id);
  }

  createContainer(spec: ClickHouseSpec, network: string): Promise<string> {
    return this.docker.createContainer(
      {
        Image: spec.image,
        Env: spec.env,
        Labels: spec.labels,
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: spec.aliases } } },
        HostConfig: {
          Binds: spec.binds,
          NetworkMode: network,
          RestartPolicy: { Name: spec.restartPolicy || 'unless-stopped' },
          ...(spec.logConfig ? { LogConfig: spec.logConfig } : {}),
        },
      } as Parameters<DockerService['createContainer']>[0],
      spec.name
    );
  }

  async clickHouseSpec(id: string): Promise<ClickHouseSpec> {
    const raw = await inspectRaw(id);
    if (!raw) throw new Error(`Container ${id} disappeared`);
    const shortId = raw.Id.slice(0, 12);
    const aliases = Object.values(raw.NetworkSettings.Networks ?? {})
      .flatMap((network) => network.Aliases ?? [])
      .filter((alias) => alias !== shortId && alias !== raw.Name.replace(/^\//, ''));
    return {
      name: raw.Name.replace(/^\//, ''),
      image: raw.Config.Image,
      env: raw.Config.Env ?? [],
      labels: raw.Config.Labels ?? {},
      binds: raw.HostConfig.Binds ?? [],
      restartPolicy: raw.HostConfig.RestartPolicy?.Name || 'unless-stopped',
      logConfig: raw.HostConfig.LogConfig?.Type ? raw.HostConfig.LogConfig : null,
      aliases: [...new Set(aliases)],
      running: raw.State.Running,
    };
  }

  async networkMembers(network: string): Promise<NetworkMember[]> {
    const response = await dockerRequest('GET', `/networks/${encodeURIComponent(network)}`);
    if (response.status === 404) return [];
    if (response.status !== 200)
      throw new Error(`Docker network inspect failed (${response.status}): ${response.body}`);
    const containers =
      (JSON.parse(response.body) as { Containers?: Record<string, { Name: string }> }).Containers ?? {};
    const members: NetworkMember[] = [];
    for (const id of Object.keys(containers)) {
      const raw = await inspectRaw(id);
      if (!raw) continue;
      const shortId = raw.Id.slice(0, 12);
      members.push({
        id: raw.Id,
        name: raw.Name.replace(/^\//, ''),
        aliases: (raw.NetworkSettings.Networks?.[network]?.Aliases ?? []).filter((alias) => alias !== shortId),
        labels: raw.Config.Labels ?? {},
      });
    }
    return members;
  }

  connectNetwork(network: string, containerId: string, aliases: string[]): Promise<void> {
    return this.docker.connectContainerToNetwork(containerId, network, aliases);
  }

  async disconnectNetwork(network: string, containerId: string): Promise<void> {
    const response = await dockerRequest('POST', `/networks/${encodeURIComponent(network)}/disconnect`, {
      Container: containerId,
      Force: true,
    });
    if (response.status === 200 || response.status === 404) return;
    throw new Error(`Docker network disconnect failed (${response.status}): ${response.body}`);
  }

  async removeNetwork(network: string): Promise<void> {
    const response = await dockerRequest('DELETE', `/networks/${encodeURIComponent(network)}`);
    if (response.status === 204 || response.status === 404) return;
    throw new Error(`Docker network remove failed (${response.status}): ${response.body}`);
  }

  async volumeNames(): Promise<Set<string>> {
    const response = await dockerRequest('GET', '/volumes');
    if (response.status !== 200) throw new Error(`Docker volume list failed (${response.status}): ${response.body}`);
    const volumes = (JSON.parse(response.body) as { Volumes?: Array<{ Name: string }> | null }).Volumes ?? [];
    return new Set(volumes.map((volume) => volume.Name));
  }

  async finish(): Promise<void> {
    const self = process.env.HOSTNAME;
    if (!self) return;
    const response = await dockerRequest('POST', `/containers/${encodeURIComponent(self)}/update`, {
      RestartPolicy: { Name: 'no' },
    });
    if (response.status !== 200) {
      this.log('warn', 'Could not stop Docker from restarting the move container', { status: response.status });
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  now(): Date {
    return new Date();
  }

  log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
    if (level === 'info') console.log(line);
    else console.error(line);
  }
}
