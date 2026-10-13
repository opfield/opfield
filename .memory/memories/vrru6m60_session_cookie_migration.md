---
{
  "id": "vrru6m60",
  "file_name": "vrru6m60_session_cookie_migration",
  "tags": [
    "auth",
    "backward-compatibility",
    "cookies",
    "http",
    "https",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785917497779,
  "updated_at": 1791851914584
}
---
Opfield browser session cookie contract (merged 2026-10-01 with the localhost auth-recovery note):

- Session cookies use separate, installation-namespaced names for HTTP and HTTPS. A browser cannot overwrite a pre-existing Secure cookie with an HTTP Set-Cookie of the same name, which otherwise causes a successful login followed by `/auth/me` 401 after switching an installation from internal HTTPS to HTTP.
- Derive the short namespace from the persistent per-install PKI master key, write the name matching the configured public URL transport, and accept both new names plus the legacy `session_id` during migration. Preserve legacy cookie support for upgrade compatibility.
- Cookie selection must prefer the namespaced cookie matching the current request transport before the other transport's cookie. Apply the same ordering in the HTTP auth middleware and in WebSocket auth; otherwise REST authenticates while the AI Workspace WebSocket returns `Invalid or expired session`.
- On loopback password login also emit the legacy `session_id` compatibility cookie.
- Verify with: login then `/auth/me`; a request carrying a stale HTTPS cookie plus a fresh HTTP cookie; and a real browser reload that shows an enabled AI composer.
