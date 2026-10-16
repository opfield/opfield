/**
 * The reason an availability member command could not be sent to a node, as operations and their events name it: the
 * node is not connected (offline, or its daemon stopped answering and its stream closed), or its daemon does not run
 * availability members.
 */
export function availabilityMemberUnsentReason(state: 'disconnected' | 'unsupported'): string {
  return state === 'disconnected'
    ? 'the node is not connected to Opfield (it is offline, or its daemon stopped answering)'
    : "the node's daemon does not run availability members; update the node's daemon";
}
