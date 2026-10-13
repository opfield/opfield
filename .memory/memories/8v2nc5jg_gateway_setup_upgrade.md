---
{
  "id": "8v2nc5jg",
  "file_name": "8v2nc5jg_gateway_setup_upgrade",
  "tags": [
    "api",
    "installer",
    "opfield",
    "setup-wizard",
    "upgrade"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790420882600,
  "updated_at": 1791851306847
}
---
Opfield fresh-install gotchas (verified 2026-09-21, v2.10.1 -> v2.11.0-rc.4):
- `scripts/install.sh` installs only the latest STABLE tag. To reach an RC: set the update channel to preview via `PUT /api/admin/auth-settings {generalSettings:{updateChannel:"preview"}}`, then follow the STEPWISE path the release provider offers (e.g. 2.10.1 -> 2.10.2-rc.11 -> 2.11.0-rc.4); `POST /api/system/update` rejects any version except the advertised next one (VERSION_MISMATCH). The relay updates separately via `/api/system/relay-update`.
- Password/email-OTP sign-in in the setup wizard requires verified SMTP with TLS (starttls|tls only) and a trusted cert. Offline install: Mailpit with a self-signed CA, CA copied into the Opfield data volume, `NODE_EXTRA_CA_CERTS` added to /opt/gateway/.env (survives updates).
- Auth routes are mounted at `/auth/*`, not `/api/auth/*`. Cookie-session mutations need `X-CSRF-Token` from `GET /auth/csrf`. Many admin scopes (settings, users, groups) are denied to API tokens, so automate with the admin session.
- Setup wizard API: /api/setup/unlock -> wizard/apply -> wizard/license/community|activate -> wizard/complete.
- A paid key moves to a new installation after explicit deactivation or >1h offline of the previous one. PKI is a switchable module, OFF by default even on Enterprise (`generalSettings.features.pkiEnabled`).
- REST `POST /api/docker/nodes/:id/containers` only creates; call `/start` separately. Blue/green `deploy` auto-switches after the health check.
- Daemon installers accept `--version vX.Y.Z-rc.N`; the enrollment token is returned once by `POST /api/nodes`.
