import { createChildLogger } from '@/lib/logger.js';
import {
  CLOUD_LOG_TAIL_DEFAULT,
  CLOUD_LOG_TAIL_MAX,
  CLOUD_NODE_KINDS,
  CLOUD_PRIVILEGED_REQUEST_TYPES,
  CLOUD_SSO_REVOKE_MAX_SUBJECTS,
  CLOUD_SSO_REVOKE_REASONS,
  type CloudAnswer,
  type CloudLinkAccess,
  type CloudLinkProbe,
  type CloudRequest,
  type CloudSsoRevokeReason,
  REMOTE_MANAGEMENT_OFF,
  resolveCloudNodeKind,
} from './cloud-link.types.js';
import { answerAddonRequest, CLOUD_ADDON_REQUEST_TYPES } from './cloud-link-addon-requests.js';

const logger = createChildLogger('CloudLinkRequests');

const MAX_REQUEST_ID_LENGTH = 200;
const MAX_SERVICE_NAME_LENGTH = 128;
const MAX_CLIENT_SECRET_LENGTH = 4096;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
/** `users.oidc_subject` is varchar(255). */
const MAX_SUBJECT_LENGTH = 255;

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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The code of an AppError (or any error that carries one); null otherwise. */
function errorCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null;
}

/** Answers one portal request with what the probe reads; never throws. */
export async function answerCloudRequest(
  probe: CloudLinkProbe,
  request: CloudRequest,
  access: CloudLinkAccess
): Promise<CloudAnswer> {
  try {
    // Reads are allowed once connected; actions need a managed cloud VM or "Allow remote management". The sign-in
    // client kinds check on their own (sso-client answers the installation's own request).
    if (CLOUD_PRIVILEGED_REQUEST_TYPES.has(request.type) && !(await access.privilegedAllowed())) {
      return { id: request.id, ok: false, ...REMOTE_MANAGEMENT_OFF };
    }
    // The add-ons the account sets on a managed installation (custom domain, cloud email, Opfield AI).
    if (CLOUD_ADDON_REQUEST_TYPES.has(request.type)) return await answerAddonRequest(probe, request, access);
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
          // The answer and its audit entry never carry the secret. A refusal keeps its code (the admin removed the
          // Opfield account provider or chose another one: OPFIELD_ACCOUNT_PROVIDER_MISSING).
          const code = errorCode(error);
          return {
            id: request.id,
            ok: false,
            error: errorMessage(error).replaceAll(clientSecret, '[REDACTED]'),
            ...(code ? { code } : {}),
          };
        }
      }
      case 'sso-client': {
        const { issuer, clientId, clientSecret, redirectUri } = request.params;
        const field = (value: unknown, max: number) =>
          typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
        const client = {
          issuer: field(issuer, MAX_URL_LENGTH),
          clientId: field(clientId, MAX_CLIENT_ID_LENGTH),
          clientSecret: field(clientSecret, MAX_CLIENT_SECRET_LENGTH),
          redirectUri: field(redirectUri, MAX_URL_LENGTH),
        };
        const secret = typeof clientSecret === 'string' ? clientSecret : '';
        if (!client.issuer || !client.clientId || !client.clientSecret || !client.redirectUri) {
          return {
            id: request.id,
            ok: false,
            code: 'INVALID_SSO_CLIENT',
            error: 'params needs issuer, clientId, clientSecret and redirectUri',
          };
        }
        try {
          return {
            id: request.id,
            ok: true,
            data: await probe.ssoClient(client as { [K in keyof typeof client]: string }),
          };
        } catch (error) {
          // Never the secret, in the answer or its audit entry.
          const code = errorCode(error);
          const message = errorMessage(error);
          return {
            id: request.id,
            ok: false,
            error: secret ? message.replaceAll(secret, '[REDACTED]') : message,
            ...(code ? { code } : {}),
          };
        }
      }
      case 'sso-revoke': {
        // Only removes access the account gave, so it needs no remote management. The error text never repeats a
        // subject (the portal's subjects are account ids, but an error must never carry an email).
        const { issuer, subjects, reason } = request.params;
        const invalid = (error: string): CloudAnswer => ({
          id: request.id,
          ok: false,
          code: 'INVALID_SSO_REVOKE',
          error,
        });
        if (typeof issuer !== 'string' || !issuer.trim() || issuer.length > MAX_URL_LENGTH || !isHttpUrl(issuer)) {
          return invalid('params.issuer is the Opfield account issuer, an http(s) URL');
        }
        if (
          !Array.isArray(subjects) ||
          subjects.length === 0 ||
          subjects.length > CLOUD_SSO_REVOKE_MAX_SUBJECTS ||
          !subjects.every(
            (subject) =>
              typeof subject === 'string' &&
              subject.trim() === subject &&
              subject &&
              subject.length <= MAX_SUBJECT_LENGTH
          )
        ) {
          return invalid(`params.subjects lists 1 to ${CLOUD_SSO_REVOKE_MAX_SUBJECTS} account ids (OIDC sub)`);
        }
        if (typeof reason !== 'string' || !(CLOUD_SSO_REVOKE_REASONS as readonly string[]).includes(reason)) {
          return invalid(`params.reason is one of ${CLOUD_SSO_REVOKE_REASONS.join(', ')}`);
        }
        try {
          return {
            id: request.id,
            ok: true,
            data: await probe.ssoRevoke({
              issuer: issuer.trim(),
              subjects: subjects as string[],
              reason: reason as CloudSsoRevokeReason,
            }),
          };
        } catch (error) {
          const code = errorCode(error);
          logger.warn('Could not remove the access the Opfield account asked to remove', {
            error: errorMessage(error),
          });
          return {
            id: request.id,
            ok: false,
            error: 'The installation could not remove the access',
            ...(code ? { code } : {}),
          };
        }
      }
      default:
        return { id: request.id, ok: false, error: `Unknown request type: ${request.type.slice(0, 64)}` };
    }
  } catch (error) {
    return { id: request.id, ok: false, error: errorMessage(error) };
  }
}
