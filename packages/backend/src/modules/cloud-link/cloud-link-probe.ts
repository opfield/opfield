import os from 'node:os';
import type { DiagnosticsService } from '@/modules/diagnostics/diagnostics.service.js';
import {
  CLOUD_LOG_LINE_MAX_CHARS,
  type CloudLinkProbe,
  type CloudServiceState,
  type CloudStateData,
} from './cloud-link.types.js';

const NOT_IN_DOCKER =
  "This installation's containers cannot be read here: Gateway does not run in Docker with access to its Docker socket";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The cloud link reads the host and containers through Gateway's own diagnostics: the app container already has the
 * Docker socket of its Compose project, and its host readings narrow to the container's cgroup where the host is not
 * visible. Nothing new is mounted for the cloud link.
 */
export function createCloudLinkProbe(diagnostics: DiagnosticsService, appVersion: string): CloudLinkProbe {
  const services = async (): Promise<CloudServiceState[]> => {
    try {
      return await diagnostics.stackServices();
    } catch (error) {
      throw new Error(`${NOT_IN_DOCKER} (${errorMessage(error)})`);
    }
  };

  return {
    async state(): Promise<CloudStateData> {
      const [host, dockerHost, stack] = await Promise.all([
        diagnostics.readHostNow(),
        diagnostics.readDockerHostInfo(),
        services().then(
          (value) => ({ value }),
          (error: unknown) => ({ error: errorMessage(error) })
        ),
      ]);
      if ('error' in host) throw new Error(`Host readings are not available here: ${host.error}`);
      const cpuPercent = host.cpuPercent ?? diagnostics.getLastSample()?.host.cpuPercent ?? null;
      return {
        hostname: dockerHost?.name || os.hostname(),
        uptimeSeconds: host.uptimeSeconds,
        version: appVersion,
        cpu: { cores: host.cpuCount, usage: cpuPercent === null ? 0 : Math.round(cpuPercent * 10) / 1000 },
        load: host.loadAverage,
        memory: {
          totalBytes: host.memoryTotalBytes,
          usedBytes: Math.max(0, host.memoryTotalBytes - host.memoryAvailableBytes),
        },
        disk: host.disk
          ? {
              path: host.disk.path,
              totalBytes: host.disk.totalBytes,
              usedBytes: Math.max(0, host.disk.totalBytes - host.disk.freeBytes),
            }
          : null,
        services: 'value' in stack ? stack.value : [],
        ...('error' in stack ? { servicesError: stack.error } : {}),
      };
    },

    async services(): Promise<string[]> {
      return (await services()).map((service) => service.name);
    },

    async logs(service, options) {
      const result = await diagnostics.containerLogLines(service, {
        tail: options.tail,
        ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {}),
        maxLineChars: CLOUD_LOG_LINE_MAX_CHARS,
      });
      return result.lines;
    },
  };
}
