---
{
  "id": "acdy69d9",
  "file_name": "acdy69d9_gateway_license_server",
  "tags": [
    "license",
    "license-server",
    "opfield",
    "repo",
    "workflow"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1777057210510,
  "updated_at": 1791851374041
}
---
Opfield licensing contract (plan names and grace values re-verified in `packages/backend/src/modules/license/license.types.ts` on 2026-10-01):

- Licensing uses a separate Go service (binary `gls`, SQLite storage, CLI license management, HTTP API) that lives in its own repository. Opfield talks to the fixed vendor endpoint `LICENSE_SERVER_URL = https://license.thesqlabs.com`, not an installation-defined URL. The same service serves signed private-core releases (`/api/v1/releases/*`).
- License state is stored in the existing `settings` table with encrypted key storage through `CryptoService`. Scopes are `license:view` and `license:manage`.
- Plans: `community`, `personal`, `business`, `enterprise` (the older "Homelab" label is gone). Community installs also heartbeat (every 30 min; paid every 15 min).
- Offline grace is 100 days (`LICENSE_OFFLINE_GRACE_DAYS`). After expiry or a plan downgrade, paid entitlements drop after a plan-specific grace: personal 24 h, business 72 h, enterprise 168 h.
- Activation may replace the active installation; a paid key moves to a new installation after explicit deactivation or when the previous one has been offline for over an hour.
- Post-grace behaviour must follow the owner's continuity contract: running workloads, data plane, scheduled jobs, viewing and deletion keep working; only creating paid resources and changing their configuration is blocked.
