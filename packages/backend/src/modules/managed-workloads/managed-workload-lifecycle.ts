import crypto from 'node:crypto';
import { AppError } from '@/middleware/error-handler.js';
import type { DispatchResult, ManagedWorkloadDispatch } from './managed-workload-dispatch.js';
import type { ManagedWorkloadLabels } from './managed-workload-labels.js';
import { isUpdateRefusedBeforeChange } from './managed-workload-refusal.js';
import type {
  ManagedWorkloadStore,
  WorkloadPendingOperation,
  WorkloadRow,
  WorkloadRowPatch,
} from './managed-workload-store.js';

/**
 * Kind-agnostic core for managed workload provisioning lifecycles (databases
 * today, object storage next). It owns the generic orchestration —
 * create/update/delete dispatch, pause/unpause transitions, pending-operation
 * reconciliation and replay, and the shared `mark*`/`complete*` settlement
 * steps — expressed purely against the {@link ManagedWorkloadStore} (row
 * persistence) and {@link ManagedWorkloadDispatch} (daemon I/O + kind-specific
 * side-effects) seams.
 *
 * Every method here is a verbatim relocation of a private lifecycle method
 * that previously lived on `ManagedDatabaseService`; each `this.db.*` became a
 * `this.store.*` and each daemon/DB side-effect a `this.dispatch.*` hook
 * (Tasks 1–2 routed most of these already; Task 3 relocated the methods and
 * added the remaining kind-specific hooks — `assertNodeReady`,
 * `prepareReplay`, `ensureDirectAccess`, `provisionDirectAccess`, `syncStorage`,
 * `onReconcileReady`, `dispose`/`deleteCanonicalConnection`,
 * `readOwnerCredentials`, `publishFlags` — so the core no longer reaches back
 * into the service). Task 4 moved the last kind-specific ready-state columns
 * behind a `finalizeReady` hook, so the core's row type ({@link WorkloadRow})
 * and `markReady` no longer name any kind-specific field; `dispatch.
 * finalizeReady`/`onReconcileReady`'s `readyPatch` carry those columns
 * instead. `ManagedDatabaseService`'s public entry points build the operation
 * row and delegate into these methods.
 *
 * As of Phase 2a-i the core is fully vocabulary-neutral: it names no
 * database-specific error code, message, or column. All user-facing error
 * codes/messages come from the injected {@link ManagedWorkloadLabels}, and all
 * kind-specific ready-state columns flow through `dispatch.finalizeReady` /
 * `onReconcileReady`'s opaque `readyPatch`. A `StorageWorkloadProvider` can
 * therefore drive this same core by supplying its own labels, store, and
 * dispatch — no changes to this file.
 */
export class ManagedWorkloadLifecycle<TRow extends WorkloadRow, TCredentials> {
  private reconciliationInFlight = false;
  /**
   * Operations this process is dispatching right now. Reconciliation (the
   * scheduled pass, or a status read converging a lost response) leaves them
   * to their dispatcher: a restart carries no operation id the node reports
   * back, so a pass that saw the engine serve again before the dispatcher did
   * would replay the restart and restart the engine a second time. An
   * operation whose dispatch settled without an outcome (the node went away)
   * is no longer in flight and is reconciled as before.
   */
  private readonly dispatching = new Set<string>();

  constructor(
    private readonly store: ManagedWorkloadStore,
    private readonly dispatch: ManagedWorkloadDispatch<TRow, TCredentials>,
    private readonly labels: ManagedWorkloadLabels
  ) {}

  async dispatchCreate(
    row: TRow,
    credentials: TCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ): Promise<unknown> {
    const operation = this.pendingOperation(row, 'create');
    return this.whileDispatching(operation, () =>
      this.runCreate(row, credentials, publishTcp, publishNativeTcp, userId)
    );
  }

  private async runCreate(
    row: TRow,
    credentials: TCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ): Promise<unknown> {
    const direct = publishTcp ? await this.dispatch.ensureDirectAccess(row, userId, false) : null;
    const payload = await this.dispatch.renderCommandPayload(row, 'create');
    let result: DispatchResult;
    try {
      result = await this.dispatch.sendCommand(row.nodeId, 'create', row.id, payload);
    } catch {
      return this.markOutcomeUnknown(row);
    }
    if (!result.success) return this.markError(row, 'create', result.error);
    try {
      const current = this.dispatch.applyPrincipals
        ? await this.dispatch.applyPrincipals(row, direct, credentials, userId)
        : await (async () => {
            if (direct) await this.dispatch.provisionDirectAccess(direct.row, credentials, direct.credentials);
            return direct?.row ?? row;
          })();
      await this.dispatch.onCreateSucceeded(current, { credentials, userId });
      const readyPatch = await this.dispatch.finalizeReady(current, {
        operation: 'create',
        publishTcp,
        publishNativeTcp,
        result,
      });
      return this.markReady(current, userId, 'ready', readyPatch);
    } catch (error) {
      return this.markError(row, 'create', error instanceof Error ? error.message : undefined);
    }
  }

  async dispatchUpdate(
    row: TRow,
    credentials: TCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ): Promise<unknown> {
    const operation = this.pendingOperation(row, 'update');
    return this.whileDispatching(operation, () =>
      this.runUpdate(row, credentials, publishTcp, publishNativeTcp, userId)
    );
  }

  private async runUpdate(
    row: TRow,
    credentials: TCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ): Promise<unknown> {
    const direct = publishTcp ? await this.dispatch.ensureDirectAccess(row, userId, false) : null;
    const payload = await this.dispatch.renderCommandPayload(row, 'update');
    let result: DispatchResult;
    try {
      result = await this.dispatch.sendCommand(row.nodeId, 'update', row.id, payload);
    } catch {
      return this.markOutcomeUnknown(row);
    }
    if (!result.success) return this.markError(row, 'update', result.error);
    try {
      const current = this.dispatch.applyPrincipals
        ? await this.dispatch.applyPrincipals(row, direct, credentials, userId)
        : await (async () => {
            if (direct) await this.dispatch.provisionDirectAccess(direct.row, credentials, direct.credentials);
            return direct?.row ?? row;
          })();
      await this.dispatch.onCreateSucceeded(current, { credentials, userId });
      const readyPatch = await this.dispatch.finalizeReady(current, {
        operation: 'update',
        publishTcp,
        publishNativeTcp,
        result,
      });
      const ready = (await this.store.setReady(current.id, {
        ...readyPatch,
        updatedById: userId,
      })) as unknown as TRow;
      await this.dispatch.syncStorage(ready);
      await this.dispatch.onReady(ready);
      await this.dispatch.auditLifecycle('update', ready, userId);
      this.dispatch.emit(ready, 'ready');
      return this.dispatch.toView(ready);
    } catch (error) {
      return this.markError(row, 'update', error instanceof Error ? error.message : undefined);
    }
  }

  async dispatchDelete(row: TRow, userId: string | null): Promise<unknown> {
    const operation = this.pendingOperation(row, 'delete');
    return this.whileDispatching(operation, () => this.runDelete(row, userId));
  }

  private async runDelete(row: TRow, userId: string | null): Promise<unknown> {
    try {
      await this.dispatch.beforeDelete?.(row, userId);
    } catch (error) {
      // The Opfield-side cleanup (links, keys, routes) failed; the delete
      // keeps its pending operation and the reconciliation pass retries it.
      return this.markWaiting(row, 'delete', error instanceof Error ? error.message : undefined);
    }
    try {
      const payload = await this.dispatch.renderCommandPayload(row, 'remove');
      const result = await this.dispatch.sendCommand(row.nodeId, 'remove', row.id, payload);
      if (!result.success) return this.markError(row, 'delete', result.error);
    } catch {
      return this.markOutcomeUnknown(row);
    }
    await this.completeDelete(row, userId);
    return { success: true };
  }

  /**
   * Restart's daemon config is now rendered through `renderCommandPayload(row,
   * 'restart')` (which derives the owner credentials from `row`, identical to
   * the value every caller previously threaded in), so unlike the former
   * service method this no longer takes a `credentials` argument.
   */
  async dispatchRestart(row: TRow, userId: string | null): Promise<unknown> {
    const operation = this.pendingOperation(row, 'restart');
    return this.whileDispatching(operation, () => this.runRestart(row, userId));
  }

  private async runRestart(row: TRow, userId: string | null): Promise<unknown> {
    // Rendering the restart payload stays OUTSIDE the try, matching
    // `dispatchCreate`/`dispatchUpdate` and the pre-image service method: a
    // throw while building it (corrupt owner creds, or a CA/TLS-material fetch
    // failure for a TLS-enabled workload) must propagate as an unhandled error,
    // not be swallowed into `markOutcomeUnknown`.
    const payload = await this.dispatch.renderCommandPayload(row, 'restart');
    try {
      const result = await this.dispatch.sendCommand(row.nodeId, 'restart', row.id, payload);
      if (!result.success) return this.markError(row, 'restart', result.error);
      const readyPatch = await this.dispatch.finalizeReady(row, {
        operation: 'restart',
        publishTcp: false,
        publishNativeTcp: false,
        result,
      });
      return this.markReady(row, userId, 'ready', readyPatch);
    } catch {
      return this.markOutcomeUnknown(row);
    }
  }

  async reconcilePendingOperations(): Promise<void> {
    if (this.reconciliationInFlight) return;
    this.reconciliationInFlight = true;
    try {
      const rows = await this.store.listPending();
      for (const row of rows) await this.reconcilePendingRow(row as unknown as TRow);
    } finally {
      this.reconciliationInFlight = false;
    }
  }

  async reconcilePendingRow(row: TRow): Promise<void> {
    const operation = row.pendingOperation;
    if (!operation || this.dispatching.has(operation.id)) return;
    try {
      const result = await this.dispatch.sendCommand(row.nodeId, 'inspect', row.id, '', 10_000);
      // Another pass may have started dispatching it while this one inspected.
      if (!result.success || this.dispatching.has(operation.id)) return;
      const state = this.dispatch.parseDaemonState(result);
      if (!state) return;
      if (state.status === 'missing' && operation.action === 'delete') {
        // A node that lost the record but still has its container or storage
        // removes them on a repeated delete.
        if (state.leftover) {
          await this.dispatchDelete(row, null);
          return;
        }
        return await this.completeDelete(row, null);
      }
      // Daemon commands are handled asynchronously. An inspect can acquire the
      // workload mutex before an earlier mutation, so missing or stale
      // operation IDs are not a terminal outcome. Replay the *same* durable
      // operation ID instead: create/update are idempotent on it and remove is
      // idempotent for a missing record.
      if (state.status === 'missing' || state.operationId !== operation.id) {
        await this.replayPendingOperation(row);
        return;
      }
      if (operation.action === 'delete') {
        await this.dispatchDelete(row, null);
        return;
      }
      if (operation.action === 'pause' || operation.action === 'unpause') {
        const expectedStatus = operation.action === 'pause' ? 'paused' : 'ready';
        if (state.status !== expectedStatus) {
          await this.replayPendingOperation(row);
          return;
        }
        await this.completeLifecycleTransition(row, null, expectedStatus, operation.action);
        return;
      }
      if (state.status === 'paused') {
        await this.replayPendingOperation(row);
        return;
      }
      // A create/update may have reached the daemon before the controller lost
      // its response. Reapply the direct-access principal, resync the canonical
      // owner connection, and recover the auto-assigned host port from inspect.
      const { row: current, readyPatch } = await this.dispatch.onReconcileReady(row, result);
      await this.markReady(current, null, state.status, readyPatch);
    } catch {
      // The node is offline or the inspect response is still unavailable. Keep
      // the durable pending operation for the next scheduled pass.
    }
  }

  async replayPendingOperation(row: TRow): Promise<unknown> {
    row = await this.dispatch.prepareReplay(row);
    const operation = this.pendingOperation(row, row.pendingOperation!.action);
    if (operation.action === 'delete') return this.dispatchDelete(row, null);
    if (operation.action === 'pause' || operation.action === 'unpause') {
      return this.dispatchLifecycleTransition(
        row,
        null,
        operation.action,
        operation.action === 'pause' ? 'paused' : 'ready'
      );
    }
    const credentials = this.dispatch.readOwnerCredentials(row);
    const { publishTcp, publishNativeTcp } = this.dispatch.publishFlags(row);
    if (operation.action === 'create') return this.dispatchCreate(row, credentials, publishTcp, publishNativeTcp, null);
    if (operation.action === 'restart') return this.dispatchRestart(row, null);
    return this.dispatchUpdate(row, credentials, publishTcp, publishNativeTcp, null);
  }

  async beginLifecycleTransition(
    id: string,
    userId: string,
    action: 'pause' | 'unpause',
    requiredStatus: 'ready' | 'paused',
    targetStatus: 'ready' | 'paused'
  ): Promise<unknown> {
    const row = await this.requireRow(id);
    if (row.pendingOperation) {
      throw new AppError(409, this.labels.operationPending.code, this.labels.operationPending.message);
    }
    if (row.status !== requiredStatus) {
      const invalid = this.labels.invalidLifecycle(requiredStatus, targetStatus);
      throw new AppError(409, invalid.code, invalid.message);
    }
    await this.dispatch.assertNodeReady(row.nodeId);
    const pendingOperation: WorkloadPendingOperation = { id: crypto.randomUUID(), action };
    const pending = await this.store.claimOperation(id, requiredStatus, pendingOperation, {
      status: 'updating',
      updatedById: userId,
    });
    const claimed = this.requireOperationClaim(pending as TRow | undefined);
    this.dispatch.emit(claimed, `${action}.started`);
    return this.dispatchLifecycleTransition(claimed, userId, action, targetStatus);
  }

  async dispatchLifecycleTransition(
    row: TRow,
    userId: string | null,
    action: string,
    targetStatus: 'ready' | 'paused'
  ): Promise<unknown> {
    const operation = this.pendingOperation(row, action);
    return this.whileDispatching(operation, () =>
      this.runLifecycleTransition(row, userId, action, targetStatus, operation)
    );
  }

  private async runLifecycleTransition(
    row: TRow,
    userId: string | null,
    action: string,
    targetStatus: 'ready' | 'paused',
    operation: WorkloadPendingOperation
  ): Promise<unknown> {
    try {
      const payload = await this.dispatch.renderCommandPayload(row, action);
      const result = await this.dispatch.sendCommand(row.nodeId, action, row.id, payload);
      if (!result.success) return this.markError(row, action, result.error);
      const state = this.dispatch.parseDaemonState(result);
      if (!state || state.status !== targetStatus || state.operationId !== operation.id) {
        return this.markOutcomeUnknown(row);
      }
      return this.completeLifecycleTransition(row, userId, targetStatus, action);
    } catch {
      return this.markOutcomeUnknown(row);
    }
  }

  async completeLifecycleTransition(
    row: TRow,
    userId: string | null,
    status: 'ready' | 'paused',
    action: string
  ): Promise<unknown> {
    const updated = (await this.store.clearPending(row.id, {
      status,
      ...(userId ? { updatedById: userId } : {}),
    })) as unknown as TRow;
    if (userId) {
      await this.dispatch.auditLifecycle(action, updated, userId);
    }
    await this.dispatch.onReady(updated);
    this.dispatch.emit(updated, status);
    return this.dispatch.toView(updated);
  }

  async markReady(
    row: TRow,
    userId: string | null,
    status: 'ready' | 'stopped' = 'ready',
    extraPatch: WorkloadRowPatch = {}
  ): Promise<unknown> {
    const ready = (await this.store.setReady(row.id, {
      status,
      ...(userId ? { updatedById: userId } : {}),
      ...extraPatch,
    })) as unknown as TRow;
    await this.dispatch.onReady(ready);
    this.dispatch.emit(ready, status);
    return this.dispatch.toView(ready);
  }

  async markOutcomeUnknown(row: TRow): Promise<unknown> {
    const pending = (await this.store.setStatus(row.id, {
      lastError: this.labels.reconciling,
    })) as unknown as TRow;
    this.dispatch.emit(pending, 'reconciling');
    return this.dispatch.toView(pending);
  }

  /**
   * A pending operation that could not go ahead yet and is retried by the
   * reconciliation pass: the row says what it waits for.
   */
  async markWaiting(row: TRow, operation: string, detail?: string): Promise<unknown> {
    const sanitizedDetail = sanitizeDaemonDetail(detail);
    const pending = (await this.store.setStatus(row.id, {
      lastError:
        sanitizedDetail && this.labels.waiting
          ? this.labels.waiting(operation, sanitizedDetail)
          : this.labels.reconciling,
    })) as unknown as TRow;
    this.dispatch.emit(pending, 'reconciling');
    return this.dispatch.toView(pending);
  }

  async markError(row: TRow, operation: string, detail?: string): Promise<unknown> {
    const sanitizedDetail = sanitizeDaemonDetail(detail);
    const previousStatus = (row.pendingOperation as { previousStatus?: unknown } | null)?.previousStatus;
    if (
      operation === 'update' &&
      typeof previousStatus === 'string' &&
      previousStatus !== 'updating' &&
      isUpdateRefusedBeforeChange(sanitizedDetail)
    ) {
      // The node refused before it changed anything: the workload runs as it
      // did, so it keeps its status (and its links) and shows the refusal.
      const kept = (await this.store.setStatus(row.id, {
        status: previousStatus,
        pendingOperation: null,
        lastError: this.labels.refused
          ? this.labels.refused(operation, sanitizedDetail!)
          : this.labels.failed(operation, sanitizedDetail),
      })) as unknown as TRow;
      this.dispatch.emit(kept, 'refused');
      return this.dispatch.toView(kept);
    }
    const failed = (await this.store.setStatus(row.id, {
      status: 'error',
      pendingOperation: null,
      lastError: this.labels.failed(operation, sanitizedDetail),
    })) as unknown as TRow;
    this.dispatch.emit(failed, 'error');
    return this.dispatch.toView(failed);
  }

  async completeDelete(row: TRow, userId: string | null): Promise<void> {
    await this.dispatch.beforeDelete?.(row, userId);
    await this.dispatch.disposeCanonicalClient(row);
    if (this.dispatch.commitDelete) await this.dispatch.commitDelete(row);
    else {
      await this.store.delete(row.id);
      await this.dispatch.deleteCanonicalConnection(row);
    }
    await this.dispatch.auditLifecycle('delete', row, userId);
    this.dispatch.emit({ ...row, status: 'deleting' } as TRow, 'deleted');
  }

  private async whileDispatching<T>(operation: WorkloadPendingOperation, run: () => Promise<T>): Promise<T> {
    this.dispatching.add(operation.id);
    try {
      return await run();
    } finally {
      this.dispatching.delete(operation.id);
    }
  }

  requireOperationClaim(row: TRow | undefined): TRow {
    if (row) return row;
    throw new AppError(409, this.labels.operationPending.code, this.labels.operationPending.message);
  }

  pendingOperation(row: TRow, action: string): WorkloadPendingOperation {
    if (!row.pendingOperation || row.pendingOperation.action !== action) {
      throw new AppError(409, this.labels.operationMismatch.code, this.labels.operationMismatch.message);
    }
    return row.pendingOperation;
  }

  private async requireRow(id: string): Promise<TRow> {
    const row = await this.store.getById(id);
    if (!row) throw new AppError(404, this.labels.notFound.code, this.labels.notFound.message);
    return row as unknown as TRow;
  }
}

function sanitizeDaemonDetail(detail: string | undefined): string | undefined {
  return detail
    ?.replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 480);
}
