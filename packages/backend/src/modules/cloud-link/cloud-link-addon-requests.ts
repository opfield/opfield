import {
  type CloudAnswer,
  type CloudLinkAccess,
  type CloudLinkProbe,
  type CloudRequest,
  NOT_MANAGED_BY_CLOUD,
} from './cloud-link.types.js';

/** Kinds the account sends a managed installation for its add-ons; idempotent desired-state requests. */
export const CLOUD_ADDON_REQUEST_TYPES: ReadonlySet<string> = new Set(['public-alias']);

const MAX_DOMAIN_LENGTH = 253;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null;
}

/** ok:false with the error's code when it has one; `redact` removes a secret from the message. */
export function addonFailure(id: string, error: unknown, redact?: string): CloudAnswer {
  const code = errorCode(error);
  const message = errorMessage(error);
  return {
    id,
    ok: false,
    error: redact ? message.replaceAll(redact, '[REDACTED]') : message,
    ...(code ? { code } : {}),
  };
}

function invalid(id: string, code: string, error: string): CloudAnswer {
  return { id, ok: false, code, error };
}

/** Answers an add-on kind; only a managed installation takes them. Never throws. */
export async function answerAddonRequest(
  probe: CloudLinkProbe,
  request: CloudRequest,
  access: CloudLinkAccess
): Promise<CloudAnswer> {
  if (!(await access.managedByCloud())) return { id: request.id, ok: false, ...NOT_MANAGED_BY_CLOUD };
  switch (request.type) {
    case 'public-alias': {
      const { domain, retry } = request.params;
      if (
        domain !== null &&
        (typeof domain !== 'string' || !domain.trim() || domain.trim().length > MAX_DOMAIN_LENGTH)
      ) {
        return invalid(
          request.id,
          'INVALID_PUBLIC_ALIAS',
          'params.domain is a host name such as panel.example.com, or null'
        );
      }
      if (retry !== undefined && retry !== null && typeof retry !== 'boolean') {
        return invalid(request.id, 'INVALID_PUBLIC_ALIAS', 'params.retry is true or absent');
      }
      try {
        return {
          id: request.id,
          ok: true,
          data: await probe.publicAlias({ domain: domain === null ? null : domain.trim(), retry: retry === true }),
        };
      } catch (error) {
        return addonFailure(request.id, error);
      }
    }
    default:
      return { id: request.id, ok: false, error: `Unknown request type: ${request.type.slice(0, 64)}` };
  }
}
