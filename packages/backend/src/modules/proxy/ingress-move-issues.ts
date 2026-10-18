/**
 * Something a move of routes to another ingress node runs into, found before anything moves (an ingress migration
 * preview, or the check a migration runs before it starts). A blocker stops the move; a warning describes what stays
 * behind or changes. `fix` is the action that clears it, in words an operator or an agent can follow.
 */
export interface IngressMoveIssue {
  severity: 'blocker' | 'warning';
  /** The error code the move would fail with (or a code of its own for a warning). */
  code: string;
  message: string;
  fix: string;
  resourceType: 'domain' | 'route' | 'pages_project' | 'node' | 'app_environment';
  resourceId: string;
}

export function ingressMoveBlockers(issues: readonly IngressMoveIssue[]): IngressMoveIssue[] {
  return issues.filter((issue) => issue.severity === 'blocker');
}
