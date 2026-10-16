# Multi-provider inference proxy

Opfield exposes a standalone OpenAI- and Anthropic-compatible inference data plane. It is isolated from AI Workspace and the MCP runtime: it uses dedicated provider credentials, `opfi_` user tokens, model access rules, accounting, and a usage ledger.

The data plane is served by the managed inference core, `opfield-inference` (built from OpenCodex), that Opfield installs and updates on the host as a supervised container. Opfield remains the control plane: provider connections, models, limits, tokens, pricing, and accounting stay in the Opfield UI and database, and are delegated to the core automatically. The connector baseline is OpenCodex; Cursor, Kiro, and OpenCodex desktop lifecycle features are intentionally excluded.

The provider registry covers OpenAI/Codex, Anthropic, xAI, Kimi/Moonshot, Google Gemini, Google Antigravity, GitHub Copilot, Umans, OpenCode, NeuralWatt, OrcaRouter, DeepSeek, Fire Pass, NVIDIA, Z.AI, SiliconFlow, Qwen, Tencent, Alibaba, ZenMux, LiteLLM, Ollama, vLLM, LM Studio, MiniMax, MiMo, Cloudflare Workers AI, OpenRouter, Groq, Cerebras, Together, Hugging Face, Mistral, Azure OpenAI, and generic OpenAI-compatible endpoints. Google Antigravity uses Cloud Code Assist project discovery and its request envelope. Provider-specific capabilities remain explicit in the registry, so an unavailable surface fails closed instead of silently using the wrong wire format.

## Enable inference

Inference is disabled by default. An administrator with Opfield settings access enables it under **Settings > General > Features and updates > Inference**. No process restart is required.

When disabled, management and data-plane routes return `INFERENCE_DISABLED`, and the frontend omits Inference usage, token management, and administration surfaces. Connected provider credentials, model configuration, and accounting history remain stored.

Apply database migrations before enabling the flag. Roll out admin scopes first, install the inference core, configure and verify providers/models, then grant `feat:ai:use` to a limited user group.

## Inference core lifecycle

The managed core is a single `inference-core` container supervised by Opfield. It listens only on the internal Docker network; clients never reach it directly. All client traffic enters through Opfield's `/api/inference/v1` proxy, which authenticates the `opfi_` token, admits the request against budgets, and forwards it to the core with a signed per-request context. The core reports admission and settlement back to Opfield over an authenticated internal callback channel, so PostgreSQL remains the source of truth for usage and billing.

Administrators manage the core from **Settings > Inference** (and during initial setup from the setup wizard):

- **Install** downloads the pinned, signature-verified core release and starts the container.
- **Update** installs a newer signed release with automatic rollback to the previous working version if the new one fails health checks.
- **Repair** reconciles a degraded or failed container back to the desired state.
- **Check updates** records the newest release available on the channel.

Only one lifecycle operation runs at a time. Operations interrupted by an Opfield restart are marked failed and reconciled from observed container state on boot.

Opfield and inference core upgrades do not invalidate provider connections, inference tokens, or harnesses already connected with them.

## Administrator setup

1. Open **Settings > Inference**.
2. Install the inference core and wait for it to report healthy.
3. In **Providers**, connect subscription accounts through the displayed OAuth/device flow or add API/local credentials. OpenAI/Codex uses the remote-safe device flow at `auth.openai.com/codex/device`; Opfield never relies on the Codex CLI's `localhost:1455` loopback callback. Subscription connectors are unofficial upstream integrations and require explicit terms/risk acknowledgement.
4. Wait for sync. Providers with multiple connected accounts/keys appear as one collapsible table group; a provider with one connection remains a normal row. Open an account row to review 5h/7d/30d subscription quota, including model-scoped weekly limits such as Anthropic's separate Fable, Opus, and Sonnet windows, enable or disable it, synchronize it manually, or configure a minimum remaining reserve.
5. Opfield automatically routes across compatible sources while retaining active-turn affinity and failing over only before client output begins. Within a provider group, drag account rows to set the priority used by Sequential routing; accounts cannot be moved between provider groups. A subscription connection is excluded when its worst fresh account-wide quota window falls below its configured reserve. A model-scoped window excludes the connection only for models of that family, so an exhausted Fable window leaves the same account routable for Sonnet. A logical model may also include fallback sources from different providers or upstream models when every source satisfies the published modalities, capabilities, reasoning map, and technical limits.
6. In **Models**, publish a stable public model ID with one or more compatible sources.
7. Configure context/input/output/auto-compaction limits, modalities, and access. Subscription-backed models also have a credit multiplier; API-backed models use versioned provider/manual pricing and do not expose a subscription multiplier. A price is optional: leave the input and output prices empty to publish an API model without one (see [Models without a price](#models-without-a-price)).
8. Configure reasoning overrides such as `ultra=max`. Efforts without an override map to the same provider name. Drag efforts into the order that clients and the AI Workspace reasoning selector should display them.
9. Optionally set a **System prompt** for the model. **Append** keeps the harness default instructions and adds the prompt after them; **Replace** substitutes the default entirely, so a replacement must restate any tool or patch-format rules the model still needs. The prompt is published in the model catalog (`GET /models`, `system_prompt`) and applies only to harnesses that read it from there: Opfield never rewrites the `instructions` or `system` field of a client request, so other clients keep their own prompts.
10. In **Settings > Inference > Limits**, set default limits and optional per-user overrides.

Drag model rows to set the order returned by the management and data-plane catalogs. AI Workspace uses the same order for its model selector and default-model fallback.

There is no user-visible or administrator-managed Pool entity. Provider administration remains grouped by provider, while one logical model may include compatible sources from more than one provider or upstream model. Opfield validates every enabled source against the model's published contract and keeps failover inside one request/accounting lineage; it never switches after output has begun.

### Opfield Cloud AI on managed installations

A managed installation with the AI add-on (bought in the Opfield account) is set up by the account: Opfield turns inference on, installs the core, adds the provider connection **Opfield Cloud** and publishes **Opfield Swift** (`opfield-swift`) and **Opfield Heavy** (`opfield-heavy`) to everyone. The connection and both models are read-only here (API and MCP answer `409 CLOUD_MANAGED`); their order can still change. The provider row shows how much of the plan is used; open it for the 5-hour and 30-day windows. Both models carry the prices the Opfield account sets, so per-user API budgets here count them; the plan in the Opfield account limits total use. When the add-on is first ready and the default monthly API budget is 0, it becomes the plan's monthly price (a budget you set is kept). When the add-on ends, the models and the connection are removed.

## User setup

Users need `feat:ai:use` for Opfield Inference access, personal usage visibility, and creation or revocation of their own inference tokens. AI Workspace access is controlled separately by `ai:workspace:use`.

To connect a harness, open **Set up a harness** on the Inference usage panel or in **Settings > Inference**. The **Set Up an Inference Harness** dialog shows the values to paste into the harness's own provider settings:

- **OpenAI-compatible base URL**: `https://opfield.example.com/api/inference/v1`;
- **Anthropic-compatible base URL**: `https://opfield.example.com/api/inference`. Anthropic clients append `/v1/messages` themselves;
- **API key**: a new `opfi_` token that the dialog creates for this harness. It is shown once;
- **Model**: any model available to you.

The recommended harness is [DeepSeek harness](https://www.deepseek.com/en/harness/): add Opfield as a provider in its settings with these values. Any other harness or tool that accepts an OpenAI- or Anthropic-compatible provider works the same way.

Each opening of the dialog creates a token named `Harness — <date>` and revokes earlier dialog tokens that no client has used. Tokens a harness has used are kept. To create a token without the dialog, use **Profile > Authorizations > Inference API tokens**; the `opfi_` secret is also shown once.

All clients use the same base URLs:

```text
OpenAI SDK baseURL:    https://opfield.example.com/api/inference/v1
Anthropic SDK baseURL: https://opfield.example.com/api/inference
API key:               opfi_...
```

The `/api/inference/v1` endpoint exposes the OpenAI-compatible Models, Responses, Chat Completions, Anthropic Messages, images, search, and realtime surfaces. Anthropic SDKs append `/v1` themselves, so their `baseURL` omits that segment.

For ChatGPT subscription-backed models whose upstream catalog advertises it, a client may request the `priority` service tier (Codex `/fast`). Opfield forwards it and charges a fixed 2x subscription-credit multiplier; API dollar accounting is unchanged.

Supported primary operations include:

- `GET /usage`
- `GET /models`
- `POST /responses`
- `POST /responses/compact`
- `POST /chat/completions`
- `POST /messages`
- `POST /messages/count_tokens`
- `POST /images/generations`
- `POST /images/edits`
- `POST /alpha/search`
- `POST /realtime/calls` and `POST /live`

Responses, Chat Completions, and Messages support unary and SSE responses. Responses also supports an end-to-end WebSocket transport: Opfield keeps the client socket open across turns, forwards each turn to the managed core over WebSocket, and issues fresh signed admission context per turn without converting the stream through SSE or disk files. Realtime sideband/audio WebSockets are not supported. Authentication accepts only a dedicated `opfi_` token through `Authorization: Bearer` or `x-api-key`; browser sessions and regular `opf_`/`opfo_` credentials cannot enter the data plane.

`GET /usage` is authenticated but does not consume inference concurrency or rate-limit admission. It returns user-visible percentage windows plus lifetime and UTC daily token totals used by compatible harness usage views; raw administrator accounting remains on management surfaces.

## Limits and accounting

Users see percentages only:

- monthly API usage;
- shared subscription usage for fixed 5-hour, 7-day, and 30-day reset windows;
- recovery/reset timestamps.

A window that does not limit the user (a disabled 5-hour, 7-day or 30-day window, or API usage that is off) is reported with `configured: false` and `percentage: 0`.

Administrators can see raw cost, tokens, credits, upstream quota, and request metadata.

Profile includes a 30-day request/token/cost overview for the signed-in user. An inference limits administrator can reset all four usage baselines for one user. Resetting does not delete ledger or request history: each fixed 5-hour/7-day/30-day window closes completely at its reset boundary, then the next window starts only when the user next makes a subscription-backed inference request. Usage remains monotonic while a window is active. A manual reset closes the active subscription windows immediately and leaves them idle until the next request, while the API monthly cycle remains anchored to the reset's local calendar date and time.

Setting a user's monthly API budget to zero disables API-funded usage for that user. Logical models whose usable sources are API-only are then omitted from the OpenAI-compatible catalog and the AI Workspace model picker instead of being shown as unusable choices.

Settled subscription credits use weighted token classes:

```text
weighted tokens =
    uncached input
  + cached input × 0.10
  + cache write × 1.25
  + output
  + reasoning

credits = weighted tokens / 1000000
  × model multiplier
  × frozen dynamic burn multiplier
  × frozen service-tier multiplier
```

One public subscription credit therefore represents 1,000,000 weighted tokens before multipliers. Opfield keeps the legacy internal accounting scale private and converts limits and usage at management and activity boundaries, so existing policies, ledger entries, and active reservations require no migration.

Admission first reserves a conservative input-plus-output estimate without assuming a future cache hit (for Chat Completions, Opfield estimates the input from the request body: text characters / 3, a fixed size per image, audio or file part); settlement replaces it with the weighted actual usage above. Dynamic burn compares remaining quota with the fraction of time left in each reported window, enforces a 30% quota-pressure floor, and caps the result at 8x. Stale, exhausted, or invalid quota data fails closed at 8x. The multiplier is frozen at admission. Codex Fast adds a separate fixed 2x service-tier multiplier for eligible ChatGPT subscription sources; API dollar accounting is unaffected.

A request admitted while the user still has a positive balance always runs to completion: Opfield never reduces its output limit, and the turn may settle past the window limit. Only the reservation is bounded by the remaining balance, so parallel turns cannot stack reservations beyond the limit. The next request after the balance is exhausted is denied with the window's recovery time. Truncating a turn is deliberately avoided: harnesses retry an incomplete response several times and every retry is billed.

A budget refusal looks the same on every endpoint and every inference core version. Nothing is sent to the provider and nothing is charged:

- HTTP `429` with a `Retry-After` header: the seconds until the window recovers;
- error code `subscription_budget_exhausted` (a 5-hour, 7-day or 30-day credit window), `api_budget_exhausted` (the user's monthly API budget) or `provider_api_budget_exhausted` (the connection's monthly API limit);
- `error.details.recoveryAt`: the ISO time the budget recovers. A user budget refusal also names the window in `error.details.dimension` (`5h`, `7d`, `30d` or `monthly`);
- a Responses WebSocket turn gets an `error` event with the same status, code and details, and a `retry-after` value under `headers`;
- Activity records the request as `failed` with the same error code.

The published model **output limit** is the source of truth for the upstream request. Opfield signs it into the per-request context, and a core that negotiated the capability uses it as the provider output ceiling when the client sends no limit of its own. Older cores do not receive the claim and keep their built-in defaults.

API usage is stored in integer microdollars using the pricing snapshot selected at admission. API-backed models do not consume subscription credits or use a subscription multiplier. Redis holds atomic reservations, affinity, cooldowns, and refresh locks; PostgreSQL remains the source of truth and stores immutable settlement ledger rows. Continuation state lives in the managed core rather than being duplicated in Opfield request-history storage.

### Models without a price

An API source with no input or output price (or, for image, search and realtime calls, no per-call price) is not refused. Its requests run on every inference core version:

- Tokens are recorded as usual, in Activity, the usage totals and the settlement ledger.
- The cost is recorded as unknown, not as $0. Activity shows **Price not set** for those requests, and the API and MCP mark them `costUnknown: true`; their `apiMicrodollars` is 0 and is not their cost. The usage overview counts them next to the API total.
- They are outside API budget enforcement: they reserve and charge nothing, so a user's monthly API budget and a connection's monthly API limit neither count them nor refuse them. A user whose API usage is switched off (budget 0) still cannot use API models. API sources never use subscription credits, priced or not.

Administrators are told:

- **Settings > Inference > Models** shows "No price set: requests are not charged to API budgets" on the model and in its Pricing tab. `manage_inference_model` list returns `priceMissing` per source and `priceWarning` per model.
- When such requests run, the Dashboard and the Inference usage overview show a warning naming the models (those with requests in the last 7 days whose price is still not set). `manage_inference_usage` system returns the same list under `unpriced`.

Setting a price takes effect for new requests; requests that already ran keep the unknown cost.

## Compaction and continuation

During long silent SSE responses, including native compaction, Opfield sends an initial comment and then checks every 15 seconds for idle output. Keepalive comments are emitted only between complete SSE frames and when the consumer can accept data. They are not model output or completion events; the real terminal event still controls request accounting. This protects the HTTP stream from intermediary idle timeouts without inventing response content.


Opfield supports:

- `previous_response_id` continuation, isolated to the owning user;
- the v1 `/responses/compact` replacement-history response;
- the Responses v2 `compaction_trigger` item;
- Opfield `ocx1:` compaction envelopes that can be passed back as a `compaction` input item.

Compaction is accounted separately and never receives dynamic burn; a requested eligible Fast tier still receives its fixed service-tier multiplier. A retry may select another capability-compatible provider before output begins, including for continuation requests, but provider selection cannot change after output starts, preventing mixed or duplicated streams.

For Responses WebSocket clients, the socket remains usable until the client, Opfield, or the managed core closes it. A failed or incomplete turn is recorded as failed instead of being finalized as a successful zero-output request. Activity stores normalized metadata and usage only; hovering a model in the administrator activity table identifies the provider account used for that request.

## Security and privacy

- Provider credentials are encrypted with the Opfield master key and never returned by management APIs.
- Generic/private upstream URLs are denied by default. An administrator must explicitly allow a private destination; URL credentials, metadata/link-local/multicast destinations, unsafe schemes, and redirects are rejected.
- OAuth state, PKCE verifiers, and refresh tokens are encrypted and bounded.
- The core container is reachable only from Opfield over the internal Docker network; the core callback channel is authenticated with per-request signed contexts.
- Activity and logs store metadata and normalized usage only, never prompts or model output.
- Structured runtime logs use request IDs, logical model/provider/source type, latency, usage, burn, status, and error code. They do not label users or provider accounts.

## Operations

Monitor **Settings > Inference > Overview/Activity** for request/error rate, tokens, cost, account health, quota freshness, reauthentication, estimated usage, and routing failures. Alert operationally on repeated `provider_reauth_required`, `provider_rate_limited`, `provider_unavailable`, stale quota, reservation/reconciliation errors, and unexpected estimated usage.

Back up the PostgreSQL inference tables with the normal database backup and preserve the encryption master key. Redis reservation state is intentionally recoverable or short-lived; the reconciliation job repairs reservation drift from PostgreSQL. Core release artifacts and container state are re-downloadable from the signed release channel and do not need backup. The core's own request ledger (`usage.jsonl` in its state volume) is cut to its newest 64 MB once it passes 128 MB, checked every hour; Opfield's usage views read Opfield's own records and are not affected.

Troubleshooting:

- Core unhealthy or missing: use **Repair** in **Settings > Inference**; check the lifecycle operation log shown there for the failing step.
- A harness that stops authenticating: its token was revoked or expired, it is used from an address outside the token's allowed addresses, or its owner lost `feat:ai:use`. Open **Set up a harness** again and paste the new API key into the harness settings.
- A failed core update rolls back automatically; if rollback also fails, **Repair** reinstalls the last known-good pinned release.

To disable inference:

1. Turn off **Settings > General > Features and updates > Inference**. The change applies immediately.
2. Revoke routing/user scopes or individual `opfi_` tokens if required.
3. Keep provider credentials and immutable accounting/audit rows unless an administrator explicitly disconnects a provider.
4. Do not delete inference tables as part of rollback.

## Verification and staging checklist

CI and local development use the deterministic, secret-free emulator in `packages/backend/src/modules/inference/testing`. It covers model discovery, Responses/Chat/Messages streams, tools, reasoning, missing usage, quota/balance, OAuth refresh, images/search/realtime, delay, disconnect, partial output, and 401/429/5xx failures.

Before enabling production scopes, verify in staging with at least one real subscription and one real API connector:

- core install, update with rollback, and repair;
- OAuth/API credential lifecycle and reauthentication;
- real model/quota discovery and freshness;
- published model access and reasoning mapping;
- subscription request, quota pressure, and pre-output failover between compatible same-provider and cross-provider sources;
- user percentage update and administrator raw accounting;
- Codex discovery, streaming, tools, reasoning, continuation, and explicit auto-compaction;
- Claude Messages streaming and `count_tokens`;
- OpenAI Chat Completions client;
- disable/re-enable rollback without deleting ledger or credentials.

Never put staging credentials or prompts in CI artifacts.
