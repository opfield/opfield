/**
 * Kind-specific error codes/messages the {@link ManagedWorkloadLifecycle} core
 * throws or records, injected by the caller so the core stays kind-agnostic.
 * `DatabaseWorkloadLabels`/`DATABASE_WORKLOAD_LABELS` (in the `databases`
 * module) supplies the current managed-database vocabulary; a future storage
 * kind supplies its own.
 */
export interface ManagedWorkloadLabels {
  notFound: { code: string; message: string };
  operationPending: { code: string; message: string };
  operationMismatch: { code: string; message: string };
  invalidLifecycle: (required: string, target: string) => { code: string; message: string };
  /** lastError text recorded by `markError`. */
  failed: (operation: string, detail?: string) => string;
  /** lastError text recorded by `markOutcomeUnknown`. */
  reconciling: string;
  /**
   * lastError text of an update the node refused before it changed anything;
   * the workload keeps the status it had. Defaults to `failed`'s text.
   */
  refused?: (operation: string, detail: string) => string;
  /**
   * lastError text of a delete whose Opfield-side cleanup failed; it is
   * retried with the pending operation. Defaults to `reconciling`.
   */
  waiting?: (operation: string, detail: string) => string;
}
