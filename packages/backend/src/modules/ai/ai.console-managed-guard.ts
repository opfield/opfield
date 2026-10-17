import { AppError } from '@/middleware/error-handler.js';
import type { ConsoleMutation } from './ai.console-docker-mutations.js';
import type { InventoryContainer, ManagedContainerKind, ManagedInventory } from './ai.console-managed-inventory.js';

/**
 * Agents (remote MCP with OAuth grants or API tokens, and the in-app assistant) must not change Opfield-managed
 * Docker objects from a node's
 * console. Opfield keeps records of every container it runs (its access identity and grants, Git source, links,
 * deployment slots, Compose project, availability placement); a container removed and run again by hand is a
 * different container to Opfield, and builds, rollouts and permissions of the old one break. The Opfield tools
 * change these objects and keep the records in step.
 */
export const MANAGED_RESOURCE_CONSOLE_FORBIDDEN = 'MANAGED_RESOURCE_CONSOLE_FORBIDDEN';

export interface ConsoleRefusal {
  /** What the command would change, as the refusal names it (`container "web"`). */
  object: string;
  /** The tool to use instead. */
  tool: string;
  mutation: ConsoleMutation;
}

const CONTAINER_TOOLS: Record<string, string> = {
  rm: 'remove_docker_container',
  remove: 'remove_docker_container',
  stop: 'stop_docker_container',
  start: 'start_docker_container',
  restart: 'restart_docker_container',
  kill: 'kill_docker_container',
  pause: 'stop_docker_container',
  unpause: 'start_docker_container',
  rename: 'rename_docker_container',
  update: 'manage_docker_container (operation live_update or recreate)',
};
const RECREATE_TOOL =
  'manage_docker_container (operation recreate) or update_docker_container_image, which replace the container and keep Opfield in step';

function toolFor(kind: ManagedContainerKind, verb: string): string {
  switch (kind) {
    case 'deployment':
      return 'the deployment tools (deploy_docker_deployment, restart_docker_deployment, stop_docker_deployment, manage_docker_deployment)';
    case 'compose':
      return 'manage_docker_compose (operation_start with the lifecycle action, or a new revision)';
    case 'database':
      return 'manage_managed_database';
    case 'storage':
      return 'manage_managed_storage';
    case 'internal':
      return 'no tool: Opfield runs and repairs this container itself';
    default: {
      const base = verb.replace(/^container /, '');
      return CONTAINER_TOOLS[base] ?? RECREATE_TOOL;
    }
  }
}

/** The container a CLI reference (name, ID or ID prefix) means, as Docker resolves it. */
function resolveContainer(ref: string, inventory: ManagedInventory): InventoryContainer | null {
  const containers = inventory.containers ?? [];
  const name = ref.replace(/^\/+/, '');
  const byName = containers.find((container) => container.name === name);
  if (byName) return byName;
  const byId = containers.find((container) => container.id === ref);
  if (byId) return byId;
  if (/^[0-9a-f]{2,64}$/i.test(ref)) {
    const matches = containers.filter((container) => container.id.startsWith(ref.toLowerCase()));
    return matches.find((container) => container.managed) ?? matches[0] ?? null;
  }
  return null;
}

function hasManagedContainers(inventory: ManagedInventory): boolean {
  return (
    inventory.allManaged ||
    inventory.recordedNames.size > 0 ||
    inventory.reservedNames.size > 0 ||
    (inventory.containers ?? []).some((container) => container.managed)
  );
}

/**
 * A managed container a reference names. When the node's containers could not be listed, every reference counts:
 * the guard cannot tell a managed container from another one.
 */
function managedContainer(ref: string, inventory: ManagedInventory): InventoryContainer | null {
  const resolved = resolveContainer(ref, inventory);
  if (resolved?.managed) return resolved;
  if (!resolved && (inventory.allManaged || inventory.containers === null)) {
    return {
      id: '',
      name: ref,
      managed: true,
      // Unlisted containers (an SSH target with an Opfield Docker daemon, rc.3 GO-7) are ordinary managed containers
      // to the hint: the Docker tools change them. Only a listed internal node's containers are Opfield's own.
      kind: inventory.allManaged && inventory.containers !== null ? 'internal' : 'container',
      project: null,
      ports: [],
    };
  }
  return null;
}

/** Why a container name is Opfield's, or null when it is free to use. */
function managedNameOwner(name: string, inventory: ManagedInventory): string | null {
  const live = (inventory.containers ?? []).find((container) => container.name === name);
  if (live?.managed) return `managed container "${name}"`;
  const reserved = inventory.reservedNames.get(name);
  if (reserved) return `the name "${name}" that Opfield keeps for ${reserved}`;
  if (inventory.recordedNames.has(name)) return `the name of managed container "${name}"`;
  return null;
}

function refuse(mutation: ConsoleMutation, object: string, tool: string): ConsoleRefusal {
  return { mutation, object, tool };
}

function evaluateRun(mutation: ConsoleMutation, inventory: ManagedInventory): ConsoleRefusal | null {
  if (mutation.name) {
    const owner = managedNameOwner(mutation.name, inventory);
    if (owner) return refuse(mutation, owner, RECREATE_TOOL);
  }
  for (const port of mutation.ports) {
    const holder = (inventory.containers ?? []).find((c) => c.managed && c.ports.includes(port));
    if (holder) return refuse(mutation, `host port ${port} of managed container "${holder.name}"`, RECREATE_TOOL);
  }
  for (const volume of mutation.volumes) {
    if (inventory.volumes.has(volume) || inventory.allManaged) {
      return refuse(mutation, `managed volume "${volume}"`, 'manage_docker_volume, or mount it in Opfield');
    }
  }
  for (const ref of mutation.containers) {
    const source = managedContainer(ref, inventory);
    if (source) return refuse(mutation, `the volumes of managed container "${source.name}"`, RECREATE_TOOL);
  }
  if (mutation.unresolved && hasManagedContainers(inventory)) {
    return refuse(mutation, 'a container whose name, ports or volumes are only known when it runs', RECREATE_TOOL);
  }
  return null;
}

function evaluateCompose(mutation: ConsoleMutation, inventory: ManagedInventory): ConsoleRefusal | null {
  const tool = toolFor('compose', mutation.verb);
  const project = mutation.project;
  if (project) {
    const live = (inventory.containers ?? []).some((c) => c.managed && c.project === project);
    return inventory.composeProjects.has(project) || live || inventory.allManaged
      ? refuse(mutation, `managed Compose project "${project}"`, tool)
      : null;
  }
  if (inventory.composeProjects.size === 0 && !inventory.allManaged) return null;
  const names = [...inventory.composeProjects].slice(0, 5).map((name) => `"${name}"`);
  return refuse(
    mutation,
    `a Compose project it cannot be told apart from the managed ones on this node (${names.join(', ') || 'all of them'})`,
    tool
  );
}

function evaluateMutation(mutation: ConsoleMutation, inventory: ManagedInventory): ConsoleRefusal | null {
  if (mutation.kind === 'state_path') {
    return refuse(
      mutation,
      `the Opfield or Docker state at ${mutation.path}`,
      'the Opfield tool for the object instead (the daemons keep this state themselves)'
    );
  }
  if (inventory.noDocker) return null;
  switch (mutation.kind) {
    case 'prune':
      return hasManagedContainers(inventory) || inventory.volumes.size > 0
        ? refuse(
            mutation,
            `every unused ${mutation.verb.replace(/ prune$/, '')} object (${mutation.verb}), Opfield-managed ones included`,
            'remove_docker_container, manage_docker_volume (delete), manage_docker_network (delete) or prune_docker_images'
          )
        : null;
    case 'container': {
      for (const ref of mutation.containers) {
        const target = managedContainer(ref, inventory);
        if (target) return refuse(mutation, `managed container "${target.name}"`, toolFor(target.kind, mutation.verb));
      }
      if (mutation.name) {
        const owner = managedNameOwner(mutation.name, inventory);
        if (owner) return refuse(mutation, owner, 'rename_docker_container');
      }
      return mutation.unresolved && hasManagedContainers(inventory)
        ? refuse(
            mutation,
            'containers it names only when it runs ($VAR, $(...), globs, xargs or --all)',
            toolFor('container', mutation.verb)
          )
        : null;
    }
    case 'run':
      return evaluateRun(mutation, inventory);
    case 'network': {
      for (const ref of mutation.containers) {
        const target = managedContainer(ref, inventory);
        if (target) return refuse(mutation, `managed container "${target.name}"`, 'manage_docker_network');
      }
      for (const network of mutation.networks) {
        if (inventory.networks.has(network) || inventory.allManaged) {
          return refuse(mutation, `managed network "${network}"`, 'manage_docker_network');
        }
      }
      return mutation.unresolved && hasManagedContainers(inventory)
        ? refuse(mutation, 'networks or containers it names only when it runs', 'manage_docker_network')
        : null;
    }
    case 'volume': {
      for (const volume of mutation.volumes) {
        if (inventory.volumes.has(volume) || inventory.allManaged) {
          return refuse(mutation, `managed volume "${volume}"`, 'manage_docker_volume (operation delete)');
        }
      }
      return mutation.unresolved && (inventory.volumes.size > 0 || inventory.allManaged)
        ? refuse(mutation, 'volumes it names only when it runs', 'manage_docker_volume (operation delete)')
        : null;
    }
    case 'compose':
      return evaluateCompose(mutation, inventory);
    default:
      return null;
  }
}

/** The first change a console command would make to an Opfield-managed object of the node, or null. */
export function evaluateConsoleMutations(
  mutations: readonly ConsoleMutation[],
  inventory: ManagedInventory
): ConsoleRefusal | null {
  for (const mutation of mutations) {
    const refusal = evaluateMutation(mutation, inventory);
    if (refusal) return refusal;
  }
  return null;
}

export function managedResourceConsoleError(refusal: ConsoleRefusal): AppError {
  const command =
    refusal.mutation.command.length > 200 ? `${refusal.mutation.command.slice(0, 200)}...` : refusal.mutation.command;
  return new AppError(
    403,
    MANAGED_RESOURCE_CONSOLE_FORBIDDEN,
    `Refused "${command}": it changes ${refusal.object}, which Opfield manages on this node. Agents must not ` +
      'change Opfield-managed Docker objects (containers, Compose projects, volumes, networks, daemon state) ' +
      'through the node console or SSH: Opfield would lose track of them, and their Git-source builds, rollouts, ' +
      `links and permissions break. Use ${refusal.tool}. To read containers use list_docker_containers, ` +
      'get_docker_container and get_docker_container_logs: agent console commands run without the container runtime.',
    { object: refusal.object, tool: refusal.tool, verb: refusal.mutation.verb }
  );
}

/** Whether evaluating the mutations needs the node's volume and network lists. */
export function inventoryNeeds(mutations: readonly ConsoleMutation[]) {
  return {
    volumes: mutations.some((m) => m.kind === 'volume' || (m.kind === 'run' && m.volumes.length > 0)),
    networks: mutations.some((m) => m.kind === 'network'),
  };
}

export function emptyInventory(): ManagedInventory {
  return {
    containers: [],
    reservedNames: new Map(),
    recordedNames: new Set(),
    recordedIds: new Set(),
    composeProjects: new Set(),
    volumes: new Set(),
    networks: new Set(),
    allManaged: false,
    noDocker: false,
  };
}
