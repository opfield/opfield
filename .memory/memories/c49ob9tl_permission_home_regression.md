---
{
  "id": "c49ob9tl",
  "file_name": "c49ob9tl_permission_home_regression",
  "tags": [
    "auth",
    "frontend",
    "permissions",
    "regression"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1788516383473,
  "updated_at": 1791851463767
}
---
Opfield's resetClientSessionState clears interfacePreferenceLoaded when authContextKey changes (user ID, sorted scopes, blocked state). RealtimeBridge's getUserPreferences effect must track that same auth context, not only user.id: live scope updates keep the ID unchanged, so an ID-only effect never reloads preferences and DashboardLayout remains on its blank Loading workspace gate on / or AI conversation routes. Reuse stores/auth.ts authContextKey for preference loading and route identity; keep the existing cancellation cleanup to discard old-context preference responses and failure hydration to unblock the UI. Regression coverage should drive permissions.changed.<userId> through RealtimeBridge with the real session reset callback, covering grant/revoke, failed preference fetch, in-flight old response, and unchanged/reordered scopes.
