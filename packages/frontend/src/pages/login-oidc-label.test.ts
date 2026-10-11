import { describe, expect, it } from "vitest";
import { oidcButtonLabel } from "./Login";

describe("OIDC sign-in button", () => {
  it("names the Opfield account on a managed installation and the provider otherwise", () => {
    expect(oidcButtonLabel({ oidcDisplayName: "Opfield account" })).toBe(
      "Sign in with Opfield account"
    );
    expect(oidcButtonLabel({ oidcDisplayName: "Acme login" })).toBe("Sign in with Acme login");
    expect(oidcButtonLabel({ oidcDisplayName: null })).toBe("Sign in with SSO");
    expect(oidcButtonLabel({ oidcDisplayName: "  " })).toBe("Sign in with SSO");
    expect(oidcButtonLabel({})).toBe("Sign in with SSO");
  });
});
