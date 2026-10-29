import type {
  AccessIdentityProvider,
  AccessIdentityProviderRequest,
  AccessServiceToken,
  AccessServiceTokenCreated,
  AccessSignInSettings,
} from "@/types";
import type { ApiClientBaseConstructor } from "./api-mixins";

/** Sign-in settings of access lists: /api/access-settings, identity providers and service tokens. */
export function withAccessSignInApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class AccessSignInApiClient extends Base {
    async getAccessSignInSettings(): Promise<AccessSignInSettings> {
      return this.unwrapData(this.request<{ data: AccessSignInSettings }>("/access-settings"));
    }

    async updateAccessSignInSettings(data: AccessSignInSettings): Promise<AccessSignInSettings> {
      return this.unwrapData(
        this.request<{ data: AccessSignInSettings }>("/access-settings", {
          method: "PUT",
          body: JSON.stringify(data),
        })
      );
    }

    async listAccessIdentityProviders(): Promise<AccessIdentityProvider[]> {
      return this.unwrapData(
        this.request<{ data: AccessIdentityProvider[] }>("/access-identity-providers")
      );
    }

    async createAccessIdentityProvider(
      data: AccessIdentityProviderRequest
    ): Promise<AccessIdentityProvider> {
      return this.unwrapData(
        this.request<{ data: AccessIdentityProvider }>("/access-identity-providers", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async updateAccessIdentityProvider(
      id: string,
      data: Partial<AccessIdentityProviderRequest>
    ): Promise<AccessIdentityProvider> {
      return this.unwrapData(
        this.request<{ data: AccessIdentityProvider }>(`/access-identity-providers/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteAccessIdentityProvider(id: string): Promise<void> {
      await this.request(`/access-identity-providers/${id}`, { method: "DELETE" });
    }

    async listAccessServiceTokens(): Promise<AccessServiceToken[]> {
      return this.unwrapData(
        this.request<{ data: AccessServiceToken[] }>("/access-service-tokens")
      );
    }

    async createAccessServiceToken(data: {
      name: string;
      expiresAt: string | null;
    }): Promise<AccessServiceTokenCreated> {
      return this.unwrapData(
        this.request<{ data: AccessServiceTokenCreated }>("/access-service-tokens", {
          method: "POST",
          body: JSON.stringify(data),
        })
      );
    }

    async deleteAccessServiceToken(id: string): Promise<void> {
      await this.request(`/access-service-tokens/${id}`, { method: "DELETE" });
    }
  };
}
