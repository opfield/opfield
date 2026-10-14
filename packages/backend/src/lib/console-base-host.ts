/**
 * The console domain this process serves itself with its own certificate (OPFIELD_CONSOLE_DOMAIN), or null. It
 * keeps serving when the public URL names a custom domain: browsers on it are an allowed origin, and on a managed
 * installation nodes enrol against it.
 */
let consoleBaseHost: string | null = null;

export function setConsoleBaseHost(host: string | null): void {
  consoleBaseHost = host?.trim().toLowerCase() || null;
}

export function getConsoleBaseHost(): string | null {
  return consoleBaseHost;
}

/** `https://<console domain>`, or null without one. */
export function getConsoleBaseOrigin(): string | null {
  return consoleBaseHost ? `https://${consoleBaseHost}` : null;
}
