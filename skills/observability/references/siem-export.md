# SIEM audit export

SIEM export pushes privacy-reduced audit events to up to five HTTPS collectors. It is enabled in Opfield general settings; while it is off, the SIEM tools are unavailable, which is expected.

## What is exported

Each event carries only its id, installation source, type, timestamp, action, optional actor id and email, resource type and id, and source IP. It never includes full audit `details`, resource display names, user agents, secrets, or collector response bodies. Use `get_audit_log` when full detail is needed.

## Destinations

- The URL must be HTTPS without userinfo, query, or fragment.
- Authentication is a bearer token, an HMAC-SHA256 secret, or one validated custom header, never an Opfield transport header. The secret is encrypted at rest and never returned.
- `create_siem_destination` requires the secret. Do not ask the user for it in chat. Let the user create or replace the destination, and its secret, in the Opfield Console. When the user explicitly asks you to create one and the secret already exists in a local source they named, pass it straight into the tool without echoing it.

## Delivery

Deliveries retry at 30 seconds, 2 minutes, 8 minutes, 30 minutes, 2 hours, 6 hours, and 12 hours (at most 8 attempts) on network errors, 408, 429, and 5xx; any other 4xx fails terminally.

## Tools and scopes

- `audit:siem:view`: `list_siem_destinations`, `get_siem_destination`, `list_siem_deliveries`, `get_siem_delivery`.
- `audit:siem:manage` (OAuth manual approval): `create_siem_destination`, `update_siem_destination`, `delete_siem_destination`, `test_siem_destination`, `requeue_siem_delivery`.

Verify a destination with `test_siem_destination` and a completed synthetic delivery in `list_siem_deliveries` before relying on it.
