import { isValidNodeServiceAddress } from '@/modules/nodes/node-service-address.js';

/** The relay worker's default service port: the relay installer binds it unless given --service-port. */
export const DEFAULT_RELAY_SERVICE_PORT = 9443;

/** Advertised by relay supervisors that move their worker to another TCP port (SetRelayServicePortCommand). */
export const RELAY_SERVICE_PORT_CAPABILITY = 'relay_service_port_v1';

const MAX_ADVERTISED_ADDRESSES = 10;

export function isRelayServicePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * The service port an operator chose when creating a relay node. The node keeps it in its metadata until the relay
 * enrolls; from then on the relay instance holds the port daemons dial.
 */
export function requestedRelayServicePort(metadata: unknown): number {
  const port =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).relayServicePort : undefined;
  return isRelayServicePort(port) ? port : DEFAULT_RELAY_SERVICE_PORT;
}

export interface RelayServiceEndpoint {
  servicePort: number;
  advertisedAddresses: string[];
}

/**
 * Where a relay supervisor's runtime status says daemons reach its worker, when that differs from what Opfield holds;
 * null when it does not. The supervisor reports the port its worker listens on, and that port is what daemons must
 * dial, whatever was chosen when the node was created. An operator may list more addresses than the one the installer
 * advertised (a NAT address, a second interface), so Opfield keeps its list while the report names only addresses on
 * it. A report naming an address Opfield does not list means the relay was installed again with another address: the
 * reported addresses replace the list.
 */
export function reportedRelayServiceEndpoint(
  current: { servicePort: number; advertisedAddresses: readonly string[] },
  report: { servicePort?: number | null; advertisedAddresses?: readonly string[] | null }
): RelayServiceEndpoint | null {
  const servicePort = isRelayServicePort(report.servicePort) ? report.servicePort : current.servicePort;
  const reported = [...new Set((report.advertisedAddresses ?? []).map((address) => address.trim()))];
  const reportedValid =
    reported.length > 0 &&
    reported.length <= MAX_ADVERTISED_ADDRESSES &&
    reported.every((address) => address.length <= 255 && isValidNodeServiceAddress(address));
  const advertisedAddresses =
    reportedValid && reported.some((address) => !current.advertisedAddresses.includes(address))
      ? reported
      : [...current.advertisedAddresses];
  const addressesChanged =
    advertisedAddresses.length !== current.advertisedAddresses.length ||
    advertisedAddresses.some((address, index) => address !== current.advertisedAddresses[index]);
  if (servicePort === current.servicePort && !addressesChanged) return null;
  return { servicePort, advertisedAddresses };
}

/**
 * The endpoint a relay's runtime status moves it to, only once the relay serves there (ready or draining): a worker
 * still trying a port (a port change that may roll back, a worker that cannot bind) reports no state that serves, and
 * daemons must not be handed that port. Null when the endpoint stays.
 */
export function servedRelayServiceEndpoint(
  current: { servicePort: number; advertisedAddresses: readonly string[] },
  report: { servicePort?: number | null; advertisedAddresses?: readonly string[] | null },
  state: string
): RelayServiceEndpoint | null {
  if (state !== 'ready' && state !== 'draining') return null;
  return reportedRelayServiceEndpoint(current, report);
}
