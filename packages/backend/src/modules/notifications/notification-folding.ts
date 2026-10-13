/**
 * Alert folding: a route alert explained by another firing alert (Gateway lost outbound connectivity, the route's node
 * is down) is recorded with a pointer to that parent alert. Its notifications are not sent separately to a webhook
 * that gets the parent's, and it resolves with the parent. See NotificationEvaluatorService.foldingParent.
 */
export interface FoldedUnder {
  /** The parent alert state. */
  stateId: string;
  kind: 'node' | 'opfield_outbound';
  /** The parent alert as a reader knows it: its rule and resource. */
  label: string;
}

/** The parent a state's context names, if the state is folded. */
export function foldedUnder(context: unknown): FoldedUnder | null {
  const folded = (context as { folded?: Partial<FoldedUnder> } | null | undefined)?.folded;
  if (!folded || typeof folded.stateId !== 'string') return null;
  return {
    stateId: folded.stateId,
    kind: folded.kind === 'opfield_outbound' ? 'opfield_outbound' : 'node',
    label: typeof folded.label === 'string' ? folded.label : 'it was folded under',
  };
}
