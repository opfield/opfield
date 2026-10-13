---
{
  "id": "hic3s1ta",
  "file_name": "hic3s1ta_oidc_session_metadata",
  "tags": [
    "audit",
    "auth",
    "oidc",
    "sessions"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1786007166891,
  "updated_at": 1791851617124
}
---
Opfield OIDC session metadata: audit logging resolves client IP and User-Agent from the incoming callback request, but browser-session records must receive the same metadata explicitly. Auth routes should call AuthService.handleCallback with getClientIpForContext(c) and c.req.header('user-agent'); AuthService must pass { authMethod: 'oidc', ipAddress, userAgent } to SessionService.createSession. Do not backfill older sessions from audit entries: there is no reliable session-to-audit linkage. The profile presents known browser/platform labels derived from stored User-Agent; existing sessions remain Unknown until the user signs in again.
