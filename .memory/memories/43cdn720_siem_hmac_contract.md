---
{
  "id": "43cdn720",
  "file_name": "43cdn720_siem_hmac_contract",
  "tags": [
    "authentication",
    "delivery-log",
    "opfield",
    "siem",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786140832137,
  "updated_at": 1791851223079
}
---
# Opfield SIEM contract

## Feature flag

- `generalSettings.features.siemEnabled` is installation-wide and defaults to `true` for backward-compatible upgrades.
- It is configured through **Settings → Opfield → General settings → SIEM audit export**.
- When disabled, SIEM tabs/preloads disappear, SIEM-only users lose Notifications navigation, `/api/audit/siem` and SIEM AI tools fail closed, local audit records continue, new SIEM outbox rows are not created, and in-process delivery pauses.
- Destinations, history, and queued records remain and resume when re-enabled.
- Existing `system.config.changed` invalidation refreshes UI/config caches; no restart or extra service is required.
- Licensing: SIEM forwarding stops only after the licence grace period ends, never at the moment a licence is lost.

## Authentication

Supported modes are Bearer, HMAC-SHA256, and `custom_header`.

- Store a validated custom header name separately from its encrypted one-time value.
- Reject malformed names, CR/LF in values, and names overriding `Host`, `Content-Type`, or `X-Gateway-*`.
- `Authorization` remains valid for collectors using a non-Bearer scheme.
- HMAC delivery sends `X-Gateway-Timestamp` and `X-Gateway-Signature-256: sha256=<hex>`, signs `${timestamp}.${rawJsonBody}`, requires exact raw-body verification with constant-time comparison, and rejects stale timestamps.

## Schema and UI

- SIEM V1 includes custom-header authentication; `siem_destinations.custom_header_name` stores the validated header name.
- Authentication field transitions use the shared animated-height pattern. Keep delivery enablement visually separate without changing global spacing.
- Destination rows show only last-delivery status.
- SIEM and notification logs use the shared compact end-of-list sentinel.
- SIEM Delivery Details reuses the Audit Entry Details layout and standard dialog footer rather than a custom modal.

(Relay and deployment-safety rules that used to be appended here live in the relay/Secure Link memories.)
