import { AsyncLocalStorage } from 'node:async_hooks';

type OperationToken = { active: boolean; abandoned: boolean };

const context = new AsyncLocalStorage<OperationToken>();
const running = new Set<OperationToken>();

/** Admission follows a running request across service boundaries, but never outlives it. */
export const acceptedOperations = {
  isActive(): boolean {
    return context.getStore()?.active === true;
  },
  /**
   * Work a stopping Opfield left to durable recovery: it keeps running until the process exits, but must
   * not record anything, such as a failure caused only by the shutdown, that would keep recovery from resuming it.
   */
  isAbandoned(): boolean {
    return context.getStore()?.abandoned === true;
  },
  /** Marks every operation running now as abandoned; operations admitted afterwards are not. */
  abandonRunning(): number {
    for (const token of running) token.abandoned = true;
    return running.size;
  },
  run<T>(operation: () => T): T {
    if (this.isActive()) return operation();
    const token: OperationToken = { active: true, abandoned: false };
    running.add(token);
    const finish = () => {
      token.active = false;
      running.delete(token);
    };
    return context.run(token, () => {
      try {
        const result = operation();
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).then(finish, finish);
        } else {
          finish();
        }
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    });
  },
};
