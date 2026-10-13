---
{
  "id": "jj5uyg5j",
  "file_name": "jj5uyg5j_clickhouse_credential_redaction",
  "tags": [
    "clickhouse",
    "database-credentials",
    "opfield",
    "security"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786152869542,
  "updated_at": 1791852053310
}
---
## ClickHouse connection-view credential boundary

- Treat the stored ClickHouse `config.url` as credential-bearing transport data: ClickHouse HTTP and the JS client accept URL query parameters, which may encode authentication or proxy headers.
- Preserve the encrypted URL unchanged for runtime client behavior, including safe query options and proxy paths.
- `toDatabaseConnectionView(..., revealCredentials=false)` must return an endpoint-only URL with userinfo, query string, and fragment removed; malformed historic URLs must fail closed rather than be returned verbatim.
- Full URLs and generated connection strings remain available only through the credential-reveal flow.
- Regression coverage should prove that an ordinary view hides URL query/header values and fragments while a reveal view preserves the raw URL.
