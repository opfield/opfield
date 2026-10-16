export const PLATFORM_DOCS: Record<string, string> = {
  'opfield-settings': `# Opfield Settings And MCP

Use \`get_opfield_settings\` before changing control-plane settings and \`update_opfield_settings\` with only the fields the user explicitly requested.

## Sign-in And OAuth
- oidcAutoCreateUsers controls whether a valid OIDC login may create an Opfield user automatically.
- oidcDefaultGroupId is the permission group assigned to automatically created users.
- oidcRequireVerifiedEmail requires the provider to assert a verified email.
- oauthExtendedCallbackCompatibility allows unverified public OAuth clients to use external HTTPS callbacks. Loopback callbacks are the safer default. External callbacks are marked as higher risk in consent.
- generalSettings.sendInvitationOnUserCreate (off by default, needs verified SMTP) emails every account created in Users, the API or MCP an invitation with a sign-in link; a failed send does not block the account, and the invitation can be sent again from the user's settings.
- generalSettings.autoAssignCreatedResourcePermissions (on by default) adds view of a created resource, plus the per-resource permissions the creator already holds for it, to the creator's additional permissions. Turning it off affects new resources only.
- \`oidc\` sets the OIDC provider (one per installation; admin:system). \`oidcProviderAction: "remove"\` removes it and turns OIDC sign-in off. \`oidcProviderAction: "opfield_account"\` is Use Opfield account for sign-in, on any installation connected to Opfield Cloud (\`opfieldAccountSignIn.available\` in get_opfield_settings; otherwise 409 OPFIELD_ACCOUNT_CLIENT_MISSING): with a client the cloud already gave (\`opfieldAccountSignIn.clientIssued\`, e.g. a managed installation) it brings back the "Opfield account" provider and turns OIDC sign-in on at once; without one it asks the Opfield account for a client for \`<public URL>/auth/callback\` (409 PUBLIC_URL_REQUIRED without a public URL) and \`opfieldAccountSignIn.pendingRequest\` shows the wait; when the account answers, the provider is set up and OIDC sign-in turns on (Settings updates by itself). Asking again does not add a request; \`oidcProviderAction: "cancel_opfield_account"\` withdraws it. Users signing in with it are matched by the installation's usual OIDC rules (automatic user creation, default group, verified email), nothing special. Removing or replacing the provider, a provider with another issuer, and turning a sign-in method off are refused with 409 LAST_ADMIN_SIGN_IN when no administrator could sign in afterwards; give another administrator a sign-in method that stays first. \`opfieldAccountSignIn.detached\` means the cloud link ended or moved to another account but the Opfield account provider stayed because no other administrator could sign in.
- In the UI these live under Settings > Authentication (Sign-in methods, Multi-factor authentication, OIDC provider, Identity provisioning).

## MCP
- mcpServerEnabled enables the remote MCP endpoint. MCP still requires an OAuth token issued for the MCP resource and the owning user must have \`mcp:use\`.
- Opfield MCP exposes the GitLab, GitHub, generic Git and external SSH tools to tokens that hold the matching integration scopes; only \`gitlab_clone_repository_to_sandbox\` stays chat-only because it needs the AI sandbox. Managed DNS uses the ordinary Domains tools and \`domains:*\` scopes.
- Extended MCP compatibility is enabled by default and returns every OAuth-scoped tool in the initial \`tools/list\` response. When an administrator disables it, MCP starts with a compact core toolset: \`discover_tools\` activates domain toolsets, Opfield sends \`notifications/tools/list_changed\`, and the client refreshes \`tools/list\`.
- The \`Ingress\` toolset covers Domains, Routes, route folders, nginx templates, access lists, raw route configuration, managed manual/Docker/Pages upstreams, and the canonical maintenance lifecycle. Route tools use UI-aligned names and arguments; resource URIs, scopes, REST paths, and persisted identifiers keep their existing compatibility contracts.
- Use \`manage_additional_route\` for path-prefix locations inside a Route. It supports manual, standalone Docker container, Compose-service, Docker deployment, and Pages Tag targets plus location advanced config. Docker and Compose targets create and own their required Secure Link binding.
- Use \`manage_additional_secure_link\` for extra bindings referenced by a Route advanced nginx config. It supports Docker destinations and the managed S3 destination via \`upstreamKind: "managed_storage"\` plus \`managedStorageId\`; the managed-storage path uses a private relay without a shared Docker network, published port, or root credential. Route-owned bindings are visible in its list but must be changed through \`manage_additional_route\`, not deleted independently.
- The \`Docker\` toolset exposes Compose lifecycle and revisions, Git source settings and Build Secrets, Build Worker-filtered history, logs, cancellation, and retry. The \`Pages\` toolset exposes Page Projects, Deployments, Tags, runtime configuration, profile settings, project migration, Git-source builds, and an MCP-only resumable artifact uploader. Upload chunks are base64-encoded, capped at 1 MiB decoded, and authenticated by the MCP connection rather than a token argument. The \`Databases\` toolset includes managed database provisioning and standalone-container, deployment, or Compose-service bindings. The \`Storage\` toolset covers external and managed storage connections, object operations, managed-storage lifecycle, private workload links, scoped IAM keys, and the MCP-only resumable object uploader.
- MCP clients can call \`read_opfield_documentation\` or read \`opfield://docs\`. General operator topics are available to every valid MCP grant; subsystem topics remain filtered by the delegated OAuth scopes. \`opfield://access\` (also \`get_my_access\` and REST \`GET /api/auth/me/access\`) describes the caller's folders, nodes and resources, and \`opfield://skills\` serves the agent skills that match the running Opfield version, also offered as \`skill-<name>\` prompts.
- mcpExtendedCompatibility is enabled by default. It returns every OAuth-scoped tool in the initial \`tools/list\` response and omits \`discover_tools\`. Disable it only when a harness loads every tool schema into its context at once and exhausts that context; disabling it can leave that harness unable to use some Opfield tools.

## General And Network Settings
- generalSettings contains feature flags and shared limits. Inference is disabled by default under Settings > General > Features and updates.
- generalSettings.publicUrl is the canonical URL of the console (Settings > General > Access and limits). Saving settings restarts Opfield only when internal HTTPS is switched or the public URL changes while internal HTTPS is on; every other change applies without a restart.
- generalSettings.hideExternalBranding hides Opfield branding on public system pages.
- generalSettings.relayPolicyLeaseHours (1-168, default 72) is how long a relay keeps accepting traffic under the last signed policy while Opfield is unreachable; it is set on Settings > Relay. relayGrantTtlHours (1-224, Settings > General > Access and limits) is the lifetime of newly issued relay grants.
- generalSettings.updateChannel is \`stable\` or \`preview\`. Stable is the default and accepts production releases only. Preview also allows GitHub prereleases tagged as \`vX.Y.Z-rc.N\` for Opfield and with the required component suffix for Relay and managed node daemons, for example \`vX.Y.Z-rc.N-relay\` or \`vX.Y.Z-rc.N-docker\`. It does not change Inference Core updates.
- networkSecurity controls trusted private destinations and outbound request restrictions.
- outboundWebhookPolicy controls allowed webhook destinations.

Never weaken callback, network, or webhook restrictions without explaining the resulting external-data or SSRF exposure and receiving explicit user approval.`,

  'licensing-updates': `# Licensing And Updates

## Licensing
- \`get_license_status\` reads tier, installation ID, expiry, grace state, and masked key metadata.
- \`manage_license({ operation: "activate", licenseKey })\` activates a key. Treat the key as a secret and never repeat it in chat.
- \`manage_license({ operation: "check" })\` refreshes the current state.
- \`manage_license({ operation: "clear" })\` removes the active key and is destructive.
- Read the live license status instead of inferring access from visible UI. Disk-image volume creation requires Personal or higher; other protected capabilities are governed by their advertised entitlements and quotas.

## Cloud Account Connection
- \`get_cloud_status\` reads whether this Opfield installation is connected to a cloud account: the account email, portal URL, connected since and the socket state (online, connecting, reconnecting with its last error), or when and why the account disconnected it.
- \`manage_cloud({ operation: "connect", code })\` connects with the single-use \`CLD-XXXX-XXXX\` code from the installation's page in the cloud account (valid 10 minutes); it is the only way to connect: ask the user to copy it from their Opfield account. Connecting again with a code from another account switches accounts and replaces the previous connection. Treat the code as a secret and never repeat it in chat.
- \`manage_cloud({ operation: "set_remote_management", enabled })\` turns "Allow remote management" on or off (off by default, audited as \`cloud.remote_management\`). Reads need no switch; node-token, update and setup-link requests from the account need it on, or a managed cloud VM (enrolled from its provisioning file, shown as Managed by the cloud). A refused request answers REMOTE_MANAGEMENT_OFF and is audited. A setup code is issued only while no user exists. An sso-client request (the Opfield account sign-in client the account created after Use Opfield account for sign-in asked for one through the hello's \`ssoClientRequest\`) and an sso-secret request (a new secret for that client) need no remote management: sso-client is taken only while this installation's request is pending and for the same redirect URI (a managed installation also takes one it did not ask for), refused otherwise with SSO_CLIENT_NOT_REQUESTED or INVALID_SSO_CLIENT; sso-secret is taken by a managed installation or one the account gave a client, and refused with OPFIELD_ACCOUNT_PROVIDER_MISSING (nothing changes) when there is no such client or the admin removed that provider or switched it to another client. Both are stored encrypted and audited without the secret. When the installation disconnects, the account disconnects it, or it connects to another account (Switch account), the client is forgotten and the "Opfield account" provider on it removed with OIDC sign-in off, unless no administrator could sign in then: the provider stays, signing in as before but no longer as the cloud's client (no secret rotation; \`opfieldAccountSignIn.detached\`), and \`cloud.managed_sso\` step provider_kept carries the warning. A pending request for a client is dropped on Switch account; Use Opfield account asks the new account. Connecting again to the same account (same email) keeps the sign-in.
- An sso-revoke request (the account removed people's access: removed_from_team, access_removed, installation_moved or account_suspended; params issuer, subjects = account ids as OIDC sub, reason) needs no remote management. Users bound to that issuer with those subjects, whichever provider is active now, are blocked by the Opfield account: \`blockedBy: "opfield_account"\` on the user (an administrator's block is \`"admin"\`), browser sessions end, live connections close as on any block, and API, OAuth and MCP tokens are refused while blocked (kept, not deleted). Users shows "Blocked by the Opfield account". The user's next sign-in through the same issuer lifts it (audited \`user.opfield_account_unblock\`); an administrator's block is never lifted by a sign-in; \`set_user_blocked\` with blocked false lifts either, with blocked true turns it into an administrator's block. The last active system administrator is never blocked this way (answer \`kept\` with LAST_SYSTEM_ADMIN). It answers \`{ revoked: [{ sub, userId }], unknown: [sub] }\`, invalid params INVALID_SSO_REVOKE, and is audited as \`cloud.sso_revoke\` with the reason and the users. The hello carries \`ssoRevoke: true\`.
- \`manage_cloud({ operation: "disconnect" })\` revokes the connection at the account and forgets it here. If the account cannot be reached the connection is still forgotten here and the result carries a \`warning\`: tell the user to disconnect the installation in the cloud account too.
- A managed installation (enrolled from its provisioning file, shown as Managed by Opfield Cloud) stays connected to its account: \`disconnect\` and \`connect\` are refused with 409 CLOUD_MANAGED ("A managed cloud installation stays connected to its account."), as they are in Settings, which shows no Switch account or Disconnect there. The account refusing a disconnect (MANAGED_INSTALLATION) answers the same and keeps the connection. Its addresses are the cloud's too: the public URL, gRPC public target and gRPC local IP (general settings), internal HTTPS on port 3000 (webTlsEnabled), network trust (client IP source, trusted proxy CIDRs, Cloudflare headers) and the status page upstream URL (\`manage_status_page\` settings) answer 409 CLOUD_MANAGED when changed; resubmitting them unchanged is fine. So do \`manage_license\` activate and clear (the license is the Opfield account's; check works, and get_license_status carries cloudManaged). Sign-in is not locked: as on any installation, the owner may edit or remove the "Opfield account" OIDC provider, add their own provider, turn OIDC sign-in off, use password or email-code sign-in, and switch the owner to another sign-in method; only the generic rule that some administrator must still be able to sign in applies (LAST_ADMIN_SIGN_IN). \`update_opfield_settings({ oidcProviderAction: "opfield_account" })\` (Settings > Authentication > OIDC provider > Use Opfield account) brings the Opfield account sign-in back at any time; self-hosted installations connected to Opfield Cloud use the same action. A restored configuration export forgets the source installation's cloud link and its Opfield account client.
- Add-ons of a managed installation, set by the account over the link (an installation the cloud does not manage refuses them with NOT_MANAGED_BY_CLOUD). Custom domain (\`public-alias\`): one host name per installation; Opfield gets its Let's Encrypt certificate over HTTP-01, serves it next to \`<name>.opfield.cloud\` and renews both, then the public URL becomes \`https://<custom domain>\` (get_opfield_settings: \`cloudPublicAlias\` with domain, state none/issuing/active/failed, error and \`baseUrl\`). The original address keeps working in the browser, node setup commands keep using it, and the public URL stays locked (CLOUD_MANAGED). A failed issuance is retried only from the account, at most every 10 minutes. After a switch, passkeys registered on the old host stop working and MCP clients sign in again. Cloud email (\`mail-config\`): sign-in emails go to the account over the link and leave from \`<name>@mail.opfield.cloud\` within the plan's limits; get_opfield_settings shows \`smtp.transport: "cloud"\` and \`smtp.cloud\` (from, limits, ownSmtp), and \`smtp.configured\`/\`verifiedAt\` describe the cloud email, so email sign-in needs no SMTP. An email over a limit (MAIL_QUOTA), refused (MAIL_INVALID) or of an unknown kind (MAIL_KIND) fails without retries. \`update_opfield_settings({ smtpTransport: "smtp" })\` is Use my own SMTP (admin:system; refused with SMTP_NOT_VERIFIED while password or email-code sign-in is on and the saved SMTP is not verified; send \`smtp\` with \`testRecipient\` together), \`"cloud"\` goes back; \`mailTest: { recipient, kind }\` sends a test through the transport in use. AI add-on (\`inference-cloud\`, paid in the Opfield account): Opfield turns inference on, installs the inference core, connects an OpenAI-compatible provider "Opfield Cloud" (\`cloudManaged: true\` in list_connections, with \`cloudUsage\`: the share of the plan used per window, read by Opfield with the add-on key, which never leaves the backend) and publishes its models (opfield-swift, opfield-heavy) to everyone. That connection and those models answer 409 CLOUD_MANAGED ("Managed by your Opfield account") to update, disconnect, save and delete through \`manage_inference_provider\`, \`manage_inference_model\` and the API; reordering and sync work. When the add-on ends, its models and the connection are removed.
- Every connect, disconnect, disconnect by the account and each request the account sends over the socket has its own audit entry (resource type \`cloud-link\`, actions \`cloud.connect\`, \`cloud.disconnect\`, \`cloud.disconnected_by_account\`, \`cloud.sso_revoke\`, \`cloud.request\` with the request type, service, tail/since, request id, result and result size). Identical successful reads of the same type and service within 10 minutes of the first one are counted, not written one by one: the first read has its own entry and the repeats get one summary entry (details.summary: count, first and last time, total bytes) when the 10 minutes end, the socket stops or Opfield shuts down. Failed reads always have their own entry. \`get_cloud_status\` also returns the 5 latest entries with their read counts.
- A connected Opfield installation keeps one outbound socket to the account, which reads this Opfield installation's host state, its own containers, their logs and the update status through it, and can ask for a first-admin setup code (only before setup), a one-time node enrolment token with its install command, and start the Opfield update Settings offers; for sign-in it sends sso-client, sso-secret and sso-revoke (see above). Actions and failed requests always have their own audit entry. A managed installation enrols itself on start from \`/var/lib/gateway/cloud-enroll.json\` and activates the paid license key in it as Settings > Update license does (audited as \`cloud.connect\` and \`license.activate\` with source enroll-file, and \`cloud.enroll_file\` when the file is removed once every step succeeded or was refused for good). When the file also carries \`sso\` and \`owner\`, an installation without an administrator comes up set up: public URL, an OIDC provider "Opfield account" (the account portal as issuer), the owner as system administrator bound to issuer and sub, and setup marked complete, all in one step or not at all (each step audited as \`cloud.managed_sso\`, never with the secret). The client secret leaves the file once stored. The provider is a normal OIDC provider: it can be renamed, edited, replaced or removed in Settings, refused only while no other administrator could still sign in. The client stays kept apart, so the Opfield account can be brought back; a reinstall that delivers a new client while the admin uses another provider only keeps the new client (\`cloud.managed_sso\` step client_kept). Uses the license scopes: license:view to read, license:manage to change.

## Opfield And Daemon Updates
- Read \`generalSettings.updateChannel\` before interpreting update results. \`stable\` excludes release candidates; \`preview\` also accepts GitHub prereleases tagged as \`vX.Y.Z-rc.N\` for Opfield and component-suffixed tags such as \`vX.Y.Z-rc.N-relay\` or \`vX.Y.Z-rc.N-docker\` for Relay and managed node daemons. Inference Core remains on its independent stable signed channel.
- Use \`manage_system_updates({ operation: "get_opfield_status" })\` or \`manage_system_updates({ operation: "check_opfield" })\` before proposing an update.
- Read release notes with \`manage_system_updates({ operation: "get_opfield_release_notes", version })\` for the exact advertised version, or \`list_opfield_release_notes\` for every release between the current and the available version.
- Apply an app update with \`manage_system_updates({ operation: "perform_opfield_update", version })\` only after explicit approval. The update first checks free disk space, then waits for running deploys, drains, Availability and Compose operations, build rollouts and Docker migrations (status \`waiting_for_operations\`, up to 15 minutes by default) while new ones are refused; \`proceed_opfield_update\` ("Update now") stops waiting, and recovery resumes what still runs. It snapshots the Opfield database before the new version starts and restores it if the update fails. \`acknowledge_opfield_update_failure\` clears a reported failure.
- Use the \`list_daemon_updates\` and \`check_daemon_updates\` operations before \`manage_system_updates({ operation: "update_daemon", nodeId })\`; pass the exact nodeId and verify the node reconnects on the expected version. Daemon updates are refused for disconnected nodes, relay nodes (use \`perform_relay_update\` for the Relay Pool) and nodes that already run the release; nodes that share an Availability policy update one after another.
- A daemon update waits first for the long tasks running on its node: backups, image builds, Docker migrations, image pulls, container actions, storage copies, container archive transfers (\`waitingForTasks\` in the result, \`metadata.updatePhase: waiting_for_tasks\` and \`metadata.updateWaitingForTasks\` on the node). After 30 minutes it goes ahead and keeps a warning. \`now: true\` updates at once, also for an update that already waits (for tasks or for its lease peers); the running tasks may fail and a lease peer may be down at the same time, so pass it only after the user confirmed exactly that.
- An update of a Docker or nginx node whose daemon advertises \`daemon_stream_handover_v1\` keeps relay stream sessions (a pause of a second or two). Raw streams of older peers, PostgreSQL links where the daemon opens TLS, registry pulls and pushes, and backup runs are cut as before; the first update onto this release and a rollback below it cut once. \`lastHealthReport.updateConnections\` shows what an update now would keep and cut; \`metadata.lastUpdate\` keeps the result of the last update (warnings, \`serviceRestart\` when the daemon restarted its whole service for a newer launcher or says why not, and in \`connections\` the kept and cut counts by class; class \`uncounted\` means every connection of the node was cut and no daemon counted them: the update came from a daemon that cannot hand connections over, such as the first update from 2.11.3, or a rollback put one back; \`service_restart\` next to it counts the restart of the whole service the new daemon did once right after such an update for its newer launcher).
- A node's \`capabilities.launcherVersion\` is the launcher its daemon runs under; the launcher updates itself in place after a daemon update. A node on a 2.11.4 or later daemon without it (a launcher started before 2.11.4) restarts its whole service once on its next daemon update: that update hands nothing over and cuts open connections once (class \`service_restart\`; \`handoverAvailable: false\` in \`lastHealthReport.updateConnections\` beforehand), and the service starts with the updated daemon's launcher. Later updates keep connections. Opfield waits up to 4.5 minutes for an updated daemon, as long as its launcher keeps it on trial; a daemon that comes back on the previous version was rolled back, and the stopped candidate handed its connections to it.
- Never invent a version, claim an update completed before its status confirms success, or update unrelated daemons as a side effect.

## Moving Opfield To Another Host
- \`manage_configuration_export({ operation: "estimate" })\` reads the sizes (database, Opfield files, internal registry, managed logs) and the values the new host keeps instead (public address, passwords, .env host overrides, sign-in sessions). Requires admin:system.
- \`manage_configuration_export({ operation: "export", passphrase, includeRegistry, includeLogs })\` returns a one-time link (15 minutes) and a curl command that saves the encrypted \`.opfield-export\` file. It holds the database (consistent snapshot, nothing stops), the master key, every CA key, the relay policy signing keys, Opfield's files, the commercial core and, when asked, the registry images and managed logs. Ask the user for the passphrase (12+ characters) and never repeat it; it is not stored. \`progress\` with the exportId follows the download. Audited as \`system.configuration_export\` (or \`system.configuration_export_failed\`).
- The restore runs in the setup wizard of a fresh installation of the same Opfield version ("Restore from an export") or with \`install.sh --restore <file>\`; it keeps the installation ID and license and asks for the new address.
- When the address changes, \`announce_move\` with the new \`host:port\` before the old installation is shut down tells every connected node and relay; each keeps it and switches once this installation stays unreachable for 10 minutes and the restored one answers with the same System CA. \`move_status\` lists nodes told, offline, or on a daemon too old to take it (update those first, keep DNS, or edit the control-plane \`address\` in the daemon config on the node). \`withdraw_move\` takes it back. Audited as \`system.opfield_move_announced\` / \`system.opfield_move_withdrawn\`.`,

  inference: `# Opfield Inference

Opfield Inference is a standalone external model gateway. It is not the AI Workspace provider configuration and it is not Opfield MCP. It has separate provider credentials, model configuration, scopes, accounting, continuation state, and dedicated \`opfi_\` runtime tokens. Never use a normal \`opf_\` API token, a \`opfo_\` OAuth token, a Workspace provider key, or an MCP credential on the inference data plane.

## Availability

Inference is disabled by default. Read Opfield settings first. An administrator with \`settings:opfield:edit\` can enable it through \`update_opfield_settings\`:

\`\`\`json
{
  "generalSettings": {
    "features": { "inferenceEnabled": true }
  }
}
\`\`\`

No restart is required. If inference is disabled, inference tools fail instead of bypassing the feature gate.

## Administrative Tools

- \`manage_inference_provider\`: list templates/connections, connect API keys, start or inspect supported authorization flows, sync, rename, enable/disable, configure quota reserves/API budgets/routing, or disconnect.
- \`manage_inference_model\`: list models, inspect account suggestions, atomically create/replace a complete model configuration, or delete a model.
- \`manage_inference_limits\`: list default/per-user policies and configure or remove overrides. The current Assistant tool does not reset accumulated usage baselines.
- \`manage_inference_usage\`: self and self_overview (the caller's usage and remaining budget; feat:ai:use), system (Opfield-wide overview; \`unpriced\` lists models whose requests ran without a price in the last 7 days), users (per-user usage), activity_filters, and activity (request log filtered by search, status, userId, model; paginated; \`costUnknown\` marks a request with no price). system, users, and activity need inference:usage:view.
- \`manage_inference_token\`: list, create, update (name, expiresAt, allowedIps), or revoke the current user's \`opfi_\` tokens. It cannot issue a token for another user. expiresAt is an ISO date-time in the future (null: no expiry); allowedIps holds up to 20 IPv4/IPv6 addresses or CIDR ranges ([] allows any). An expired token is refused and removed by housekeeping after the Expired Tokens period.

Always inspect current state before mutation. Use \`internal_documentation({ topic: "inference" })\` before multi-step inference work.

## Provider Workflow

1. Call \`manage_inference_provider({ operation: "list_templates" })\` and use the returned provider ID. Never invent template IDs.
2. For API/local providers, call \`connect_api_key\` with the name, providerId, and only the secret/URL fields supported by that template. Never repeat the API key.
3. For supported device/OAuth providers, call \`start_authorization\`. Subscription connectors require the exact returned termsVersion and explicit user approval before acceptTerms may be true. Never infer or silently accept connector terms.
4. Return the authorization URL/user code. For device flows, call \`wait\` and then \`authorization_status\`; Opfield polls automatically. Redirect/paste-callback providers must be completed in **Settings > Inference**. Never ask the user to paste an OAuth callback URL or authorization code into AI chat.
5. Call \`sync\`, then verify discoveredModels, quota, status, and syncStatus.

Each connection row is one account or API key. There is no Pool resource. Opfield groups compatible connections automatically per provider/model:

- \`balanced\`: distributes new threads across every connection whose reported quota is above its configured minimum, weighted by remaining quota, while retaining thread affinity;
- \`sequential\`: uses the lowest routingOrder connection until unavailable, then moves down the list.

Subscription connections can set minimumRemainingPercent from 1 to 100. The same configured threshold applies to new and existing threads; a connection is routable only while every reported quota window remains strictly above it. API connections can set apiMonthlyLimitUsd; null means no per-connection cap. Disconnecting or disabling is blocked when it would leave a published model without a route.

## Model Workflow

1. List synchronized provider connections and select a discovered model.
2. Call \`manage_inference_model({ operation: "save", configuration })\`. Omit modelId to create; include modelId to replace the entire configuration atomically.
3. A logical model may use one or more compatible sources, including different provider templates or upstream models. Every enabled source must satisfy the published modalities, capabilities, reasoning map, and technical limits. Opfield may retry another source only before client output begins and keeps the same request/accounting lineage across that retry.
4. Configure publicId, displayName, contextWindow, maxInputTokens, optional maxOutputTokens, autoCompactTokenLimit, modalities, capabilities, reasoning efforts, subscriptionMultiplier, sources, pricing, and access. For API-backed models the schema still requires subscriptionMultiplier; pass \`1\`. API accounting ignores it, and the UI intentionally does not expose it.
5. Access mode is \`everyone\`, \`selected\` with user/group subjects, or \`disabled\`. Never publish without an enabled, available source.
6. reasoningEffortMap maps client efforts to provider efforts, for example \`{ "ultra": "max" }\`. Every advertised effort must be representable by every enabled source. The reasoningEfforts array order is preserved in the backend and determines selector/manifest order.
7. API pricing is versioned. Pricing values are integer microdollars per million tokens: $5.00 per million tokens is 5,000,000 microdollars. Prefer synchronized/known pricing; use manual pricing only when provider metadata is unavailable. Pricing is optional: an API source with no input/output price (list shows \`priceMissing: true\` and the model \`priceWarning\`) still serves requests. Their tokens are recorded, their cost is unknown (\`costUnknown: true\` in activity, not $0), they are not charged to or refused by API budgets, and \`manage_inference_usage\` system lists them under \`unpriced\`. Tell the user and offer to set a price.

\`save\` is the only model mutation workflow. Do not attempt partial model/source/pricing/access updates.
Published model order is persisted separately and controls API catalog and AI Workspace ordering. The current Assistant model tool does not expose reorder; use the Inference settings UI or the documented reorder REST endpoint.

## Default And Per-user Limits

\`manage_inference_limits\` uses one complete policy object. \`enabled\` controls inference access. Subscription windows use credits5hEnabled/credits5h, credits7dEnabled/credits7d, and credits30dEnabled/credits30d. One public subscription credit represents 1,000,000 weighted tokens before model, dynamic-burn, and service-tier multipliers. A disabled window is unlimited; if all three are disabled, subscription-credit usage is unlimited. apiMonthlyMicrodollars is the user's monthly API budget and 0 disables API usage. When API usage is disabled, models whose usable sources are API-only are omitted from OpenAI, harness, and internal Assistant catalogs for that user. billingTimezone is an IANA timezone. Per-user policies override the default policy. Administrators can reset all four usage baselines for one user from the Inference limits UI or \`POST /api/inference/limits/users/{id}/reset\`; this preserves immutable request/ledger history and is not currently exposed by \`manage_inference_limits\`.

## User Tokens And Harness Setup

Users need \`feat:ai:use\` for Opfield Inference access, personal usage visibility, and creation or revocation of their own inference tokens. AI Workspace access is controlled separately by \`ai:workspace:use\`.

Token options:

- UI: **Profile > Authorizations > Inference API tokens**;
- AI: \`manage_inference_token({ operation: "create", name: "Laptop", expiresAt?, allowedIps? })\` for the current user.

The \`opfi_\` secret is shown once. Never repeat it after creation, store it in assistant history, or expose it to another user.

### Recommended harness setup

An administrator must first enable **Inference** in **Settings > General**. Before giving harness setup instructions, call \`get_opfield_settings\` when it is available and report \`generalSettings.features.inferenceEnabled\`. Without that read permission, do not guess its value: explain that an administrator must confirm it.

Recommend [DeepSeek harness](https://www.deepseek.com/en/harness/), configured natively with Opfield as its OpenAI- or Anthropic-compatible provider. Any other harness or tool that accepts such a provider is set up the same way. In the UI, **Settings > Inference > Endpoint > Set up** opens **Set Up an Inference Harness**, which shows everything to paste into the harness's provider settings:

- OpenAI-compatible base URL: \`https://opfield.example.com/api/inference/v1\`;
- Anthropic-compatible base URL: \`https://opfield.example.com/api/inference\` (Anthropic clients append \`/v1/messages\` themselves);
- API key: a new \`opfi_\` inference token the dialog creates for the current user and shows once; unused keys from earlier openings of the dialog are revoked;
- Model: any model the user can call (\`GET <OpenAI base URL>/models\`).

Without the UI, create the key with \`manage_inference_token\` and give the same values.

### Manual OpenAI-compatible setup

\`\`\`text
Base URL: https://opfield.example.com/api/inference/v1
API key:  opfi_...
Models:   GET <base-url>/models
\`\`\`

Use this base adapter for OpenAI SDKs and OpenAI-compatible clients. It supports Responses and Chat Completions.

### Manual Anthropic-compatible setup

\`\`\`text
Anthropic SDK base URL: https://opfield.example.com/api/inference
Direct REST prefix:     https://opfield.example.com/api/inference/v1
API key:                opfi_...
\`\`\`

Anthropic SDKs append \`/v1\` themselves, so configure the SDK base URL without \`/v1\`. Direct HTTP clients call \`/api/inference/v1/messages\`. Dedicated \`opfi_\` tokens work as Bearer credentials and as \`x-api-key\`.

## Safety And Verification

- Management tools enforce the caller's actual inference scopes; never work around a permission error.
- Provider credentials are encrypted and list operations return masked metadata only.
- Activity stores metadata and normalized usage, never prompts or model output.
- After configuration, verify provider sync, model visibility, a small request, accounting, reasoning mapping, tools, continuation, compatible pre-output fallback, and Codex auto-compaction where applicable.
- Opfield Inference runtime and credentials remain isolated from the assistant configuration. The assistant may use a published Opfield Inference model only when an administrator explicitly selects that provider type.`,
  'ai-settings': `# AI Workspace Settings

AI Workspace settings control the provider, request limits, tool exposure, web search, and sandbox runner. Use these tools instead of guessing from UI labels:

## Tools
- get_ai_settings: read provider, model, limits, system prompt, tool access, web search, and sandbox runner settings.
- update_ai_settings: update supported assistant settings. Send only fields that should change.
- list_ai_tools: list available assistant tools with categories, scopes, descriptions, and whether they are destructive.
- get_sandbox_runtime_status: read sandbox runner enablement and runtime health.

## Provider Settings
- providerType: openai_compatible or opfield_inference. Opfield Inference is available only while the inference feature is enabled.
- providerUrl: OpenAI-compatible API base URL.
- endpointMode: auto, chat_completions, or responses.
- model: provider model name.
- apiKey: only set this when replacing the stored provider key. The current secret is never returned in full.
- opfieldInferenceModel: default published Opfield Inference model ID.
- opfieldInferenceAllowUserModelSelection: whether users may choose another model they are allowed to access.
- allowUserReasoningEffortSelection: whether users may override the default reasoning effort for the OpenAI-compatible provider. Opfield Inference uses each published model's own reasoning capabilities instead.
- OpenAI-compatible provider values are preserved while Opfield Inference is selected. Disabling inference restores them; if no OpenAI-compatible key was saved, the assistant is disabled.

## Limits
- rateLimitMax and rateLimitWindowSeconds: rate limit for assistant requests.
- maxToolRounds: maximum sequential tool-call rounds in one assistant run.
- maxContextTokens: context budget used by the conversation builder.
- maxCompletionTokens and maxTokensField: response token cap and provider field name.
- reasoningEffort: default OpenAI-compatible provider effort: low, medium, high, or none. Use none to leave reasoning unspecified. Opfield Inference ignores this setting.

## Tool Access
- disabledTools: exact tool names hidden from the assistant.
- webSearchProvider, webSearchBaseUrl, and webSearchApiKey: provider selection, optional provider URL, and secret replacement for web search. Tavily is the default; Brave, Serper, Exa, and SearXNG are also supported. API-backed providers require a stored key, while SearXNG requires its base URL. The web_search tool is exposed only when the effective settings configure the selected provider.
- sandboxEnabled and sandboxDefaultTier: sandbox runner exposure and default tier.

## Sandbox Runner
- sandboxEnabled: expose sandbox execution and artifact tools to the assistant.
- sandboxDefaultTier: default resource tier. The agent may request a tier only if the user has the required scope. Tier workspace sizes are soft quotas; the runner refuses new reservations at 80% host-disk use and removes workspaces at terminal cleanup.
- Sandbox tools are intentionally excluded from MCP exposure and are available only to the assistant when enabled and permitted.`,

  gitlab: `# GitLab Integrations

Opfield GitLab connectors are configured by admins in Settings -> Integrations. Embedded AI users authorize each connector with their own encrypted PAT unless integrations:gitlab:use covers the project (use the connector's system credential). Opfield MCP exposes the same GitLab tools with the same checks, except cloning into the AI sandbox.

## Scope Restrictions
- GitLab scopes can be limited to a connector (\`<scope>:<connectorId>\`), a group with its subgroups (\`<connectorId>/group/<groupId>\`) or one project (\`<connectorId>/project/<projectId>\`). IDs are GitLab's numeric IDs, not paths.
- Every project tool checks the project: the unqualified scope, the connector, any group containing the project (resolved from GitLab, so a moved project follows its new group), or the project itself. Implied view applies per qualifier.
- gitlab_list_connectors and gitlab_list_projects only return connectors and projects the caller's grants cover. A project outside the grant answers like an unsynced project (404 GITLAB_PROJECT_NOT_FOUND), so a 404 for a known project usually means the caller's grant does not cover it.
- Connector management (sync, allowlist changes, settings) needs integrations:gitlab:manage on the connector or unqualified.
- Without integrations:gitlab:use covering the project and without a personal PAT, a 403 names integrations:gitlab:use and the project.

## Discovery
- Use gitlab_list_connectors to find enabled connectors.
- No connector is a setup choice, not a terminal failure. For a GitLab repository, ask the user whether they want a shared GitLab-instance connector or a generic connector scoped to this repository before treating repository inspection as unavailable.
- If Opfield asks for GitLab authorization, wait for the user to complete or cancel the authorization modal. Never ask the user to paste a PAT into chat.
- Use gitlab_list_projects or gitlab_search_projects to find projects already synced through Opfield allowlist rules.
- Project arguments accept the synced project remote ID or full path.
- Every GitLab tool except gitlab_list_connectors requires the exact connectorId UUID from gitlab_list_connectors or from a prior GitLab project result. Do not use connector names, project paths, or blank values as connectorId.
- If a visible GitLab project exists but is not enabled in the connector allowlist, use gitlab_add_connector_projects with explicit approval, then gitlab_sync_connector.
- Do not guess connector IDs or scan GitLab directly outside these tools.

## Repository Access
- Prefer direct API tools for ordinary read/write work:
  - gitlab_list_repository_tree for folders.
  - gitlab_read_file for bounded file reads. Use offset and length for large files.
  - gitlab_commit_files for create/update/delete/move commits.
- Use gitlab_clone_repository_to_sandbox only when local analysis, tests, or multi-file tooling actually requires a checkout.
- After gitlab_clone_repository_to_sandbox, wait for CLONE_READY with read_process_output, then inspect the checkout through list_artifact_files/read_artifact on the returned processId. Do not call run_process merely to list or read cloned repository files.
- Clone runs with connector-configured limits: shallow clone, depth, LFS/submodule settings, max size, and timeout.

## CI
- Use gitlab_lint_ci_config before committing CI changes.
- Use gitlab_update_ci_config for the first-class .gitlab-ci.yml edit workflow. Invalid CI config is not committed.
- Use pipeline/job tools to inspect CI status and bounded job logs.

## Variables, Webhooks, and Deploy Tokens
- gitlab_list_project_variables returns metadata only (keys and flags, never values) and needs integrations:gitlab:repo:read. github_list_actions_variables returns values, which are secrets, so it needs integrations:github:repo:write.
- gitlab_set_project_variable accepts a secret value but the value must not be repeated in responses or explanations.
- gitlab_delete_project_variable always requires explicit tool approval.
- Webhook management uses GitLab project webhook tools and must respect connector allowlist and Opfield scopes.
- gitlab_create_deploy_token captures the raw deploy token only inside Opfield, encrypts it as connector-managed credentials, and returns masked metadata only.
- If a project registry is disabled, use gitlab_update_project_settings with containerRegistryAccessLevel=enabled after approval. That tool runs a connector sync afterward and reports sync or syncError; use gitlab_sync_connector only if you need to retry a failed sync or refresh metadata later.

## Safety Rules
- Opfield scopes, connector allowlist, provider capabilities, and tool approval rules are authoritative. GitLab PAT permissions are only an upper bound.
- Direct commits to protected/default branches are allowed only when Opfield approval rules and the GitLab PAT both allow it.
- Never ask the user to paste connector PATs, deploy token values, or project variable secrets into chat unless the current tool call explicitly needs one-time secret input.
- Audit logs store metadata and optional diff hashes, not raw secrets or full diffs.`,

  notifications: `# Webhook Notifications

## Overview
The notification system sends HTTP webhook notifications when alert conditions are met. It supports threshold-based alerts (a metric such as CPU, disk, a route's 5xx share or response time crosses a value) and event-based alerts (node offline, container stopped, an app environment failing, etc.). \`GET /api/notifications/alert-rules/categories\` lists every category with its metrics, events and variables; a rule's metric or event must be one of its category's (others are refused with INVALID_ALERT_RULE).

## Tools
- Alert rules: list_alert_rules, get_alert_rule, create_alert_rule, update_alert_rule, delete_alert_rule (notifications:alerts:view to read, notifications:alerts:manage to change).
- Webhooks: list_webhooks, create_webhook, update_webhook, delete_webhook, test_webhook, list_webhook_deliveries, get_delivery_stats (notifications:webhooks:view / notifications:webhooks:manage).
- manage_notifications reads catalogs and details: alert_categories (metrics, events, variables and the view scopes of each category; read it before creating a rule), alert_resources (what a relay_pool or docker_availability rule can be scoped to), webhook_get, webhook_presets, webhook_preview (render a body template with a sample event), delivery_get.
- Built-in alert rules (isBuiltin, enabled out of the box, editable like any rule): "Storage is full", "Opfield lost outbound connectivity", "Container changed outside Opfield" (category container, event changed_outside: a managed container removed, created under its name or renamed by something other than Opfield), "Node disk almost full" (category node, metric disk, metricTarget "@data": every data disk of every node, >= 85; it watched "/" only before 2.12.3 and keeps "/" if it was edited), "Node disk full" (the same at >= 95, critical), "Node disk oversubscribed" (category node, metric managed_disk_promised_pct > 100: the disk for managed databases and storage is promised more than it holds), "Postgres disk almost full" and "Key-value store disk almost full" (managed_disk_pct >= 85), "ClickHouse disk almost full" (disk_used_pct >= 85), "Opfield disk almost full" (category opfield, metric host_disk, >= 85) and "Docker runtime unavailable" (category node, metric docker_engine_unavailable >= 1 for 120 s, critical: the node's Docker Engine cannot start containers because dockerd or its containerd does not answer; {{details.problem}} names what fails; lastHealthReport.dockerEngine of the node has it, and the node shows as degraded). A disk several nodes enrolled on one machine share (DiskMount.diskId) raises one disk alert naming every such node ({{node.name}} and {{details.nodes}} list them), not one per node.
- System alerts are separate from these rules: Opfield's own certificate alerts (expiry warnings, CA expiry, revocations). manage_system_alerts list and dismiss (alertId) need admin:alerts. Opfield's own health is manage_opfield_diagnostics (topic troubleshooting).
- Audit export to a SIEM has its own tools (topic siem).

## Alert Rules
Each alert rule defines:
- **Category**: hosting_vm, hosting_account, node, container, build, compose, proxy (routes), pages, opfield, logging, integration, certificate, security, database_postgres, database_clickhouse, database_redis, managed_storage, app, backup, domain, pki (internal PKI), inference, relay_pool, or docker_availability
- **Type**: threshold (metric breaches a value) or event (something happens)
- **Threshold fields** (for threshold type): metric, metricTarget (optional sub-target: for node disk "@data" is every data disk of the node except Opfield disk images, each alerting on its own, or a mount point such as "/"; omitted is every reported mount), operator (>, >=, <, <=), thresholdValue, durationSeconds (fire observation window), fireThresholdPercent (percent of probes in that window that must breach), resolveAfterSeconds (resolve observation window, default 60s), resolveThresholdPercent (percent of probes in that window that must be clear)
- **Event fields** (for event type): eventPattern, one of the category's events (offline, stopped, health.offline, etc.). Events with supportsThreshold are states: they fire after durationSeconds in the state and resolve after resolveAfterSeconds out of it.
- **Scope**: resourceIds — specific resources of the category (empty = all): node, route, certificate, database or domain ids, container names, app or app environment ids (an app id covers all its environments), database ids for backup rules
- **Severity**: info, warning, critical
- **Webhooks**: webhookIds — which webhooks receive notifications from this rule
- **Message template**: Handlebars template rendered with event-specific variables
- **Resolve message**: resolveMessageTemplate — sent when the alert resolves; empty uses Opfield's resolve text for the rule (e.g. "Route example.com is back online after 13m 2s."), never the firing message
- **Cooldown**: cooldownSeconds — won't re-fire within this period (default 900s = 15 min)
- **Enabled**: a created rule is active unless the request sends \`enabled: false\` (REST, AI and MCP alike)

## Who may create or edit a rule
Besides notifications:alerts:manage, the author needs view of what the rule watches. A rule scoped to picked resources (resourceIds) needs view of each one (for example proxy:view on each route, databases:view on each database, apps:view on the app or environment, view of a container of that name). A rule on every resource of its category (empty resourceIds) needs that category's broad view, listed as viewScopes in the categories response (for example proxy:view, nodes:details, docker:containers:view); without it, pick the resources you can view. Categories without resources to pick (opfield, security, relay_pool, docker_availability without per-resource grants) need their broad view. Otherwise the API answers 403 FORBIDDEN.

## Webhooks
Webhooks define where notifications are delivered:
- URL, HTTP method (POST/PUT/PATCH/GET)
- Body template (Handlebars) with preset options: Discord, Slack, Telegram, Generic JSON, Plain Text
- Custom headers (key-value pairs)
- HMAC-SHA256 signing with configurable secret and header name
- Delivery log with retry (5 attempts, exponential backoff)

## Handlebars Template Variables
Available in message templates (per-alert) and body templates (per-webhook):

The render context is nested and canonical. Historical flat variables such as \`alert_name\`, \`severity\`, \`value\`, \`threshold\`, \`metric\`, \`fired_at\`, and \`fired_duration\` are not aliases and render empty.

### Universal families
- \`{{notification.type}}\`, \`{{notification.title}}\`, \`{{notification.message}}\`, \`{{notification.timestamp}}\`
- \`{{alert.id}}\`, \`{{alert.name}}\`, \`{{alert.status}}\`, \`{{alert.severity}}\`, \`{{alert.severity.emoji}}\`, \`{{alert.severity.color}}\`
- \`{{resource.type}}\`, \`{{resource.id}}\`, \`{{resource.key}}\`, \`{{resource.name}}\`
- \`{{metric.name}}\`, \`{{metric.value}}\`, \`{{metric.threshold}}\`, \`{{metric.operator}}\`, \`{{metric.duration}}\`
- \`{{node.id}}\`, \`{{node.name}}\`, \`{{health.status}}\`
- \`{{certificate.days_until_expiry}}\`, \`{{certificate.expiry_date}}\`
- \`{{state.current}}\`, \`{{event.name}}\`, \`{{operation.kind}}\`, \`{{operation.phase}}\`, \`{{operation.trigger}}\`
- \`{{failure.code}}\`, \`{{details.*}}\`, \`{{fired.at}}\`, \`{{fired.duration}}\` (how long the alert lasted, such as 3m 37s; \`{{fired.duration.seconds}}\` for the number), \`{{resolution.reason}}\`, \`{{opfield.url}}\`

The category metadata returned by \`GET /api/notifications/alert-rules/categories\` is authoritative for event-specific variables. Build and Compose lifecycle events place safe structured fields in \`operation.*\`, \`failure.code\`, and \`details.*\`; database threshold alerts use \`metric.*\`; certificate alerts use \`certificate.*\`.

## Route, App, Container, Backup and Domain Alerts
- proxy (routes) metrics, measured every 30 s over the last minute of the route's access log on every node serving it: error_5xx_percent and error_4xx_percent (share of responses, %; a minute with fewer than 10 requests counts as 0 %), requests_per_second, latency_p95_ms (worst p95 of the serving nodes; 0 without requests). Example: "5xx share ≥ 10 % for 1 min" is category proxy, type threshold, metric error_5xx_percent, operator >=, thresholdValue 10, durationSeconds 60. The details carry details.requests and details.errors_5xx. Route events: health.offline, health.degraded, health.online (recovery), maintenance.active, created, deleted, Secure Link failures.
- app: one alert per app environment, keyed \`<app id>:<environment id>\`. Events (states): health.failing, health.degraded (degraded or failing), health.healthy (recovery: sent once when the environment is healthy again), kill_switch.on, shutdown.active, maintenance.active. Health is the one the Apps list shows. Metrics: error_5xx_percent and requests_per_second summed over the environment's routes.
- container metrics also include restarts_per_hour (Docker restarts in the last hour, from the container's inspect, refreshed every few minutes).
- backup: scheduled database backups, keyed \`<database id>:<policy id>\` and scoped by database. Metric hours_since_last_backup (since the last successful backup, or since the policy was created) for missed backups; event backup.failed (a state: the last finished backup failed; resolves when one succeeds).
- domain: event dns.not_pointing (a state: the domain's DNS check finds records that do not point to Opfield).
- pki (internal PKI): metric days_until_expiry of active CAs (keyed by CA id) and active certificates they issued (keyed \`<CA id>:<certificate id>\`, so a rule scoped to a CA covers its certificates). Certificates Opfield renews itself are left out (certificate internal.renewal_failed covers them).
- inference: events (states) provider.unavailable (unavailable or out of quota), provider.quota_low (below 10 %), provider.reauth_required, per provider connection; core.unhealthy for the inference core (resource id inference-core).
- relay_pool: events (states) member.offline (a relay offline or failing; draining is planned and does not count), member.unreachable (nodes cannot reach the relay), pool.degraded (fewer ready relays than relays; resource \`pool:<pool id>\`), update.failed (the last Relay Pool update failed).
- docker_availability: events failover.completed (a lost replica was replaced on another node), failover.failed, failback.completed (one-off), and states policy.degraded (fewer replicas than wanted, so it cannot fail over again) and policy.unavailable, per availability policy.

## Database Alert Categories
- database_postgres metrics: latency_ms, active_connections_pct and total_connections_pct (% of max_connections), long_running_queries, database_size_mb.
- database_clickhouse metrics: latency_ms, database_size_mb, disk_used_pct, disk_available_mb, pending_mutations.
- database_redis (key-value stores) metrics: latency_ms, memory_pct (% of maxmemory).
- managed databases (all three) also have managed_cpu_percent and managed_memory_pct (CPU and memory of the database container, % of its limit). Managed Postgres and key-value stores also have managed_disk_pct (the data disk image, as the docker daemon reports it; needs a docker daemon from this release).
- database health events: health.offline, health.degraded, health.online. These events can also be used with threshold-style observation windows when supportsThreshold is true.
- Availability (a database or storage on several servers): the three database categories and managed_storage have the events availability.failover, availability.switchover, availability.forced_promotion, availability.degraded, availability.no_failover and availability.restored (set states, supportsThreshold), availability.member_offline, availability.sync_degraded, availability.sync_far, availability.witness_lost, availability.witness_moved, availability.fenced, availability.rejoined, availability.rebuilt and availability.cancelled_sync_wait. Their \`details.reason\`, \`details.member_id\` and \`details.occurred_at\` say why, which server, and when it happened (events the servers queued while Opfield was down keep their own time). The database categories also have the metrics replication_lag_bytes and replication_lag_seconds (worst copy) and rtt_ms (round trip between the servers). managed_storage rules name storage connection ids. managed_storage also has the events storage.full (the storage refuses uploads: its disk is full or it can create no volume; critical, a state with supportsThreshold) and storage.writable (its recovery), and the metric disk_used_pct (the storage disk as its node reports it).

## Handlebars Helpers
Available in all templates:

### Comparison & logic
\`{{#if (gt metric.value 90)}}CRITICAL{{else}}OK{{/if}}\`, \`eq\`, \`ne\`, \`gt\`, \`lt\`, \`gte\`, \`lte\`, \`and\`, \`or\`, \`not\`

### Formatting
- \`{{round metric.value 1}}\` — round to N decimals (e.g. 11.237 → 11.2)
- \`{{uppercase str}}\`, \`{{lowercase str}}\`
- \`{{truncate str 50}}\` — truncate with ellipsis
- \`{{json obj}}\` — JSON.stringify
- \`{{default value "N/A"}}\` — fallback for null/undefined
- \`{{coalesce node.name resource.name resource.key}}\` — first non-empty value
- \`{{join array ", "}}\` — join array elements

### Math & calculations
- \`{{math metric.value "+" 10}}\` — arithmetic (+, -, *, /, %)
- \`{{percent used total}}\` — calculate percentage
- \`{{round (math metric.value "/" 1024) 2}}\` — combine helpers

### Time & dates
- \`{{formatDuration seconds}}\` — human format: "5m 30s", "2h 15m"
- \`{{timeago notification.timestamp}}\` — relative: "3 minutes ago"
- \`{{dateformat notification.timestamp "YYYY-MM-DD HH:mm"}}\` — custom format
- Format tokens: YYYY, MM, DD, HH, mm, ss

### Text
- \`{{pluralize count "container" "containers"}}\` — singular/plural

## Template Examples
- \`CPU at {{round metric.value 1}}% on {{resource.name}} (threshold: {{metric.operator}} {{metric.threshold}}%)\`
- \`{{resource.name}} {{metric.name}} has been above {{metric.threshold}}% for {{formatDuration metric.duration}}\`
- \`Resolved after {{fired.duration}} — {{metric.name}} now at {{round metric.value 1}}%\`
- \`{{#if (gt metric.value 95)}}🔥 CRITICAL{{else}}⚠️ Warning{{/if}}: {{alert.name}}\`

## API Endpoints
- \`GET /api/notifications/alert-rules\` — list rules (notifications:alerts:view; notifications:alerts:manage implies it)
- \`GET /api/notifications/alert-rules/:id\` — view rule (notifications:alerts:view)
- \`POST /api/notifications/alert-rules\` — create rule (notifications:alerts:manage)
- \`PUT /api/notifications/alert-rules/:id\` — update rule (notifications:alerts:manage)
- \`DELETE /api/notifications/alert-rules/:id\` — delete rule (notifications:alerts:manage)
- \`GET /api/notifications/alert-rules/categories\` — list categories with metrics/events/variables
- \`GET /api/notifications/webhooks\` — list webhooks (notifications:webhooks:view; notifications:webhooks:manage implies it and reveals URL and headers)
- \`GET /api/notifications/webhooks/:id\` — view webhook (notifications:webhooks:view)
- \`POST /api/notifications/webhooks\` — create webhook (notifications:webhooks:manage)
- \`PUT /api/notifications/webhooks/:id\` — update webhook (notifications:webhooks:manage)
- \`DELETE /api/notifications/webhooks/:id\` — delete webhook (notifications:webhooks:manage)
- \`POST /api/notifications/webhooks/:id/test\` — send test delivery
- \`GET /api/notifications/deliveries\` — list delivery log (notifications:webhooks:view)
- \`GET /api/notifications/deliveries/:id\` — view delivery log entry (notifications:webhooks:view; payloads need notifications:webhooks:manage)
- \`GET /api/notifications/deliveries/stats\` — delivery statistics`,
};
