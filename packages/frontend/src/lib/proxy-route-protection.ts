import type { ProxyHost } from "@/types";

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function isOpfieldPublicRoute(
  host: Pick<ProxyHost, "domainNames">,
  publicUrl: string | null | undefined
): boolean {
  if (!publicUrl) return false;
  try {
    const publicHostname = normalizedHostname(new URL(publicUrl).hostname);
    return host.domainNames.some((domain) => normalizedHostname(domain) === publicHostname);
  } catch {
    return false;
  }
}
