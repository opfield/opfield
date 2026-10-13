---
{
  "id": "7abclq2n",
  "file_name": "7abclq2n_gateway_databases_extraction",
  "tags": [
    "clickhouse",
    "connection-form",
    "databases",
    "opfield",
    "postgresql",
    "sql-adapter",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1782003066839,
  "updated_at": 1791851259900
}
---
Opfield database connections: code location, SQL connector contract and connection form.

Where the code lives (verified 2026-10-01)
- The real databases implementation is in the private sibling repo `gateway-commercial` under `backend/databases/` (databases.service.ts, postgres-column-operations.ts, postgres-sql-adapter.ts, clickhouse-sql-adapter.ts, clickhouse-connection.ts, redis-key-operations.ts and friends). In this repo `packages/backend/src/modules/databases/databases.service.ts` is a Community contract stub (`commercialModuleUnavailable()`); the host keeps routes/docs/schemas, the neutral `sql-database-adapter.ts` contract and shared runtime contracts. Trace database bugs in gateway-commercial first.

Extraction boundaries (inside the commercial implementation)
- DatabaseConnectionService keeps audit logging, event emission, refresh-after-write orchestration, and connection/client lifecycle.
- postgres-column-operations.ts owns PostgreSQL column normalization/type lookup/base-table guards; redis-key-operations.ts owns Redis key scan/read/write shaping and multi-write branching.
- sql-database-adapter.ts is the neutral SQL contract; the PostgreSQL adapter preserves PostgreSQL behaviour; the ClickHouse adapter implements catalog/query behaviour. Provider-specific connection normalization/client construction stays outside the service.

SQL connector contract
- Neutral endpoints live under /databases/{id}/sql/* while legacy PostgreSQL and Redis endpoints remain supported.
- Expose capabilities rather than assuming uniform mutation support. ClickHouse Explorer is read-only; SQL Console writes remain gated by read/write/admin query scopes.
- ClickHouse uses the official HTTP(S) client. A connection-string URL is authoritative for protocol/host/port.
- Catalog/query paths are bounded: identifier quoting, parameterized values, statement/row/byte/time limits, query IDs, and statistics.
- ClickHouse client settings use mixed types: numeric max_execution_time, string readonly '1', string max_result_rows, numeric cancel_http_readonly_queries_on_client_close.
- Do not add ClickHouse to AI/MCP database tools without a separate design.

Database connection form contract (frontend, this repo)
- Connection method is a required select: Credentials by default, Connection URI as the alternative. Never show or submit both; URI mode submits only connectionString, credentials mode only the provider-specific host/port/database-or-DB-index/username/password/TLS fields.
- Clear provider-specific values when the database type changes, so credentials or URIs are not reused across providers.
- Disable Create until name and the active method are complete and valid; validate URI protocol/details, port range and Redis DB range.
- Conditional-field motion matches the inference/alert dialogs: shared AnimatedHeight around the body, AnimatePresence initial=false mode=popLayout with the existing 0.2s reveal, and a relative overflow-hidden wrapper so the outgoing block cannot escape the modal while height shrinks.
- Check both methods at desktop and 390x844, including disabled/enabled Create and the live transition.
