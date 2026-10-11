import {
  CLOUD_LOG_TAIL_DEFAULT,
  CLOUD_LOG_TAIL_MAX,
  CLOUD_MANAGED_ONLY_REQUEST_TYPES,
  CLOUD_NODE_KINDS,
  CLOUD_PRIVILEGED_REQUEST_TYPES,
  type CloudAnswer,
  type CloudLinkAccess,
  type CloudLinkProbe,
  type CloudRequest,
  NOT_MANAGED_BY_CLOUD,
  REMOTE_MANAGEMENT_OFF,
  resolveCloudNodeKind,
} from './cloud-link.types.js';

const MAX_REQUEST_ID_LENGTH = 200;
const MAX_SERVICE_NAME_LENGTH = 128;
const MAX_CLIENT_SECRET_LENGTH = 4096;

/** A text frame from the portal as a request; null for anything that is not one (pings, unknown messages). */
export function parseCloudRequest(text: string): CloudRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, type, params } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id || id.length > MAX_REQUEST_ID_LENGTH) return null;
  if (typeof type !== 'string' || !type) return null;
  return {
    id,
    type,
    params: params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {},
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Answers one portal request with what the probe reads; never throws. */
export async function answerCloudRequest(
  probe: CloudLinkProbe,
  request: CloudRequest,
  access: CloudLinkAccess
): Promise<CloudAnswer> {
  try {
    // Reads are allowed once connected; actions need a managed cloud VM or "Allow remote management".
    if (CLOUD_PRIVILEGED_REQUEST_TYPES.has(request.type) && !(await access.privilegedAllowed())) {
      return { id: request.id, ok: false, ...REMOTE_MANAGEMENT_OFF };
    }
    if (CLOUD_MANAGED_ONLY_REQUEST_TYPES.has(request.type) && !(await access.managedByCloud())) {
      return { id: request.id, ok: false, ...NOT_MANAGED_BY_CLOUD };
    }
    switch (request.type) {
      case 'state':
        return { id: request.id, ok: true, data: await probe.state() };
      case 'services':
        return { id: request.id, ok: true, data: { services: await probe.services() } };
      case 'logs': {
        const { service, tail, since } = request.params;
        if (typeof service !== 'string' || !service.trim() || service.length > MAX_SERVICE_NAME_LENGTH) {
          return { id: request.id, ok: false, error: 'params.service names the service to read' };
        }
        let sinceMs: number | undefined;
        if (since !== undefined && since !== null && since !== '') {
          sinceMs = typeof since === 'string' ? Date.parse(since) : Number.NaN;
          if (Number.isNaN(sinceMs))
            return { id: request.id, ok: false, error: 'params.since is not an RFC 3339 time' };
        }
        const requestedTail =
          typeof tail === 'number' && Number.isFinite(tail) ? Math.floor(tail) : CLOUD_LOG_TAIL_DEFAULT;
        const cappedTail = Math.min(CLOUD_LOG_TAIL_MAX, Math.max(1, requestedTail));
        const name = service.trim();
        const lines = await probe.logs(name, { tail: cappedTail, ...(sinceMs !== undefined ? { sinceMs } : {}) });
        return { id: request.id, ok: true, data: { service: name, lines } };
      }
      case 'setup-link':
        return { id: request.id, ok: true, data: await probe.setupLink() };
      case 'node-token': {
        const { name, kind, address, port } = request.params;
        if (name !== undefined && name !== null && typeof name !== 'string') {
          return { id: request.id, ok: false, error: 'params.name is the name of the node' };
        }
        const resolved = resolveCloudNodeKind(kind);
        if (!resolved) {
          return { id: request.id, ok: false, error: `params.kind is one of ${CLOUD_NODE_KINDS.join(', ')}` };
        }
        if (address !== undefined && address !== null && typeof address !== 'string') {
          return { id: request.id, ok: false, error: 'params.address is the address a relay advertises' };
        }
        if (port !== undefined && port !== null && (typeof port !== 'number' || !Number.isInteger(port))) {
          return { id: request.id, ok: false, error: 'params.port is the port a relay listens on' };
        }
        if (resolved === 'relay' && !address?.trim()) {
          return {
            id: request.id,
            ok: false,
            error: 'A relay node needs params.address, the reachable IP or hostname it advertises',
          };
        }
        const { nodeId: _nodeId, ...data } = await probe.nodeToken({
          kind: resolved,
          ...(name ? { name } : {}),
          ...(resolved === 'relay' && address ? { address: address.trim() } : {}),
          ...(resolved === 'relay' && typeof port === 'number' ? { port } : {}),
        });
        return { id: request.id, ok: true, data };
      }
      case 'update-status':
        return { id: request.id, ok: true, data: await probe.updateStatus() };
      case 'update': {
        const { version } = request.params;
        if (version !== undefined && version !== null && typeof version !== 'string') {
          return { id: request.id, ok: false, error: 'params.version is a release version such as v2.11.5' };
        }
        const { started } = await probe.update(version ?? undefined);
        return { id: request.id, ok: true, data: { started } };
      }
      case 'sso-secret': {
        const { clientSecret } = request.params;
        if (
          typeof clientSecret !== 'string' ||
          !clientSecret.trim() ||
          clientSecret.length > MAX_CLIENT_SECRET_LENGTH
        ) {
          return { id: request.id, ok: false, error: 'params.clientSecret is the new client secret' };
        }
        try {
          return { id: request.id, ok: true, data: await probe.ssoSecret(clientSecret) };
        } catch (error) {
          // The answer and its audit entry never carry the secret.
          return { id: request.id, ok: false, error: errorMessage(error).replaceAll(clientSecret, '[REDACTED]') };
        }
      }
      default:
        return { id: request.id, ok: false, error: `Unknown request type: ${request.type.slice(0, 64)}` };
    }
  } catch (error) {
    return { id: request.id, ok: false, error: errorMessage(error) };
  }
}
