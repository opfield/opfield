/** The port the relay installer binds unless it is given another one. */
export const DEFAULT_RELAY_PORT = 9443;

/** The API error code of a relay address and port another relay of the pool already uses. */
export const RELAY_ENDPOINT_IN_USE = "RELAY_ENDPOINT_IN_USE";

/** A relay port typed into a form, or null while it is not a TCP port. */
export function parseRelayPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

/** What is wrong with a typed relay port, or null when it is a TCP port. */
export function relayPortError(value: string): string | null {
  return parseRelayPort(value) === null ? "Enter a port from 1 to 65535." : null;
}

/** Where daemons dial a relay: an address with the relay's service port, IPv6 in brackets. */
export function relayEndpointLabel(address: string, port: number): string {
  return `${address.includes(":") && !address.startsWith("[") ? `[${address}]` : address}:${port}`;
}
