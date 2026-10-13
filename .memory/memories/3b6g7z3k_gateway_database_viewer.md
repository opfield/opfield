---
{
  "id": "3b6g7z3k",
  "file_name": "3b6g7z3k_gateway_database_viewer",
  "tags": [
    "backend",
    "database",
    "frontend",
    "opfield",
    "postgres",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1781735109831,
  "updated_at": 1791851159804
}
---
Opfield PostgreSQL viewer contract (the backend implementation now lives in the private gateway-commercial repo under backend/databases; the frontend viewer is in this repo):
- Row edits must not rely on frontend-only coercion. The backend must cast insert/update/delete parameters by column metadata, including numeric, date, timestamp, JSON, and USER-DEFINED enum types using the correct schema/name.
- Send only changed-column deltas for edits; do not rewrite a whole row from the original frontend clone.
- Map only user-actionable PostgreSQL query failures (constraint, type, invalid input, and similar client-correctable errors) to AppError 400 / DATABASE_QUERY_FAILED with a useful message.
- Do not blanket-map every driver error carrying SQLSTATE or metadata to 400. Operational failures such as shutdowns or server-side availability problems must remain higher-level/server errors.
- Verify frontend row-edit behaviour and the backend cast/delta/error-classification paths in gateway-commercial.
