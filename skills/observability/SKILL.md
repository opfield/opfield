---
name: observability
description: Work with Opfield observability, including Opfield's own health, resources and logs, structured-logging environments, schemas, ingest tokens, and log search, alert rules and notification webhooks, SIEM audit export, public status pages and incidents, and the audit log. Use when asked to search logs, set up log ingestion, create or debug an alert or webhook, export audit events to a SIEM, manage a status page or incident, or find who changed something. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Observability

Start with `using-opfield` for connection, discovery, and safety rules. For an incident, begin with its diagnosis reference and use this skill for the logs, alerts, and audit evidence. Read `read_opfield_documentation({ topic })` with `logging`, `notifications`, `siem`, `status-page`, or `audit` before an unfamiliar workflow.

## Opfield itself

`manage_opfield_diagnostics` reads the control plane, not managed nodes:

- `snapshot`: now. Opfield's host (CPU, memory, load, disk of the data volume), the backend process (memory, CPU, event-loop delay), Postgres and Redis (reachability, latency, pool, size, long queries), the stack containers (app, postgres, redis, relay, registry: state, health, restarts, CPU, memory), failing background jobs, API latency and 5xx.
- `history`: one-minute samples kept 48 hours. `from`/`to` take ISO or durations such as `6h`; `metrics` are dotted paths such as `host.cpuPercent`, `requests.p95Ms`, `postgres.poolWaiting`, `containers.postgres.memoryBytes` (the result lists `availableMetrics`).
- `requests`: per-route counts, p95 and 5xx over the last minutes (up to 60). `jobs`: every background job with its last run, duration, last error and failures in a row.
- `logs` (scope `diagnostics:logs`): lines of one Opfield container, `source` `app` (default), `update` (the last Opfield update run), `postgres`, `redis`, `relay` or `registry`; `since`/`until`, minimum `level`, `text`, `context`, `requestId`, `limit` up to 1000.

`diagnostics:view` covers everything but the logs; both are granted to the built-in admin groups. For nodes use `get_node` and `manage_node` (`health_history`, `monitoring_history`, `daemon_logs`, `nginx_logs`); for a route, `manage_route` `access_logs`.

## Structured logging

Opfield ingests structured logs from external services into ClickHouse-backed **logging environments**.

1. `manage_logging_backend` with `get` first. If logging is disabled on a fresh install, ask whether to provision Opfield-managed local ClickHouse or use an existing external ClickHouse before continuing.
2. `manage_logging` uses **singular** resources, and create, update, and search bodies go in `payload`:
   - `{ resource: "environment", operation: "list" | "get" | "create" | "update" | "delete" }`
   - `{ resource: "schema", operation: "list" | "get" | "create" | "update" | "delete" }`
   - `{ resource: "token", operation: "list" | "create" | "delete", environmentId }`
   - `{ resource: "logs", operation: "search", environmentId, payload: { query, limit } }`
   - `{ resource: "facets", operation: "facets", environmentId }`, `{ resource: "metadata", operation: "metadata", environmentId }`
3. Resolve names with `find_resource({ types: ["logging_environment"] })` or `["logging_schema"]`.

Schemas: `schemaMode` is `loose` (accept unknown labels and fields), `strip` (drop them), or `reject` (reject the event). `fieldSchema` entries have `key`, `location` (`label` or `field`), `type` (labels are `string`; fields may be `string`, `number`, `boolean`, `datetime`, or `json`), and `required`.

Ingest tokens (`opfl_`) are shown once by `create` (`payload: { name, expiresAt? }`), and `logs:tokens:create` is a manual-approval scope. Prefer letting the user create the token in the Console; if you create one to configure an ingest client, write it straight into that client's secret store and never print it.

Retention is a per-environment TTL plus optional Housekeeping caps on rows and disk size. Enable "ClickHouse Internals" cleanup only for a ClickHouse instance dedicated to Opfield.

## Alerts and webhooks

`list_alerts` answers what is alerting now (`status: "firing"`, the default) and the alert history (`resolved`, kept 30 days; event rules record each occurrence resolved at once), filtered by rule, category, severity, resource and time. `list_alert_rules`, `get_alert_rule`, `create_alert_rule`, `update_alert_rule`, `delete_alert_rule`, and `list_webhooks`, `create_webhook`, `update_webhook`, `delete_webhook`, `test_webhook`, `list_webhook_deliveries`, `get_delivery_stats`. Rule shape, categories, template variables, and helpers: [Alerts and templates](references/alerts-and-templates.md). Use namespaced template variables (`{{alert.*}}`, `{{resource.*}}`); legacy flat names render empty instead of failing.

## SIEM audit export

Outbound push of privacy-reduced audit events to up to five HTTPS collectors, enabled in Opfield general settings; the tools are unavailable (404) while export is off. Each destination authenticates with a bearer token, an HMAC-SHA256 secret, or one custom header. Never ask for that secret in chat: let the user create or replace the destination in the Console, then use the tools to test and inspect it. Delivery, retry, and field details: [SIEM export](references/siem-export.md).

## Status pages

`manage_status_page({ resource, operation, ... })`: `settings` (`get`, `update`), `proxy_templates` (`list`), `services` (`list`, `create`, `update`, `delete`), `incidents` (`list`, `create`, `update`, `delete`, `resolve`, `promote`), `incident_updates` (`create_update`), and `preview`. Updating settings and services needs `status-page:manage`; incidents are split across `status-page:incidents:create|update|resolve|delete`. A status page is public: `preview` and check the exposed services and wording before telling the user it is live.

The status page is served by Opfield through its ingress Node, which keeps the last good copy of the page, its assets and the status data it polls. While Opfield restarts, updates or is unreachable, visitors get that copy, the last one fetched while Opfield answered; a page that was never loaded before shows a short "Back in a moment" page that reloads by itself. Browsers never store the page themselves, so live data shows again as soon as Opfield answers.

## Audit log

`get_audit_log` filters by `action` (`resource.action`, for example `ca.create` or `proxy.update`), `resourceType`, and pagination. Actions made through MCP record `details.source: "mcp"` with the tool name, token prefix, and OAuth client; embedded-assistant actions carry `details.ai_initiated: true`. It needs `admin:audit`, an OAuth manual-approval scope. SIEM export is a reduced copy, not a substitute for the audit log when full detail is needed.

## Verify

- Opfield itself: name the time window, and back a cause with the history series and the log lines of that window.
- Alert rule: a real or realistic test condition produces a successful delivery with the expected rendered text in `list_webhook_deliveries`.
- SIEM: `test_siem_destination`, then a completed synthetic delivery in `list_siem_deliveries`.
- Status page: `preview` matches intent before announcing it.
- Logging: a test event appears in `search` with the expected labels and fields.

## Pitfalls

- Logging resources are singular (`environment`, `schema`, `token`); plural REST nouns are wrong here.
- Ingest tokens and SIEM secrets are shown once. Never try to confirm them by re-reading, and never paste them back into chat.

Further reading: [Observability overview](https://docs.opfield.dev/en/observability/overview/), [Tasks and audit](https://docs.opfield.dev/en/reference/tasks-and-audit/).
