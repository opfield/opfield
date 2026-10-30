import type { AIApprovalMode } from "@/lib/ai-approval-mode";
import { useAuthStore } from "@/stores/auth";
import type {
  AccessSignInConsent,
  BrowserSession,
  OAuthAuthorization,
  OAuthConsentPreview,
  User,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

const AUTH_BASE = "/auth";
export type PreferredInterface = "ai_workspace" | "operations_console";
export interface UserPreferences {
  aiApprovalMode: AIApprovalMode;
  preferredInterface: PreferredInterface | null;
  preferredInterfaceSelectedAt: string | null;
}

export function withAuthApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class AuthApiClient extends Base {
    // ── Auth ──────────────────────────────────────────────────────────

    async getCurrentUser(): Promise<User> {
      return this.request<User>("/auth/me");
    }

    async getUserPreferences(): Promise<UserPreferences> {
      return this.cachedRequest("auth:me:preferences", () =>
        this.request<UserPreferences>("/auth/me/preferences")
      );
    }

    async updateUserPreferences(input: {
      aiApprovalMode?: AIApprovalMode;
      preferredInterface?: PreferredInterface;
    }): Promise<UserPreferences> {
      this.invalidateCache("auth:me:preferences");
      const preferences = await this.request<UserPreferences>("/auth/me/preferences", {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      this.setCache("auth:me:preferences", preferences);
      return preferences;
    }

    async updateCurrentUserAvatar(avatar: Blob | null): Promise<User> {
      if (!avatar) {
        return this.request<User>("/auth/me/avatar", { method: "DELETE" });
      }
      const body = new FormData();
      body.append(
        "avatar",
        avatar,
        `avatar.${avatar.type === "image/png" ? "png" : avatar.type === "image/jpeg" ? "jpg" : "webp"}`
      );
      return this.request<User>("/auth/me/avatar", { method: "PUT", body });
    }

    async listCurrentUserSessions(): Promise<BrowserSession[]> {
      return this.request<BrowserSession[]>("/auth/me/sessions");
    }

    async revokeCurrentUserSession(id: string): Promise<void> {
      await this.request(`/auth/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    async revokeOtherCurrentUserSessions(): Promise<number> {
      const response = await this.request<{ revoked: number }>("/auth/me/sessions/revoke-others", {
        method: "POST",
      });
      return response.revoked;
    }

    async getCurrentUserMfaStatus(): Promise<{
      totpConfigured: boolean;
      passkeyCount: number;
      recoveryCodeCount: number;
      required: boolean;
    }> {
      return this.request("/auth/me/mfa");
    }

    async beginCurrentUserTotpSetup(): Promise<{ secret: string; uri: string }> {
      return this.request("/auth/me/mfa/totp/setup", { method: "POST" });
    }

    async resetCurrentUserTotp(): Promise<void> {
      await this.request("/auth/me/mfa/totp/reset", { method: "POST" });
    }

    async confirmCurrentUserTotpSetup(code: string): Promise<string[]> {
      const response = await this.request<{ recoveryCodes: string[] }>(
        "/auth/me/mfa/totp/confirm",
        { method: "POST", body: JSON.stringify({ code }) }
      );
      return response.recoveryCodes;
    }

    async regenerateCurrentUserRecoveryCodes(code: string): Promise<string[]> {
      const response = await this.request<{ recoveryCodes: string[] }>(
        "/auth/me/mfa/recovery-codes",
        { method: "POST", body: JSON.stringify({ code }) }
      );
      return response.recoveryCodes;
    }

    /** Prove an existing second factor before adding, replacing, or removing one. */
    async verifyCurrentUserStepUp(
      input: { totpCode: string } | { recoveryCode: string }
    ): Promise<void> {
      await this.request("/auth/me/mfa/step-up", { method: "POST", body: JSON.stringify(input) });
    }

    async beginCurrentUserStepUpPasskey(): Promise<
      { challenge: string } & Record<string, unknown>
    > {
      return this.request("/auth/me/mfa/step-up/passkey/options", { method: "POST" });
    }

    async finishCurrentUserStepUpPasskey(challenge: string, response: unknown): Promise<void> {
      await this.request("/auth/me/mfa/step-up/passkey/verify", {
        method: "POST",
        body: JSON.stringify({ challenge, response }),
      });
    }

    async listCurrentUserPasskeys(): Promise<
      Array<{ id: string; name: string; lastUsedAt: string | null; createdAt: string }>
    > {
      return this.request("/auth/me/passkeys");
    }

    async beginCurrentUserPasskeyRegistration(): Promise<Record<string, unknown>> {
      return this.request("/auth/me/passkeys/options", { method: "POST" });
    }

    async finishCurrentUserPasskeyRegistration(response: unknown, name?: string): Promise<void> {
      await this.request("/auth/me/passkeys", {
        method: "POST",
        body: JSON.stringify({ response, name }),
      });
    }

    async removeCurrentUserPasskey(id: string): Promise<void> {
      await this.request(`/auth/me/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    async logout(): Promise<void> {
      try {
        await this.request<void>("/auth/logout", { method: "POST" });
      } finally {
        this.clearCsrfToken();
        useAuthStore.getState().logout();
      }
    }

    async stopImpersonating(): Promise<void> {
      await this.request("/auth/impersonation/stop", { method: "POST" });
    }

    getLoginUrl(): string {
      return `${AUTH_BASE}/login`;
    }

    async getAccessSignInConsent(state: string): Promise<AccessSignInConsent> {
      return this.request<AccessSignInConsent>(
        `/api/access-sign-in/opfield/consent?state=${encodeURIComponent(state)}`
      );
    }

    /** Continue or Cancel: where the browser goes next (the route's provider callback). */
    async decideAccessSignIn(
      state: string,
      decision: "approve" | "deny"
    ): Promise<{ redirectUrl: string }> {
      return this.request<{ redirectUrl: string }>(
        `/api/access-sign-in/opfield/consent/${decision}`,
        { method: "POST", body: JSON.stringify({ state }) }
      );
    }

    async getOAuthConsent(requestId: string): Promise<OAuthConsentPreview> {
      return this.request<OAuthConsentPreview>(
        `/api/oauth/consent/${encodeURIComponent(requestId)}`
      );
    }

    async approveOAuthConsent(
      requestId: string,
      scopes: string[]
    ): Promise<{ redirectUrl: string }> {
      return this.request<{ redirectUrl: string }>(
        `/api/oauth/consent/${encodeURIComponent(requestId)}/approve`,
        {
          method: "POST",
          body: JSON.stringify({ scopes }),
        }
      );
    }

    async denyOAuthConsent(requestId: string): Promise<{ redirectUrl: string }> {
      return this.request<{ redirectUrl: string }>(
        `/api/oauth/consent/${encodeURIComponent(requestId)}/deny`,
        {
          method: "POST",
          body: JSON.stringify({}),
        }
      );
    }

    async listOAuthAuthorizations(): Promise<OAuthAuthorization[]> {
      return this.unwrapData(
        this.request<{ data: OAuthAuthorization[] }>("/api/oauth/authorizations")
      );
    }

    /** One authorization is one consent; the id comes from listOAuthAuthorizations. */
    async revokeOAuthAuthorization(authorizationId: string): Promise<void> {
      await this.request<void>(`/api/oauth/authorizations/${encodeURIComponent(authorizationId)}`, {
        method: "DELETE",
      });
    }

    /** Scopes, expiry and allowed addresses of one authorization; an absent field stays as it is. */
    async updateOAuthAuthorization(
      authorizationId: string,
      changes: { scopes?: string[]; expiresAt?: string | null; allowedIps?: string[] }
    ): Promise<OAuthAuthorization> {
      return this.unwrapData(
        this.request<{ data: OAuthAuthorization }>(
          `/api/oauth/authorizations/${encodeURIComponent(authorizationId)}`,
          {
            method: "PATCH",
            body: JSON.stringify(changes),
          }
        )
      );
    }
  };
}
