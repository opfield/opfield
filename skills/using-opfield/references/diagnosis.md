# Opfield diagnosis

Use this reference for incidents, warnings, failed Tasks, offline Nodes, unhealthy workloads, or unexplained product state. Diagnosis requests are read-only unless the user separately asks for a fix.

## Establish the failing boundary

Resolve the affected resource and read:

- desired and reported state;
- health and capability state;
- owning Node and related resources;
- active and recent Tasks;
- resource-level metrics and logs;
- audit records and warnings relevant to the event.

Follow the actual resource chain rather than stopping at the Dashboard. Examples:

- public application: Domain → certificate → Route → workload → Node;
- Git deployment: connector → admission → Build Worker → build → artifact → workload → health;
- Compose: Project → revision → child builds → services → Route or Secure Link;
- database access: database → binding → workload runtime → application connection;
- Pages: Project → Deployment → preview link or Tag → Route → Domain/TLS.

Once the failing boundary is known, continue with the skill that owns it (`deploying-workloads`, `ingress-and-domains`, `databases`, `storage`, `publishing-html-pages`, `managing-nodes`, or `observability` for logs, alerts, and audit evidence). The `investigate-service-outage` and `review-node-health` MCP prompts, when the client shows them, give a starting checklist.

## Classify, do not blur

Distinguish authentication, permission, entitlement, policy, validation, lifecycle conflict, Node connectivity, build worker, registry, DNS, TLS, Route application, workload health, and application behavior. Preserve request, operation, Task, build, and resource identifiers that connect the evidence.

A transport timeout is not proof of failure, and a successful API response is not proof of the final outcome. Reconcile the durable Task and final resource state.

## Report

Return:

1. observed symptom;
2. failing boundary;
3. evidence supporting that conclusion;
4. what remains healthy or unaffected;
5. smallest safe next action;
6. any verification still unavailable.

Do not restart, recreate, redeploy, delete, rotate credentials, change DNS, broaden scopes, or mutate configuration during diagnosis-only work.
