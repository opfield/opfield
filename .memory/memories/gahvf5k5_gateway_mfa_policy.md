---
{
  "id": "gahvf5k5",
  "file_name": "gahvf5k5_gateway_mfa_policy",
  "tags": [
    "mfa",
    "opfield",
    "realtime",
    "security",
    "sessions"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785708614178,
  "updated_at": 1791851557433
}
---
## Opfield Local MFA

- Local accounts with a registered TOTP factor or passkey receive an MFA challenge after password/email-OTP sign-in, regardless of group policy.
- `requireGateway2fa` remains a direct-group-only policy. It requires enrollment for local non-OIDC users without a factor; OIDC users remain excluded because their identity provider manages MFA, and bearer API/OAuth credentials are unchanged.
- Authentication settings persist `mfaExistingSessionGracePeriodDays` (default 3; editable in the existing Authentication UI from 0 to 7) for future direct false-to-true group MFA transitions.
- Enabling group MFA stamps current affected local browser sessions with `mfaGraceExpiresAt`. A legacy cookie session without `mfaSatisfiedAt` remains usable only until that fixed deadline; at or after it, required authentication destroys the session and returns MFA sign-in required.
- Disabling group MFA clears affected session markers. Middleware also ignores a stale marker whenever the group policy is off.
- Creating an MFA factor alone does not satisfy an existing legacy session; a fresh MFA-backed sign-in is required. The Dashboard shows the precise deadline and a reauthentication warning.
- Group MFA policy changes publish the user-targeted `mfa.required.<userId>` channel for every affected direct local member in both directions, including users who already have a factor, so active dashboards refresh the grace deadline. WebSocket access remains restricted to the authenticated matching user.
- `RealtimeBridge`, mounted for every authenticated session, invalidates the shared dashboard bootstrap; `AdminGroups` also invalidates the initiating administrator's bootstrap immediately.
- The MFA attention notice is yellow. A factorless user can open `MfaSetupWizard` in standalone mode; any legacy session in grace is instructed to sign out and perform a fresh MFA-backed sign-in without mutating finalize-setup/onboarding state.

Related contracts kept elsewhere (not duplicated here): the shared Dashboard bootstrap, realtime invalidation, Sidebar badge and Assistant pins live in the Dashboard bootstrap memory; legacy Redis session compatibility (`session.userId ?? session.user?.id`) lives in the session-compatibility memory.
