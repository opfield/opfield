import {
  CLOUD_LOG_TAIL_DEFAULT,
  CLOUD_LOG_TAIL_MAX,
  type CloudAnswer,
  type CloudLinkProbe,
  type CloudRequest,
} from './cloud-link.types.js';

const MAX_REQUEST_ID_LENGTH = 200;
const MAX_SERVICE_NAME_LENGTH = 128;

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
export async function answerCloudRequest(probe: CloudLinkProbe, request: CloudRequest): Promise<CloudAnswer> {
  try {
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
      default:
        return { id: request.id, ok: false, error: `Unknown request type: ${request.type.slice(0, 64)}` };
    }
  } catch (error) {
    return { id: request.id, ok: false, error: errorMessage(error) };
  }
}
