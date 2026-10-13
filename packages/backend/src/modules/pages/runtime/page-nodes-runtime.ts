import { AppError } from '@/middleware/error-handler.js';

type BindingKind = 'route' | 'preview';

/** The per-node Pages runtime operations a Route binding uses. */
export interface PageNodeRuntimeOperations {
  publishRuntimeConfig(
    nodeId: string,
    bindingKind: BindingKind,
    bindingId: string,
    generation: number,
    value: Record<string, unknown>
  ): Promise<string>;
  activateRuntimeConfig(
    nodeId: string,
    bindingKind: BindingKind,
    bindingId: string,
    generation: number
  ): Promise<string>;
  removeRuntimeConfig(nodeId: string, bindingKind: BindingKind, bindingId: string): Promise<void>;
  activateRoute(nodeId: string, routeId: string, deploymentId: string): Promise<string>;
  deactivateRoute(nodeId: string, routeId: string): Promise<void>;
  preflight(nodeId: string, requiredBytes: number): Promise<void>;
  isNodeConnected?(nodeId: string): boolean;
}

/**
 * Pages Route bindings on every node that serves a Route: its node, or each member of its ingress group. Every member
 * holds its own replica and runtime config, so it keeps serving while Opfield or another member is down.
 *
 * A change reaches the members that are connected now. An offline member is skipped and converges later (the Pages
 * Route reconciliation re-applies bindings that do not match, and a reconnecting member gets the additional Routes of
 * its hosts again). A single node is always contacted, so an offline node fails the change exactly as before.
 * Every member renders the same Route config, so all of them must report the same include and config paths.
 */
export class PageNodesRuntime {
  constructor(private readonly runtime: PageNodeRuntimeOperations) {}

  reachable(nodeIds: readonly string[]): string[] {
    if (nodeIds.length === 0) throw new AppError(409, 'PAGES_ROUTE_NODE_MISSING', 'Pages Route has no Nginx node');
    if (nodeIds.length === 1) return [...nodeIds];
    const connected = this.connected(nodeIds);
    if (connected.length === 0) {
      throw new AppError(503, 'PAGES_ROUTE_NODES_OFFLINE', 'No ingress group member of this Pages Route is connected');
    }
    return connected;
  }

  /** Connected nodes of a list (a single node counts as connected: it is always contacted). */
  connected(nodeIds: readonly string[]): string[] {
    if (nodeIds.length <= 1) return [...nodeIds];
    return nodeIds.filter((nodeId) => this.runtime.isNodeConnected?.(nodeId) !== false);
  }

  async preflight(nodeIds: readonly string[], requiredBytes: number): Promise<void> {
    for (const nodeId of this.reachable(nodeIds)) await this.runtime.preflight(nodeId, requiredBytes);
  }

  async publishRuntimeConfig(
    nodeIds: readonly string[],
    routeId: string,
    generation: number,
    value: Record<string, unknown>
  ): Promise<string> {
    const paths: string[] = [];
    for (const nodeId of this.reachable(nodeIds)) {
      paths.push(await this.runtime.publishRuntimeConfig(nodeId, 'route', routeId, generation, value));
    }
    return samePath(paths);
  }

  async activateRoute(nodeIds: readonly string[], routeId: string, deploymentId: string): Promise<string> {
    const paths: string[] = [];
    for (const nodeId of this.reachable(nodeIds)) {
      paths.push(await this.runtime.activateRoute(nodeId, routeId, deploymentId));
    }
    return samePath(paths);
  }

  async deactivateRoute(nodeIds: readonly string[], routeId: string): Promise<void> {
    await this.onEach(nodeIds, (nodeId) => this.runtime.deactivateRoute(nodeId, routeId));
  }

  /** Makes `generation` the active runtime config of the Route again, or removes it for generation 0. */
  async restoreRuntimeConfig(nodeIds: readonly string[], routeId: string, generation: number): Promise<void> {
    await this.onEach(nodeIds, async (nodeId) => {
      if (generation > 0) await this.runtime.activateRuntimeConfig(nodeId, 'route', routeId, generation);
      else await this.runtime.removeRuntimeConfig(nodeId, 'route', routeId);
    });
  }

  /** Activates `deploymentId` again (or deactivates the Route) and restores its runtime config generation. */
  async restoreMaterialization(
    nodeIds: readonly string[],
    routeId: string,
    deploymentId: string | null,
    runtimeConfigGeneration: number
  ): Promise<void> {
    if (deploymentId) await this.activateRoute(nodeIds, routeId, deploymentId);
    else await this.deactivateRoute(nodeIds, routeId);
    await this.restoreRuntimeConfig(nodeIds, routeId, runtimeConfigGeneration);
  }

  /** Removes the Route binding and its runtime config from each connected node; returns the first failure. */
  async cleanup(nodeIds: readonly string[], routeId: string): Promise<unknown> {
    const errors: unknown[] = [];
    for (const nodeId of this.connected(nodeIds)) {
      try {
        await this.runtime.deactivateRoute(nodeId, routeId);
      } catch (error) {
        errors.push(error);
      }
      try {
        await Promise.resolve(this.runtime.removeRuntimeConfig?.(nodeId, 'route', routeId));
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) return undefined;
    return errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
  }

  /** Runs a step on every reachable node, all of them even after a failure; rethrows the first failure. */
  private async onEach(nodeIds: readonly string[], step: (nodeId: string) => Promise<unknown>): Promise<void> {
    let failure: unknown;
    let failed = false;
    for (const nodeId of this.reachable(nodeIds)) {
      try {
        await step(nodeId);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }
}

function samePath(paths: readonly string[]): string {
  if (paths.some((path) => path !== paths[0])) {
    throw new AppError(
      502,
      'PAGES_ROUTE_INCLUDE_PATH_MISMATCH',
      'Ingress group members report different Pages paths; update their nginx daemons to the same release'
    );
  }
  return paths[0]!;
}
