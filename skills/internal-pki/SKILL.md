---
name: internal-pki
description: Operate Opfield's user-facing Internal PKI (Enterprise), including root and intermediate certificate authorities, tls-server, tls-client, code-signing, and email certificates, templates, revocation, expiry, and linking an internal certificate as a Route's SSL certificate. Use when asked to stand up a private certificate authority, issue, renew, or revoke an internal certificate, or explain internal PKI expiry and reissue. Separate from Opfield's hidden system PKI. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Internal PKI

Internal PKI is a private trust domain that Opfield operates for you: certificate authorities, issued certificates, revocation, and templates. It is separate from Opfield's hidden **system PKI** (Node, Relay, daemon, managed-storage, and managed-database mTLS identities); never use these tools to touch system transport certificates.

Enterprise is required to create authorities, issue certificates, or change templates. After a license grace period ends, existing authorities, certificates, and templates stay viewable, revocable, and exportable; creating, issuing, and editing templates need the plan again.

Start with `using-opfield` for connection, discovery, and safety rules. Read `read_opfield_documentation({ topic: "pki" })` before an unfamiliar workflow.

## Certificate authorities

- `create_root_ca({ commonName, keyAlgorithm, validityYears, pathLengthConstraint?, maxValidityDays, ... })` creates a self-signed trust anchor. `pathLengthConstraint: 0` allows only end-entity certificates; `1` allows one level of intermediates. Keep the root rarely used.
- `create_intermediate_ca({ parentCaId, ... })` creates an authority signed by a parent. Issue day-to-day certificates from an intermediate, not the root.
- Key algorithms: `rsa-2048`, `rsa-4096`, `ecdsa-p256`, `ecdsa-p384`.
- `list_cas`, `get_ca`; `manage_ca` edits CRL and issuer URLs, the OCSP responder, and maximum validity (`pki:ca:edit`).
- `delete_ca` works only for an authority that never issued certificates. Deleting a record is not revocation: retire an authority by stopping issuance, resolving descendants, and preserving revocation evidence first.
- Creating and revoking authorities (`pki:ca:create:root`, `pki:ca:create:intermediate`, `pki:ca:revoke:root`, `pki:ca:revoke:intermediate`) and exporting a CA private key (`pki:ca:export`) are OAuth manual-approval scopes. Export key material only on an explicit request, and never print it.

## Issue a certificate

1. `issue_certificate({ caId, commonName, keyAlgorithm, validityDays, type, sans? })` with `type` `tls-server`, `tls-client`, `code-signing`, or `email`. `sans` is an array of plain strings (`"example.com"`, `"*.example.com"`, `"10.0.0.1"`, `"user@example.com"`); Opfield detects the kind. Never prefix values with `DNS:` or `IP:`; that fails.
2. A certificate cannot outlive its CA. A longer request fails with `VALIDITY_EXCEEDS_CA` unless `clampToCaValidity` is set, which ends it with the CA.
3. Templates (`list_templates`, `create_template`, `manage_template`, `delete_template`) predefine type, key algorithm, validity, key usage, extended key usage, SAN requirements, subject defaults, CRL and AIA URLs, and custom extensions. Built-in templates (`isBuiltin: true`) cannot be edited or deleted.
4. `get_certificate`, `list_certificates`; `revoke_certificate({ certificateId, reason })` with an RFC 5280 reason: `unspecified` (default), `keyCompromise`, `caCompromise`, `affiliationChanged`, `superseded`, `cessationOfOperation`, or `certificateHold`. Revocation is irreversible; confirm first. `delete_certificate({ certificateId })` then removes a revoked or expired certificate (a valid one must be revoked first; one a Route or a linked SSL certificate uses is refused with `CERT_IN_USE`); a revoked one deleted before it expires stays on the CRL until then.

## Use an internal certificate on a Route

PKI certificates and SSL certificates live in separate stores. `issue_certificate(...)` returns `{ certificate: { id, ... } }`; a TLS server certificate then serves a Route in one of two ways:

- Directly: set `internalCertificateId: certificate.id` on `create_route` or `update_route` (with `sslEnabled: true`).
- Through the SSL store: `link_internal_cert({ internalCertId: certificate.id })` creates a separate SSL certificate entry with its own ID; use that ID as the Route's `sslCertificateId` (`ingress-and-domains`). The console's Route SSL settings pick from these.

When a Route has both, the `sslCertificateId` one is served. `get_route` returns both ids and `certificate`, the one served (`source` `ssl` or `pki`). Never put a PKI certificate ID in `sslCertificateId`.

Linking needs `ssl:cert:issue` on the destination and `pki:cert:deploy` on the PKI certificate or its issuing CA (`pki:cert:export` also works). Setting the PKI certificate directly as the Route's `internalCertificateId` needs the same `pki:cert:deploy`. Either way the private key goes to nginx, never to the caller.

When Opfield holds the private key, a linked or directly attached certificate reissues automatically from the same CA and template once two thirds of its lifetime has passed (shown as "Reissue" under auto-renew). A certificate signed from an external CSR only alerts: issue a new one and re-link it.

## Expiry alerts

User CAs alert 180, 60, 30, and 7 days before expiry. System CAs alert 730, 365, 180, 60, 30, and 7 days ahead and have no automatic rollover yet: every Node, Relay, storage, and database certificate they issued stops working when they expire, so replacement must start at the first alert. Each threshold alerts once.

## System PKI audit

`audit_system_pki_leaves` inspects the hidden system CAs and leaves, read-only, and only when the user explicitly asks about system PKI. It needs PKI view permission and `admin:details:certificates` (manual approval). It cannot revoke, delete, issue, or export; server policy rejects mutations of system material through ordinary PKI tools.

## Verify

- After issuing: `get_certificate` shows the expected SANs, validity window, CA, and template.
- After linking: the SSL certificate entry resolves and, once on a Route, an external TLS handshake presents the expected chain.
- After revoking: the certificate reports revoked, and the CA's CRL reflects it when relying systems consume the CRL.

## Pitfalls

- Never use a user-facing root or intermediate to replace or interoperate with the system PKI, the Database CA, daemon identities, or Relay identities; they have separate rotation and recovery contracts.
- A database backup without `PKI_MASTER_KEY` (an operator-managed secret) cannot recover encrypted private keys. That is outside an agent's reach; flag it to the operator if it comes up.

Scopes: `pki:ca:view` (restrictable to a CA ID), `pki:ca:create:root|intermediate`, `pki:ca:edit`, `pki:ca:export`, `pki:ca:revoke:root|intermediate`, `pki:cert:view|issue|revoke|export`, `pki:templates:view|create|edit|delete`, `admin:details:certificates`. Further reading: [Internal PKI](https://docs.opfield.dev/en/certificates/internal-pki/), [SSL certificates](https://docs.opfield.dev/en/certificates/ssl-certificates/).
