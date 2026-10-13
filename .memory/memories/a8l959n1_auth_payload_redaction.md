---
{
  "id": "a8l959n1",
  "file_name": "a8l959n1_auth_payload_redaction",
  "tags": [
    "audit-log",
    "auth",
    "redaction",
    "security",
    "smtp",
    "testing"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785711216228,
  "updated_at": 1791851350656
}
---
Opfield auth security lesson (2026-08-03): The admin endpoint PUT /api/admin/auth-settings accepts SMTP credentials. Audit events must never store the raw parsed request as the audit 'details' because audit readers may have less privilege than settings editors and AuditService can log failed entries. Instead, produce a redacted audit payload that excludes SMTP passwords and any future secret fields, and log only safe failure metadata. Regression tests should assert on the persisted audit details and the logger arguments. Implemented pattern: use toAuthSettingsAuditDetails which replaces any supplied password with passwordChanged: true, and provide explicit audit logger metadata (action, resourceType, resourceId) rather than logging the raw request entry.
