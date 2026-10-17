import { describe, expect, it } from "vitest";
import { getLoginRedirectUrl, resolveAuthReturnTo } from "./auth-return-to";

const ORIGIN = "https://opfield.example.com";

describe("getLoginRedirectUrl", () => {
  it("sends OAuth consent returns through the login page so local sign-in works", () => {
    expect(getLoginRedirectUrl(`${ORIGIN}/oauth/consent?request=abc`)).toBe(
      `/login?return_to=${encodeURIComponent(`${ORIGIN}/oauth/consent?request=abc`)}`
    );
  });
});

describe("resolveAuthReturnTo", () => {
  it("keeps same-origin paths, including OAuth authorization requests", () => {
    const authorize = `${ORIGIN}/api/oauth/authorize/api/mcp?client_id=c&state=s`;
    expect(resolveAuthReturnTo(`?return_to=${encodeURIComponent(authorize)}`, ORIGIN)).toBe(
      "/api/oauth/authorize/api/mcp?client_id=c&state=s"
    );
    expect(resolveAuthReturnTo("?return_to=%2Fproxy-hosts%3Ftab%3Dssl", ORIGIN)).toBe(
      "/proxy-hosts?tab=ssl"
    );
  });

  it("falls back to the dashboard for other origins and protocol-relative paths", () => {
    for (const value of [
      "https://evil.example/path",
      "//evil.example/path",
      "/\\evil.example/path",
      `${ORIGIN}//evil.example/path`,
      "javascript:alert(1)",
      `${ORIGIN}/login?return_to=/`,
    ]) {
      expect(resolveAuthReturnTo(`?return_to=${encodeURIComponent(value)}`, ORIGIN)).toBe("/");
    }
  });
});
