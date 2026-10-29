export const ACCESS_SIGN_IN_DOCS: Record<string, string> = {
  'access-sign-in': `# Access sign-in

Access lists with sign-in methods send visitors of a protected route or Pages host to one sign-in page. After signing in there, a visitor opens every route their lists allow without signing in again. Configure it with \`manage_access_sign_in\` (REST in brackets).

## Sign-in domain (settings, admin:system)
- \`settings.get\` / \`settings.update\` (GET/PUT /api/access-settings): \`domain\` (null: the Opfield public URL serves the sign-in page), \`defaultSessionTtlSeconds\` (300-2592000; a list's own sessionTtlSeconds wins), \`signInOrigin\` (read only).
- A domain with \`nodeId\` or \`ingressGroupId\` gets a system route proxied to Opfield, like the status page; \`sslCertificateId\` gives it TLS. Without placement the domain must reach Opfield another way (DNS to the Opfield host, an existing proxy). The domain only serves the sign-in page, its API and \`/.well-known/opfield-access/jwks\`.

## Sign-in methods of a list
\`opfield\` (an account of this Opfield; the visitor confirms through the console session), \`password\` (the list's users on the sign-in page), \`basic\` (HTTP basic authentication on the host itself), \`shared\` (one password), \`idp:<providerId>\`.

## Identity providers (admin:system; reads also acl:view)
- \`identity_providers.list|get|create|update|delete\` (/api/access-identity-providers): \`kind\` google or oidc, \`name\` (the button), \`issuer\` (oidc; Google is https://accounts.google.com), \`clientId\`, \`clientSecret\` (stored encrypted, never returned; omitted on update keeps it), \`groupsClaim\` (claim sso_group rules read).
- Register \`redirectUri\` (in every response) at the provider. Delete is refused (409) while a list offers the provider.

## Service tokens (acl:edit; reads also acl:view)
- \`service_tokens.create\` (POST /api/access-service-tokens) returns \`clientId\` and \`clientSecret\` once; scripts send them as \`Opfield-Access-Client-Id\` and \`Opfield-Access-Client-Secret\`. A list admits a token only through an Include rule \`service_token\` with the token id. \`expiresAt\` null: never expires.

## Sessions (acl:edit)
- \`sessions.list\` (GET /api/access-sessions; search, accessListId, includeEnded) shows signed-in visitors; \`sessions.revoke\` (POST /api/access-sessions/:id/revoke) ends one: its tokens stop working on every ingress node within seconds. Blocking or deleting an Opfield account ends its sessions too.

## How it works
Ingress nodes check each request themselves against the synced policy (lists, token keys, revoked sessions, service tokens), so access keeps working while Opfield is unreachable. A visitor without access is redirected to the sign-in page; after sign-in the page sends them back with a token valid for that host only, and the upstream receives \`Opfield-Access-Jwt-Assertion\`, \`Opfield-Access-Email\` and \`Opfield-Access-User\`. Tokens are Ed25519-signed; the key rotates every 30 days by itself and its public keys are at \`/.well-known/opfield-access/jwks\`.
`,
};
