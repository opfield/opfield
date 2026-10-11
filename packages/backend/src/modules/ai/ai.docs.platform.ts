export const PLATFORM_DOCS: Record<string, string> = {
  'gateway-settings': `# Opfield Settings And MCP

Use \`get_gateway_settings\` before changing control-plane settings and \`update_gateway_settings\` with only the fields the user explicitly requested.

## Sign-in And OAuth
- oidcAutoCreateUsers controls whether a valid OIDC login may create an Opfield user automatically.
- oidcDefaultGroupId is the permission group assigned to automatically created users.
- oidcRequireVerifiedEmail requires the provider to assert a verified email.
- oauthExtendedCallbackCompatibility allows unverified public OAuth clients to use external HTTPS callbacks. Loopback callbacks are the safer default. External callbacks are marked as higher risk in consent.
- generalSettings.sendInvitationOnUserCreate (off by default, needs verified SMTP) emails every account created in Users, the API or MCP an invitation with a sign-in link; a failed send does not block the account, and the invitation can be sent again from the user's settings.
- generalSettings.autoAssignCreatedResourcePermissions (on by default) adds view of a created resource, plus the per-resource permissions the creator already holds for it, to the creator's additional permissions. Turning it off affects new resources only.
- In the UI these live under Settings > Authentication (Sign-in methods, Multi-factor authentication, OIDC provider, Identity provisioning).

## MCP
- mcpServerEnabled enables the remote MCP endpoint. MCP still requires an OAuth token issued for the MCP resource and the owning user must have \`mcp:use\`.
- Opfield MCP exposes the GitLab, GitHub, generic Git and external SSH tools to tokens that hold the matching integration scopes; only \`gitlab_clone_repository_to_sandbox\` stays chat-only because it needs the AI sandbox. Managed DNS uses the ordinary Domains tools and \`domains:*\` scopes.
- Extended MCP compatibility is enabled by default and returns every OAuth-scoped tool in the initial \`tools/list\` response. When an administrator disables it, MCP starts with a compact core toolset: \`discover_tools\` activates domain toolsets, Opfield sends \`notifications/tools/list_changed\`, and the client refreshes \`tools/list\`.
- The \`Ingress\` toolset covers Domains, Routes, route folders, nginx templates, access lists, raw route configuration, managed manual/Docker/Pages upstreams, and the canonical maintenance lifecycle. Route tools use UI-aligned names and arguments; resource URIs, scopes, REST paths, and persisted identifiers keep their existing compatibility contracts.
- Use \`manage_additional_route\` for path-prefix locations inside a Route. It supports manual, standalone Docker container, Compose-service, Docker deployment, and Pages Tag targets plus location advanced config. Docker and Compose targets create and own their required Secure Link binding.
- Use \`manage_additional_secure_link\` for extra bindings referenced by a Route advanced nginx config. It supports Docker destinations and the managed S3 destination via \`upstreamKind: "managed_storage"\` plus \`managedStorageId\`; the managed-storage path uses a private relay without a shared Docker network, published port, or root credential. Route-owned bindings are visible in its list but must be changed through \`manage_additional_route\`, not deleted independently.
- The \`Docker\` toolset exposes Compose lifecycle and revisions, Git source settings and Build Secrets, Build Worker-filtered history, logs, cancellation, and retry. The \`Pages\` toolset exposes Page Projects, Deployments, Tags, runtime configuration, profile settings, project migration, Git-source builds, and an MCP-only resumable artifact uploader. Upload chunks are base64-encoded, capped at 1 MiB decoded, and authenticated by the MCP connection rather than a token argument. The \`Databases\` toolset includes managed database provisioning and standalone-container, deployment, or Compose-service bindings. The \`Storage\` toolset covers external and managed storage connections, object operations, managed-storage lifecycle, private workload links, scoped IAM keys, and the MCP-only resumable object uploader.
- MCP clients can call \`read_gateway_documentation\` or read \`gateway://docs\`. General operator topics are available to every valid MCP grant; subsystem topics remain filtered by the delegated OAuth scopes. \`gateway://access\` (also \`get_my_access\` and REST \`GET /api/auth/me/access\`) describes the caller's folders, nodes and resources, and \`gateway://skills\` serves the agent skills that match the running Opfield version, also offered as \`skill-<name>\` prompts.
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
- \`manage_cloud({ operation: "start_link" })\` connects the way Settings > Cloud > Connect does: it returns a short \`XXXX-XXXX\` code and its \`expiresAt\`. Give the user the code and ask them to enter it in their Opfield account under Installations > Add, then call \`manage_cloud({ operation: "link_status" })\` every few seconds until \`state\` is \`connected\` (\`accountEmail\` names the account), or \`expired\`, \`invalid\` or \`used\` (start_link again for a new code), or \`wrong_installation\` or \`failed\` (report \`error\`). \`cancel_link\` stops waiting. On a connected installation start_link switches accounts: \`replacesAccount\` names the current account, and entering the code there ends the current connection at once; tell the user before they enter it. Each code request, expiry and refusal is audited as \`cloud.connect_code\` (never with the code); the connection itself as \`cloud.connect\` with source connect-code.
- \`manage_cloud({ operation: "connect", code })\` connects with the single-use \`CLD-XXXX-XXXX\` code from the installation's page in the cloud account (valid 10 minutes). Connecting again replaces the previous connection. Treat the code as a secret and never repeat it in chat.
- \`manage_cloud({ operation: "set_remote_management", enabled })\` turns "Allow remote management" on or off (off by default, audited as \`cloud.remote_management\`). Reads need no switch; node-token, update and setup-link requests from the account need it on, or a managed cloud VM (enrolled from its provisioning file, shown as Managed by the cloud). A refused request answers REMOTE_MANAGEMENT_OFF and is audited. A setup code is issued only while no user exists. An sso-secret request (a new client secret for the "Opfield account" sign-in provider) is answered only by a managed cloud VM (NOT_MANAGED_BY_CLOUD otherwise), stored encrypted and audited without the secret.
- \`manage_cloud({ operation: "disconnect" })\` revokes the connection at the account and forgets it here. If the account cannot be reached the connection is still forgotten here and the result carries a \`warning\`: tell the user to disconnect the installation in the cloud account too.
- Every connect, disconnect, disconnect by the account and each request the account sends over the socket has its own audit entry (resource type \`cloud-link\`, actions \`cloud.connect\`, \`cloud.disconnect\`, \`cloud.disconnected_by_account\`, \`cloud.request\` with the request type, service, tail/since, request id, result and result size). Identical successful reads of the same type and service within 10 minutes of the first one are counted, not written one by one: the first read has its own entry and the repeats get one summary entry (details.summary: count, first and last time, total bytes) when the 10 minutes end, the socket stops or Opfield shuts down. Failed reads always have their own entry. \`get_cloud_status\` also returns the 5 latest entries with their read counts.
- A connected Opfield installation keeps one outbound socket to the account, which reads this Opfield installation's host state, its own containers, their logs and the update status through it, and can ask for a first-admin setup code (only before setup), a one-time node enrolment token with its install command, and start the Opfield update Settings offers. Actions and failed requests always have their own audit entry. A managed installation enrols itself on start from \`/var/lib/gateway/cloud-enroll.json\` and activates the paid license key in it as Settings > Update license does (audited as \`cloud.connect\` and \`license.activate\` with source enroll-file, and \`cloud.enroll_file\` when the file is removed once every step succeeded or was refused for good). When the file also carries \`sso\` and \`owner\`, an installation without an administrator comes up set up: public URL, an OIDC provider "Opfield account" (the account portal as issuer), the owner as system administrator bound to issuer and sub, and setup marked complete, all in one step or not at all (each step audited as \`cloud.managed_sso\`, never with the secret). The client secret leaves the file once stored. The provider is a normal OIDC provider: its name can be changed in Settings, and replacing it is refused while no other administrator could still sign in. Uses the license scopes: license:view to read, license:manage to change.

## Opfield And Daemon Updates
- Read \`generalSettings.updateChannel\` before interpreting update results. \`stable\` excludes release candidates; \`preview\` also accepts GitHub prereleases tagged as \`vX.Y.Z-rc.N\` for Opfield and component-suffixed tags such as \`vX.Y.Z-rc.N-relay\` or \`vX.Y.Z-rc.N-docker\` for Relay and managed node daemons. Inference Core remains on its independent stable signed channel.
- Use \`manage_system_updates({ operation: "get_gateway_status" })\` or \`manage_system_updates({ operation: "check_gateway" })\` before proposing an update.
- Read release notes with \`manage_system_updates({ operation: "get_gateway_release_notes", version })\` for the exact advertised version, or \`list_gateway_release_notes\` for every release between the current and the available version.
- Apply an app update with \`manage_system_updates({ operation: "perform_gateway_update", version })\` only after explicit approval. The update first checks free disk space, then waits for running deploys, drains, Availability and Compose operations, build rollouts and Docker migrations (status \`waiting_for_operations\`, up to 15 minutes by default) while new ones are refused; \`proceed_gateway_update\` ("Update now") stops waiting, and recovery resumes what still runs. It snapshots the Opfield database before the new version starts and restores it if the update fails. \`acknowledge_gateway_update_failure\` clears a reported failure.
- Use the \`list_daemon_updates\` and \`check_daemon_updates\` operations before \`manage_system_updates({ operation: "update_daemon", nodeId })\`; pass the exact nodeId and verify the node reconnects on the expected version. Daemon updates are refused for disconnected nodes, relay nodes (use \`perform_relay_update\` for the Relay Pool) and nodes that already run the release; nodes that share an Availability policy update one after another.
- A daemon update waits first for the long tasks running on its node: backups, image builds, Docker migrations, image pulls, container actions, storage copies, container archive transfers (\`waitingForTasks\` in the result, \`metadata.updatePhase: waiting_for_tasks\` and \`metadata.updateWaitingForTasks\` on the node). After 30 minutes it goes ahead and keeps a warning. \`now: true\` updates at once, also for an update that already waits (for tasks or for its lease peers); the running tasks may fail and a lease peer may be down at the same time, so pass it only after the user confirmed exactly that.
- An update of a Docker or nginx node whose daemon advertises \`daemon_stream_handover_v1\` keeps relay stream sessions (a pause of a second or two). Raw streams of older peers, PostgreSQL links where the daemon opens TLS, registry pulls and pushes, and backup runs are cut as before; the first update onto this release and a rollback below it cut once. \`lastHealthReport.updateConnections\` shows what an update now would keep and cut; \`metadata.lastUpdate\` keeps the result of the last update (warnings, \`serviceRestart\` when the daemon restarted its whole service for a newer launcher or says why not, and in \`connections\` the kept and cut counts by class; class \`uncounted\` means every connection of the node was cut and no daemon counted them: the update came from a daemon that cannot hand connections over, such as the first update from 2.11.3, or a rollback put one back; \`service_restart\` next to it counts the restart of the whole service the new daemon did once right after such an update for its newer launcher).
- A node's \`capabilities.launcherVersion\` is the launcher its daemon runs under; the launcher updates itself in place after a daemon update. A node on a 2.11.4 or later daemon without it (a launcher started before 2.11.4) restarts its whole service once on its next daemon update: that update hands nothing over and cuts open connections once (class \`service_restart\`; \`handoverAvailable: false\` in \`lastHealthReport.updateConnections\` beforehand), and the service starts with the updated daemon's launcher. Later updates keep connections. Opfield waits up to 4.5 minutes for an updated daemon, as long as its launcher keeps it on trial; a daemon that comes back on the previous version was rolled back, and the stopped candidate handed its connections to it.
- Never invent a version, claim an update completed before its status confirms success, or update unrelated daemons as a side effect.

## Moving Opfield To Another Host
- \`manage_configuration_export({ operation: "estimate" })\` reads the sizes (database, Opfield files, internal registry, managed logs) and the values the new host keeps instead (public address, passwords, .env host overrides, sign-in sessions). Requires admin:system.
- \`manage_configuration_export({ operation: "export", passphrase, includeRegistry, includeLogs })\` returns a one-time link (15 minutes) and a curl command that saves the encrypted \`.opfield-export\` file. It holds the database (consistent snapshot, nothing stops), the master key, every CA key, the relay policy signing keys, Opfield's files, the commercial core and, when asked, the registry images and managed logs. Ask the user for the passphrase (12+ characters) and never repeat it; it is not stored. \`progress\` with the exportId follows the download. Audited as \`system.configuration_export\` (or \`system.configuration_export_failed\`).
- The restore runs in the setup wizard of a fresh installation of the same Opfield version ("Restore from an export") or with \`install.sh --restore <file>\`; it keeps the installation ID and license and asks for the new address.
- When the address changes, \`announce_move\` with the new \`host:port\` before the old installation is shut down tells every connected node and relay; each keeps it and switches once this installation stays unreachable for 10 minutes and the restored one answers with the same System CA. \`move_status\` lists nodes told, offline, or on a daemon too old to take it (update those first, keep DNS, or edit \`gateway.address\` in the daemon config on the node). \`withdraw_move\` takes it back. Audited as \`system.gateway_move_announced\` / \`system.gateway_move_withdrawn\`.`,

  inference: `# Opfield Inference

Opfield Inference is a standalone external model gateway. It is not the AI Workspace provider configuration and it is not Opfield MCP. It has separate provider credentials, model configuration, scopes, accounting, continuation state, and dedicated \`gwi_\` runtime tokens. Never use a normal \`gw_\` API token, a \`gwo_\` OAuth token, a Workspace provider key, or an MCP credential on the inference data plane.

## Availability

Inference is disabled by default. Read Opfield settings first. An administrator with \`settings:gateway:edit\` can enable it through \`update_gateway_settings\`:

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
- \`manage_inference_token\`: list, create, or revoke the current user's \`gwi_\` tokens. It cannot issue a token for another user.

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
7. API pricing is versioned. Pricing values are integer microdollars per million tokens: $5.00 per million tokens is 5,000,000 microdollars. Prefer synchronized/known pricing; use manual pricing only when provider metadata is unavailable.

\`save\` is the only model mutation workflow. Do not attempt partial model/source/pricing/access updates.
Published model order is persisted separately and controls API catalog, companion manifest, and AI Workspace ordering. The current Assistant model tool does not expose reorder; use the Inference settings UI or the documented reorder REST endpoint.

## Default And Per-user Limits

\`manage_inference_limits\` uses one complete policy object. \`enabled\` controls inference access. Subscription windows use credits5hEnabled/credits5h, credits7dEnabled/credits7d, and credits30dEnabled/credits30d. One public subscription credit represents 1,000,000 weighted tokens before model, dynamic-burn, and service-tier multipliers. A disabled window is unlimited; if all three are disabled, subscription-credit usage is unlimited. apiMonthlyMicrodollars is the user's monthly API budget and 0 disables API usage. When API usage is disabled, models whose usable sources are API-only are omitted from OpenAI, harness, and internal Assistant catalogs for that user. billingTimezone is an IANA timezone. Per-user policies override the default policy. Administrators can reset all four usage baselines for one user from the Inference limits UI or \`POST /api/inference/limits/users/{id}/reset\`; this preserves immutable request/ledger history and is not currently exposed by \`manage_inference_limits\`.

## User Tokens And Harness Setup

Users need \`feat:ai:use\` for Opfield Inference access, personal usage visibility, and creation or revocation of their own inference tokens. AI Workspace access is controlled separately by \`ai:workspace:use\`.

Token options:

- UI: **Profile > Authorizations > Inference API tokens**;
- AI: \`manage_inference_token({ operation: "create", name: "Laptop" })\` for the current user.

The \`gwi_\` secret is shown once. Never repeat it after creation, store it in assistant history, or expose it to another user.

### Recommended harness setup

No global installation or PATH change is required:

\`\`\`bash
npx -y @sqgateway/inference@latest
\`\`\`

An administrator must first enable **Inference** in **Settings > General**. Before giving harness setup instructions, call \`get_gateway_settings\` when it is available and report \`generalSettings.features.inferenceEnabled\`. Without that read permission, do not guess its value: explain that an administrator must confirm it. The interactive manager asks for the Opfield URL and offers either isolated browser OAuth/PKCE or a masked existing \`gwi_\` token, then can configure, diagnose, repair, or remove supported harness integrations. Browser OAuth always prints the complete authorization URL before attempting to open it, preserving a manual fallback when the browser does not start. The token is validated before it is saved, identifies its owning user, and requires no email. Direct commands are \`login [gateway]\`, \`logout\`, \`setup [harness]\`, \`startup install|status|uninstall\`, and the offline recovery command \`uninstall codex-usage\`; non-interactive token login uses \`--token\`. \`--home /data/inference\` or \`GATEWAY_INFERENCE_HOME=/data/inference\` keeps all companion-owned filesystem state and mode-0600 credentials below one directory and is propagated to installed helper processes. Harness configuration still remains in the native Codex or Claude Code directory. If the user does not name a harness, ask whether they use Codex or Claude Code before giving harness-specific instructions.

#### Codex CLI and Desktop

\`\`\`bash
npx -y @sqgateway/inference@latest login https://gateway.example.com
npx -y @sqgateway/inference@latest login https://gateway.example.com --token gwi_...
npx -y @sqgateway/inference@latest setup codex
npx -y @sqgateway/inference@latest setup codex --url https://gateway.example.com --startup
\`\`\`

Codex setup issues a dedicated runtime token, writes only package-managed Codex configuration sections, installs a private helper and loopback proxy, and maintains the authoritative Opfield model catalog. It does not replace native Codex usage or quota displays. Catalog changes apply after starting a new Codex process. Codex Desktop must also be signed in to an OpenAI account through Codex's normal login flow; after Opfield setup or login changes, fully quit and reopen Codex. On macOS and Linux, \`startup install\` enables user-session startup for the already installed private helper; it does not depend on npm, \`npx\`, or shell \`PATH\`, install a privileged system service, or enable systemd lingering.

#### Claude Code CLI

Claude Code 2.1.129 or newer is required:

\`\`\`bash
npx -y @sqgateway/inference@latest login https://gateway.example.com
npx -y @sqgateway/inference@latest login https://gateway.example.com --token gwi_...
npx -y @sqgateway/inference@latest setup claude-code
\`\`\`

Claude Code setup issues a separate dedicated runtime token and configures the native Anthropic gateway contract with \`ANTHROPIC_BASE_URL\`, model discovery, and a private \`apiKeyHelper\`. It does not use the Codex loopback proxy. This setup supports the Claude Code CLI only; Claude Desktop and the Claude Code VS Code extension are separate and are not modified automatically.

### Manual OpenAI-compatible setup

\`\`\`text
Base URL: https://gateway.example.com/api/inference/v1
API key:  gwi_...
Models:   GET <base-url>/models
\`\`\`

Use this base adapter for OpenAI SDKs and OpenAI-compatible clients. It supports Responses and Chat Completions.

### Manual Anthropic-compatible setup

\`\`\`text
Anthropic SDK base URL: https://gateway.example.com/api/inference
Direct REST prefix:     https://gateway.example.com/api/inference/v1
API key:                gwi_...
\`\`\`

Anthropic SDKs append \`/v1\` themselves, so configure the SDK base URL without \`/v1\`. Direct HTTP clients call \`/api/inference/v1/messages\`. Dedicated \`gwi_\` tokens work as Bearer credentials and as \`x-api-key\`.

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
- providerType: openai_compatible or gateway_inference. Opfield Inference is available only while the inference feature is enabled.
- providerUrl: OpenAI-compatible API base URL.
- endpointMode: auto, chat_completions, or responses.
- model: provider model name.
- apiKey: only set this when replacing the stored provider key. The current secret is never returned in full.
- gatewayInferenceModel: default published Opfield Inference model ID.
- gatewayInferenceAllowUserModelSelection: whether users may choose another model they are allowed to access.
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
The notification system sends HTTP webhook notifications when alert conditions are met. It supports threshold-based alerts (CPU, memory, disk) and event-based alerts (node offline, container stopped, etc.).

## Alert Rules
Each alert rule defines:
- **Category**: node, container, build, compose, proxy, pages, gateway, logging, integration, certificate, security, database_postgres, database_clickhouse, database_redis, or managed_storage
- **Type**: threshold (metric breaches a value) or event (something happens)
- **Threshold fields** (for threshold type): metric, metricTarget (optional sub-target such as a specific node disk mount), operator (>, >=, <, <=), thresholdValue, durationSeconds (fire observation window), fireThresholdPercent (percent of probes in that window that must breach), resolveAfterSeconds (resolve observation window, default 60s), resolveThresholdPercent (percent of probes in that window that must be clear)
- **Event fields** (for event type): eventPattern (offline, stopped, oom_killed, etc.)
- **Scope**: resourceIds — specific nodes/containers/certs to monitor (empty = all)
- **Severity**: info, warning, critical
- **Webhooks**: webhookIds — which webhooks receive notifications from this rule
- **Message template**: Handlebars template rendered with event-specific variables
- **Resolve message**: resolveMessageTemplate — sent when the alert resolves; empty uses Opfield's resolve text for the rule (e.g. "Proxy host example.com is back online after 13m 2s."), never the firing message
- **Cooldown**: cooldownSeconds — won't re-fire within this period (default 900s = 15 min)

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
- \`{{failure.code}}\`, \`{{details.*}}\`, \`{{fired.at}}\`, \`{{fired.duration}}\` (how long the alert lasted, such as 3m 37s; \`{{fired.duration.seconds}}\` for the number), \`{{resolution.reason}}\`, \`{{gateway.url}}\`

The category metadata returned by \`GET /api/notifications/alert-rules/categories\` is authoritative for event-specific variables. Build and Compose lifecycle events place safe structured fields in \`operation.*\`, \`failure.code\`, and \`details.*\`; database threshold alerts use \`metric.*\`; certificate alerts use \`certificate.*\`.

## Database Alert Categories
- database_postgres metrics: latency_ms, active_connections_pct, database_size_mb.
- database_clickhouse metrics: latency_ms, database_size_mb, disk_used_pct, disk_available_mb, pending_mutations.
- database_redis (key-value stores) metrics: latency_ms, memory_pct.
- database health events: health.offline, health.degraded, health.online. These events can also be used with threshold-style observation windows when supportsThreshold is true.
- Availability (a database or storage on several servers): the three database categories and managed_storage have the events availability.failover, availability.switchover, availability.forced_promotion, availability.degraded, availability.no_failover and availability.restored (set states, supportsThreshold), availability.member_offline, availability.sync_degraded, availability.sync_far, availability.witness_lost, availability.witness_moved, availability.fenced, availability.rejoined, availability.rebuilt and availability.cancelled_sync_wait. Their \`details.reason\`, \`details.member_id\` and \`details.occurred_at\` say why, which server, and when it happened (events the servers queued while Opfield was down keep their own time). The database categories also have the metrics replication_lag_bytes and replication_lag_seconds (worst copy) and rtt_ms (round trip between the servers). managed_storage rules name storage connection ids.

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
