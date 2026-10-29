import { existsSync } from 'node:fs';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Docker creates /.dockerenv in its containers, Podman /run/.containerenv. */
function insideContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * Where the core → Opfield callback listener binds. The core reaches Opfield through its alias on the installer-managed
 * Compose network, so the listener needs the container's own addresses there, not the wildcard: inside a container
 * that is every non-loopback address of its interfaces (one per attached network). Outside a container no core can run
 * (the lifecycle needs the Compose project), so the listener stays on loopback.
 * `override` (INFERENCE_CORE_INTERNAL_HOST) pins one address for setups that attach networks after start.
 */
export function inferenceCoreListenHosts(input: {
  override?: string | null;
  inContainer: boolean;
  interfaces: Interfaces;
}): string[] {
  const override = input.override?.trim();
  if (override) return [override];
  if (!input.inContainer) return ['127.0.0.1'];
  const addresses = new Set<string>();
  for (const entries of Object.values(input.interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      // Link-local IPv6 needs a scope id and is not what Docker hands out for a network.
      if (entry.family === 'IPv6' && entry.address.toLowerCase().startsWith('fe80:')) continue;
      addresses.add(entry.address);
    }
  }
  return addresses.size > 0 ? [...addresses] : ['127.0.0.1'];
}

export function inferenceCoreListenHostsFromEnvironment(override?: string | null): string[] {
  return inferenceCoreListenHosts({
    override,
    inContainer: insideContainer(),
    interfaces: networkInterfaces(),
  });
}

/** Largest callback body: admission and settlement are small JSON documents. */
export const INFERENCE_CORE_CALLBACK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Starts the listener on every address. An address that cannot be bound (an interface that went away between the
 * lookup and the bind, a network attached in a way the address cannot be used) is reported through `onSkipped` and
 * left out; startup fails only when no address binds, because then the core could not reach Opfield at all.
 */
export async function startCoreListeners<Server>(
  hosts: string[],
  start: (host: string) => Promise<Server>,
  onSkipped: (host: string, error: unknown) => void
): Promise<{ servers: Server[]; hosts: string[] }> {
  const results = await Promise.allSettled(hosts.map((host) => start(host)));
  const servers: Server[] = [];
  const bound: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      servers.push(result.value);
      bound.push(hosts[index]!);
    } else {
      onSkipped(hosts[index]!, result.reason);
    }
  });
  if (servers.length === 0) {
    const first = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw first?.reason ?? new Error('No address for the inference core callback listener');
  }
  return { servers, hosts: bound };
}
