export const ACCESS_SIGN_IN_DOCS: Record<string, string> = {
  'access-sign-in': `# Access sign-in

Access lists with sign-in methods sign visitors of a protected route or Pages preview in on that route itself: \`https://<route host>/_opfield/access/sign-in\`, served by the route's ingress node (like the maintenance access form). Visitors never reach Opfield. Each route signs in on its own: a visitor signs in once per route. Configure it with \`manage_access_sign_in\` (REST in brackets).

## Settings (admin:system)
- \`settings.get\` / \`settings.update\` (GET/PUT /api/access-settings): \`defaultSessionTtlSeconds\` (300-2592000; a list's own sessionTtlSeconds wins).

## Sign-in methods of a list
\`opfield\` (an account of this Opfield; the visitor confirms through the console session and returns to the route), \`password\` (the list's users on the sign-in page), \`basic\` (HTTP basic authentication on the host itself), \`shared\` (one password), \`idp:<providerId>\`.

## Identity providers (admin:system; reads also acl:view)
- \`identity_providers.list|get|create|update|delete\` (/api/access-identity-providers): \`kind\` google or oidc, \`name\` (the button), \`issuer\` (oidc; Google is https://accounts.google.com), \`clientId\`, \`clientSecret\` (stored encrypted, never returned; omitted on update keeps it), \`groupsClaim\` (claim sso_group rules read), \`trustEmail\` (Trust the provider's email address, default true).
- The provider's email is used when it marks it verified (\`email_verified: true\`) or, with **Trust the provider's email address** (\`trustEmail\`, on by default), when it sends no \`email_verified\` claim (Microsoft Entra ID and some Keycloak or ADFS setups do not); \`email_verified: false\` is never used. \`email\` and \`email_domain\` rules need such an email; \`sso_group\` rules work either way. Turn the option off for a provider that lets users set an unverified email without saying so.
- Register \`https://<route host>/_opfield/access/provider-callback\` (\`redirectUri\` in every response) at the provider for every route whose list offers it. Delete is refused (409) while a list offers the provider.

## Service tokens (acl:edit; reads also acl:view)
- \`service_tokens.create\` (POST /api/access-service-tokens) returns \`clientId\` and \`clientSecret\` once; scripts send them as \`Opfield-Access-Client-Id\` and \`Opfield-Access-Client-Secret\`. A list admits a token only through an Include rule \`service_token\` with the token id. \`expiresAt\` null: never expires.

## Sessions (acl:edit)
- \`sessions.list\` (GET /api/access-sessions; search, accessListId, includeEnded) shows signed-in visitors; \`sessions.revoke\` (POST /api/access-sessions/:id/revoke) ends one: its tokens stop working on every ingress node within seconds. Blocking or deleting an Opfield account ends its sessions too.

## How it works
Ingress nodes check each request themselves against the synced policy (lists, token keys, revoked sessions, service tokens), so access keeps working while Opfield is unreachable (signing in needs Opfield). Interactive sign-in needs an ingress node daemon that serves the sign-in page; on an older one such a list answers 403. A visitor without access is redirected to the route's sign-in page (\`/_opfield/access/sign-in\`); the node asks Opfield over its node channel, sets a token valid for that host only and sends the visitor back, and the upstream receives \`Opfield-Access-Jwt-Assertion\`, \`Opfield-Access-Email\` and \`Opfield-Access-User\`. Tokens are Ed25519-signed; the key rotates every 30 days by itself and its public keys are at \`/.well-known/opfield-access/jwks\`.
`,
};
