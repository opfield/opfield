# TLS certificates and Access Lists

## SSL certificate sources

Every source produces an **SSL certificate** entity whose ID is a Route's `sslCertificateId`.

- **ACME (Let's Encrypt):** `request_acme_cert({ domains, challengeType: "http-01" | "dns-01", dnsProvider? })`.
  - `http-01` needs the Domain's assigned nginx Node online and reachable on port 80.
  - `dns-01` with a configured Cloudflare connector creates, verifies, and cleans up TXT records automatically.
  - Manual `dns-01` returns `{ domain, recordName, recordValue }`. Give the user the record, wait for them, then confirm with `manage_ssl_certificate({ operation: "verify_dns", sslCertificateId })`.
  - Certificates renew automatically 30 days before expiry (checked daily). DNS-01 renewal requires Cloudflare; toggle it with `manage_ssl_certificate({ operation: "set_auto_renew", ... })`.
- **Upload:** `manage_ssl_certificate({ operation: "upload", certificatePem, privateKeyPem, chainPem? })`. Uploaded certificates do not renew; they must be replaced before expiry. A private key is a secret: take it from a local file the user named, never from chat, and never print it.
- **Internal PKI:** issue a certificate with `internal-pki`, then either set it directly as the Route's `internalCertificateId`, or let `link_internal_cert({ internalCertId })` create an SSL certificate entry and use that new SSL ID as `sslCertificateId` (never the PKI certificate ID there). `sslCertificateId` wins when both are set; `get_route` names the served one in `certificate`.

`list_ssl_certificates` lists them; `manage_ssl_certificate({ operation: "renew", ... })` reissues now; renew, `verify_dns`, `set_auto_renew` and `cancel_acme` need `ssl:cert:renew` on the certificate, which `ssl:cert:issue` implies (an internally linked certificate also needs `pki:cert:issue` on its CA). `manage_domain` `issue_certificate` needs `domains:view` on the domain plus `ssl:cert:issue` on the destination. `ssl:cert:issue` and `ssl:cert:delete` are OAuth manual-approval scopes.

## Access Lists

Read `read_opfield_documentation({ topic: "access-lists" })` before creating or changing one; sign-in settings, identity providers and service tokens are topic `access-sign-in`.

- A request is decided in this order: an address in an `ip` Exclude rule is denied; an address in `skipIpRanges` gets in; everyone else signs in with one of `signInMethods` (`opfield`, `password`, `basic`, `shared`, `idp:<providerId>`) or sends a service token, and must match one Include rule, every Require rule and no Exclude rule.
- Rules are `{ selector, values }`: `everyone`, `ip`, `email`, `email_domain`, `opfield_user`, `opfield_group`, `sso_group`, `method`, `service_token`. A list with sign-in methods needs an Include rule.
- `create_access_list` and `manage_access_list({ operation: "get" | "update", accessListId, ... })` take `name`, `description`, `signInMethods`, `users`, `sharedPassword`, `skipIpRanges`, `includeRules`, `requireRules`, `excludeRules`, `sessionTtlSeconds`. An update keeps omitted fields; an array replaces the whole array. A user sent without `password` keeps their password.
- `list_access_lists`; `delete_access_list` is refused while a Route or Page Project uses the list, so detach it first.
- One list can serve many Routes and Page Projects; an edit applies to all of them at once, so check who uses a list before changing it.

Credentials: never generate, request, or relay passwords (list users, the shared password) in chat. Prefer lists that need none: skip ranges, Opfield accounts, an identity provider. For password, basic or shared sign-in, reuse an existing list, or let the user set the passwords in the Opfield Console and then attach the list by ID. An agent cannot fetch a protected URL without signing in; a redirect to the sign-in page, a 401 or a 403 is the expected evidence that protection applies.
