export function dockerDispatchErrorMessage(result: { error?: string; detail?: string }, fallback: string) {
  if (typeof result.error === 'string' && result.error.trim()) return result.error.trim();
  if (typeof result.detail === 'string' && result.detail.trim()) return result.detail.trim();
  return fallback;
}

/**
 * Whether a replacement container is in the state its update or recreate asked for. Once the daemon is done with it
 * (`settled`: its task succeeded, or the daemon no longer knows the task), a replacement that runs although `created`
 * was asked counts as well: the daemon starts it when an earlier recreate of the container that it could not complete
 * meant it to run (the expected state it keeps on disk).
 */
export function replacementReached(state: string, expectedState: string, settled = false) {
  if (state === expectedState) return true;
  if (expectedState === 'running' && state === 'restarting') return true;
  return settled && expectedState === 'created' && (state === 'running' || state === 'restarting');
}

/**
 * Why a replacement container failed, or null while it may still get where it was asked to. A replacement that
 * exited or died failed to start. Once the daemon is done with it (`settled`), one still `created` although `running`
 * was asked never started: without that, the container's transition (and so every action on it) waited for the
 * watch's timeout of more than ten minutes.
 */
export function getReplacementContainerFailureMessage(
  container: {
    id?: string;
    Id?: string;
    state?: string;
    State?: string;
    status?: string;
    Status?: string;
  },
  oldContainerId: string,
  expectedState: string,
  settled = false
) {
  const newId = container.id ?? container.Id;
  const state = String(container.state ?? container.State ?? '').toLowerCase();
  const status = String(container.status ?? container.Status ?? '');
  const normalizedExpectedState = String(expectedState).toLowerCase();

  if (newId === oldContainerId) return null;
  if (settled && state === 'created' && normalizedExpectedState === 'running') {
    return `Replacement container was created but did not start (${status || state})`;
  }
  if (!['exited', 'dead'].includes(state) || state === normalizedExpectedState) return null;

  return `Replacement container failed to start (${status || state})`;
}
