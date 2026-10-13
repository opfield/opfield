---
{
  "id": "yjerrsgn",
  "file_name": "yjerrsgn_gateway_lockout_policy",
  "tags": [
    "bootstrap",
    "gotcha",
    "installer",
    "opfield",
    "setup"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1777903845880,
  "updated_at": 1791851990550
}
---
Opfield first-run setup gating (verified against `packages/backend/src/modules/setup/setup-token-policy.ts` and `setup.routes.ts` on 2026-10-01; this replaces the older `setup:started_at` + one-hour-window design recorded in May 2026):

- The setup API is open only while setup is incomplete. Completion is the settings key `setup:completed_at`; `setup:forced_open` keeps the wizard open.
- On startup `ensureSetupStarted()` marks setup complete when the installation is already configured (any real user other than the internal `system:gateway-setup` subject) or when the process was not started by an explicit installer bootstrap. Only an installer bootstrap on an empty database sets `setup:forced_open`, so legacy/manual deployments never reopen setup just because their user table is empty.
- Wizard flow: `POST /api/setup/unlock` -> `wizard/apply` -> `wizard/license/community` or `wizard/license/activate` -> `POST /api/setup/wizard/complete`. Setup access tokens live 24 hours.
- This avoids racing installer SSL/bootstrap work against the first real sign-in.
