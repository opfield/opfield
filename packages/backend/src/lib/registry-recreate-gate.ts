/**
 * Set while the registry maintenance recreates the registry from docker-compose.yml. An Opfield update must not start
 * meanwhile (its sidecar starts the registry the recreate replaces), nor the recreate during an update. Both run in this
 * process and each marks itself before it checks the other, so neither starts while the other runs.
 */
let recreating = false;

export function registryRecreateRunning(): boolean {
  return recreating;
}

export async function duringRegistryRecreate<T>(work: () => Promise<T>): Promise<T> {
  recreating = true;
  try {
    return await work();
  } finally {
    recreating = false;
  }
}
