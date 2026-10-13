---
{
  "id": "elp4yliv",
  "file_name": "elp4yliv_session_auth_userid",
  "tags": [
    "auth",
    "backward-compatibility",
    "sessions"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1785710126602,
  "updated_at": 1791851527317
}
---
Opfield session compatibility: Older Redis sessions may include session.userId but not a nested session.user object. Middleware, session listing, and WebSocket authentication must resolve the live account using session.userId ?? session.user?.id and must never directly dereference session.user.id. SessionService.getSession must also treat legacy auth metadata defensively and not assume session.user exists. This prevents runtime errors like "Cannot read properties of undefined (reading 'id')" when revoking CSRF-protected sessions created by older versions.
