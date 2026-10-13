---
{
  "id": "x2uskhdm",
  "file_name": "x2uskhdm_gateway_pages_verification",
  "tags": [
    "deployments",
    "nginx",
    "pages",
    "routes",
    "runtime-config",
    "tags",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1786968575086,
  "updated_at": 1791851933072
}
---
Opfield Pages ships static sites as Projects with immutable Deployments and mutable Tags; `latest` is system-managed and custom Routes target Tags only. An optional single wildcard preview profile exposes immutable deployment hostnames from a one-label template containing `{hash}` exactly once, defaults to a separate registrable domain, and allows an explicit warned same-domain override. Opfield storage is canonical; Nginx nodes materialize replicas through `nginx_pages_v1`, use fixed daemon-generated static GET/HEAD configs, versioned Pages certificates, and idempotent config application that skips reload for unchanged content. Pages runtime configuration is public JSON exposed exactly as `window.runtime.config`: one Default object plus whole-object Tag overrides; immutable previews always use Default and Tag Routes use their override or Default. It is object-only, capped at 64 KiB, served from `/_gateway/pages/config.js` with no-store caching, updated without changing Deployment identity or artifact hashes, and capability-gated separately by `nginx_pages_config_v1`. Nginx daemon storage preflight must repair legacy public Pages release/runtime-config trees to directory mode 0755 and file mode 0644, because reconnect may skip rematerializing unchanged bindings; uploads and temporary artifacts must remain private at 0750/0600. Resumable uploads must re-authorize the same principal on append/finalize and recheck deploy-token tag policy. Tag publication uses generation/status claims and verified rollback state; deferred source cleanup persists as cleanup_pending. Pages integrates scopes, folders, EventBus/WebSocket, notifications/SIEM/audit, retention/housekeeping, navigation/search/cache/resource context. Verification baseline: full backend tests/lint/typecheck, full frontend tests/build plus targeted changed-file Biome, daemon Go tests, proto generation, Drizzle generation, git diff --check, and live Default/override/reset/reconnect proof without Deployment mutation.
