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

- `create_access_list` takes `allowIps` and `denyIps` string arrays plus `basicAuthUsers`; pass ordered `ipRules` instead when the order matters.
- `manage_access_list({ operation: "get" | "update", accessListId, ... })` updates `name`, `description`, ordered `ipRules: [{ type: "allow" | "deny", value }]` (the whole list), `basicAuthEnabled`, and `basicAuthUsers: [{ username, password }]`. Passwords are stored as bcrypt hashes and deployed to Nodes as htpasswd files.
- nginx checks IP rules in order and the first match wins; when a list has rules, every address that matches none is denied. `deny all` before `allow 203.0.113.7` blocks that address too. To block a few addresses and let everyone else in, list the deny rules and end with `allow all`.
- `manage_access_list({ operation: "move_rule", accessListId, fromIndex, toIndex })` moves one rule (0-based; the rules between shift by one) against the stored list.
- Every access list response carries `ipRuleWarnings`: `shadowed` rules never match because an earlier rule (`coveredByIndex`) matches all their addresses; `no_effect` deny rules change nothing because no later rule allows those addresses. Fix them with `move_rule` or remove them with `update` before reporting the list as done.
- `list_access_lists`; `delete_access_list` is refused while a Route or Page Project uses the list, so detach it first.
- One list can serve many Routes and Page Projects; an edit applies to all of them at once, so check who uses a list before changing it.

Credentials: never generate, request, or relay basic-auth passwords in chat. Create lists with IP rules, reuse an existing list, or let the user add basic-auth users in the Opfield Console and then attach the list by ID. An agent cannot fetch a basic-auth-protected URL without credentials; a 401 response is the expected evidence that protection applies.
