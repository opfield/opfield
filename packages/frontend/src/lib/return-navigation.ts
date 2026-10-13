type LocationParts = {
  pathname: string;
  search?: string;
  hash?: string;
};

type ReturnNavigationState = {
  returnTo?: unknown;
};

const PROBE_ORIGIN = "http://opfield.local";

/**
 * True for a path of this console: one leading slash, no scheme, no host, no backslashes or
 * control characters (browsers read `/\host` and `//host` as another site). Anything else is never
 * navigated to, so a crafted link state or stored trail cannot send the user off the console.
 */
export function isSafeInternalPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
  }
  try {
    const parsed = new URL(value, PROBE_ORIGIN);
    if (parsed.origin !== PROBE_ORIGIN) return false;
    // API and auth endpoints are server routes, not console pages.
    return !/^\/(api|auth)(\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function createReturnNavigationState(location: LocationParts) {
  return {
    returnTo: `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`,
  };
}

/** The `returnTo` of a link state when it is a safe console path, else null. */
export function readReturnNavigationTarget(state: unknown): string | null {
  const returnTo = (state as ReturnNavigationState | null)?.returnTo;
  return isSafeInternalPath(returnTo) ? returnTo : null;
}

export function getReturnNavigationTarget(state: unknown, fallback: string) {
  return readReturnNavigationTarget(state) ?? fallback;
}

export function preserveReturnNavigationState(state: unknown) {
  const returnTo = readReturnNavigationTarget(state);
  return returnTo ? { returnTo } : {};
}
