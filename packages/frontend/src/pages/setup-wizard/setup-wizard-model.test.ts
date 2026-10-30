import { describe, expect, it } from "vitest";
import {
  deriveSignInOption,
  getAvailableSignInOptions,
  getSetupSteps,
  getSignInMethods,
  isAdminDraftValid,
  isCloudCodeValid,
  readCloudCallback,
  type SetupConfig,
} from "./setup-wizard-model";

const TAIL = ["logging", "finish", "license", "ai-workspace"];

describe("setup sign-in options", () => {
  it("asks for no administrator details with the Opfield account: whoever connects it is the admin", () => {
    expect(getSetupSteps({ option: "opfield_account", emailOtp: false })).toEqual([
      "public-url",
      "network",
      "auth-methods",
      "cloud-connect",
      ...TAIL,
    ]);
  });

  it("asks for the provider and the administrator's email with an OIDC provider", () => {
    expect(getSetupSteps({ option: "oidc", emailOtp: false })).toEqual([
      "public-url",
      "network",
      "auth-methods",
      "oidc-config",
      "admin-details",
      ...TAIL,
    ]);
    expect(getSetupSteps({ option: "oidc", emailOtp: false }, true)).not.toContain("admin-details");
  });

  it("needs SMTP with a password only for the extra email code, and always the authenticator app", () => {
    expect(getSetupSteps({ option: "password_totp", emailOtp: false })).toEqual([
      "public-url",
      "network",
      "auth-methods",
      "admin-details",
      "admin-2fa",
      ...TAIL,
    ]);
    expect(getSetupSteps({ option: "password_totp", emailOtp: true })).toEqual([
      "public-url",
      "network",
      "auth-methods",
      "smtp-config",
      "admin-details",
      "admin-2fa",
      ...TAIL,
    ]);
    // Once the administrator exists, only the authenticator app step remains.
    expect(getSetupSteps({ option: "password_totp", emailOtp: false }, true)).toEqual([
      "public-url",
      "network",
      "auth-methods",
      "admin-2fa",
      ...TAIL,
    ]);
  });

  it("turns on one primary method and never a password without the authenticator app option", () => {
    expect(getSignInMethods({ option: "opfield_account", emailOtp: true })).toEqual({
      oidc: true,
      password: false,
      emailOtp: false,
    });
    expect(getSignInMethods({ option: "oidc", emailOtp: false })).toEqual({
      oidc: true,
      password: false,
      emailOtp: false,
    });
    expect(getSignInMethods({ option: "password_totp", emailOtp: true })).toEqual({
      oidc: false,
      password: true,
      emailOtp: true,
    });
    expect(getSignInMethods({ option: null, emailOtp: true })).toEqual({
      oidc: false,
      password: false,
      emailOtp: false,
    });
  });

  it("keeps the option an existing administrator signs in with", () => {
    const admin = { email: "ada@example.com", name: "Ada", secondFactor: false };
    expect(getAvailableSignInOptions(null)).toEqual(["opfield_account", "oidc", "password_totp"]);
    expect(getAvailableSignInOptions({ ...admin, authMethod: "password" })).toEqual([
      "password_totp",
    ]);
    expect(getAvailableSignInOptions({ ...admin, authMethod: "oidc" })).toEqual([
      "opfield_account",
      "oidc",
    ]);
  });

  it("restores the option from the saved setup state", () => {
    const base = {
      administrator: null,
      auth: { methods: { oidc: false, password: false, emailOtp: false } },
      oidc: {
        configured: false,
        issuer: null,
        clientId: null,
        redirectUri: null,
        scopes: "openid",
        opfieldAccount: false,
      },
      cloud: {
        connected: false,
        accountEmail: null,
        administrator: null,
        signInClient: "none" as const,
        requestedAt: null,
      },
    } satisfies Pick<SetupConfig, "administrator" | "auth" | "oidc" | "cloud">;
    expect(deriveSignInOption(base)).toBeNull();
    expect(
      deriveSignInOption({
        ...base,
        cloud: { ...base.cloud, connected: true },
        oidc: { ...base.oidc, configured: true, opfieldAccount: true },
        auth: { methods: { oidc: true, password: false, emailOtp: false } },
      })
    ).toBe("opfield_account");
    expect(
      deriveSignInOption({
        ...base,
        oidc: { ...base.oidc, configured: true },
        auth: { methods: { oidc: true, password: false, emailOtp: false } },
      })
    ).toBe("oidc");
    expect(
      deriveSignInOption({
        ...base,
        administrator: {
          email: "ada@example.com",
          name: null,
          authMethod: "password",
          secondFactor: false,
        },
      })
    ).toBe("password_totp");
  });
});

describe("Opfield account connect", () => {
  it("reads the portal's answer only on the callback page", () => {
    expect(
      readCloudCallback({
        pathname: "/setup/cloud-callback",
        search: "?code=CLD-7K3M-Q9TX&state=s1",
      })
    ).toEqual({ code: "CLD-7K3M-Q9TX", state: "s1", error: null });
    expect(
      readCloudCallback({ pathname: "/setup/cloud-callback/", search: "?error=access_denied" })
    ).toEqual({ code: null, state: null, error: "access_denied" });
    expect(readCloudCallback({ pathname: "/", search: "?code=x" })).toBeNull();
  });

  it("takes a connect code in the forms account.opfield.dev shows", () => {
    expect(isCloudCodeValid("CLD-7K3M-Q9TX")).toBe(true);
    expect(isCloudCodeValid(" cld 7k3m q9tx ")).toBe(true);
    expect(isCloudCodeValid("7K3M-Q9TX")).toBe(true);
    expect(isCloudCodeValid("7K3M-Q9TO")).toBe(false);
    expect(isCloudCodeValid("7K3M-Q9T")).toBe(false);
  });
});

describe("administrator details", () => {
  it("needs a password only for the password option", () => {
    const admin = { name: "Ada", email: "ada@example.com", password: "" };
    expect(isAdminDraftValid(admin, false)).toBe(true);
    expect(isAdminDraftValid(admin, true)).toBe(false);
    expect(isAdminDraftValid({ ...admin, password: "a-long-password!" }, true)).toBe(true);
    expect(isAdminDraftValid({ ...admin, email: "ada" }, false)).toBe(false);
  });
});
