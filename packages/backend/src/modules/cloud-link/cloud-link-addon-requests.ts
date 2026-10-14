import type { CloudInferenceModel } from '@/modules/inference/providers/inference-cloud.js';
import {
  type CloudAnswer,
  type CloudLinkAccess,
  type CloudLinkProbe,
  type CloudRequest,
  NOT_MANAGED_BY_CLOUD,
} from './cloud-link.types.js';

/** Kinds the account sends a managed installation for its add-ons; idempotent desired-state requests. */
export const CLOUD_ADDON_REQUEST_TYPES: ReadonlySet<string> = new Set([
  'public-alias',
  'mail-config',
  'inference-cloud',
]);

const MAX_DOMAIN_LENGTH = 253;
const MAX_EMAIL_LENGTH = 254;
const MAX_MAIL_LIMIT = 1_000_000;
const EMAIL_PATTERN = /^[^@\s"<>]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const MAX_API_KEY_LENGTH = 4096;
const MAX_MODELS = 8;
const MAX_TOKENS = 100_000_000;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Input modalities Opfield publishes for a model. */
const CLOUD_MODEL_MODALITIES = ['text', 'image', 'video'] as const;
/** Capability keys Opfield's model contract checks; the others are dropped. */
const CLOUD_MODEL_CAPABILITIES = [
  'tools',
  'reasoning',
  'vision',
  'parallelToolCalls',
  'reasoningSummaries',
  'serviceTier',
  'verbosity',
] as const;

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
    case 'mail-config': {
      const { enabled, from, limits } = request.params;
      if (typeof enabled !== 'boolean') {
        return invalid(request.id, 'INVALID_MAIL_CONFIG', 'params.enabled is true or false');
      }
      if (!enabled) return answerMailConfig(probe, request.id, { enabled: false });
      if (typeof from !== 'string' || from.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(from.trim())) {
        return invalid(request.id, 'INVALID_MAIL_CONFIG', 'params.from is the address the account sends from');
      }
      const limit = (value: unknown) =>
        typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_MAIL_LIMIT ? value : null;
      const values = limits && typeof limits === 'object' ? (limits as Record<string, unknown>) : {};
      const month = limit(values.month);
      const day = limit(values.day);
      const hour = limit(values.hour);
      if (month === null || day === null || hour === null) {
        return invalid(request.id, 'INVALID_MAIL_CONFIG', 'params.limits has month, day and hour as positive integers');
      }
      return answerMailConfig(probe, request.id, {
        enabled: true,
        from: from.trim().toLowerCase(),
        limits: { month, day, hour },
      });
    }
    case 'inference-cloud': {
      const { enabled, baseUrl, apiKey, models } = request.params;
      if (typeof enabled !== 'boolean') {
        return invalid(request.id, 'INVALID_INFERENCE_CLOUD', 'params.enabled is true or false');
      }
      const secret = typeof apiKey === 'string' ? apiKey : undefined;
      if (!enabled) return answerInferenceCloud(probe, request.id, { enabled: false });
      if (typeof baseUrl !== 'string' || !isHttpsUrl(baseUrl)) {
        return invalid(request.id, 'INVALID_INFERENCE_CLOUD', 'params.baseUrl is the https URL of the endpoint');
      }
      if (!secret?.trim() || secret.length > MAX_API_KEY_LENGTH) {
        return invalid(request.id, 'INVALID_INFERENCE_CLOUD', 'params.apiKey is the key of this installation');
      }
      const parsed = Array.isArray(models) && models.length <= MAX_MODELS ? models.map(parseCloudModel) : null;
      if (!parsed?.length || parsed.some((model) => model === null)) {
        return invalid(
          request.id,
          'INVALID_INFERENCE_CLOUD',
          'params.models lists the models (publicId, displayName, contextWindow, maxInputTokens, ...)'
        );
      }
      return answerInferenceCloud(
        probe,
        request.id,
        {
          enabled: true,
          baseUrl: baseUrl.trim().replace(/\/+$/, ''),
          apiKey: secret.trim(),
          models: parsed as CloudInferenceModel[],
        },
        secret
      );
    }
    default:
      return { id: request.id, ok: false, error: `Unknown request type: ${request.type.slice(0, 64)}` };
  }
}

async function answerInferenceCloud(
  probe: CloudLinkProbe,
  id: string,
  input: Parameters<CloudLinkProbe['inferenceCloud']>[0],
  secret?: string
): Promise<CloudAnswer> {
  try {
    return { id, ok: true, data: await probe.inferenceCloud(input) };
  } catch (error) {
    // Never the key, in the answer or its audit entry.
    return addonFailure(id, error, secret?.trim() || undefined);
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password && value.length <= 2048;
  } catch {
    return false;
  }
}

/** One model of the account's list; the Go field names (PublicID, …) are taken as well as camelCase. */
/**
 * One model of the account's list: `{ publicId, displayName, contextWindow, maxInputTokens, maxOutputTokens|null,
 * modalities, capabilities, reasoningEfforts }`. Modalities and capability keys Opfield does not know are dropped,
 * never refused; a capability is on only when its value is true.
 */
function parseCloudModel(value: unknown): CloudInferenceModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {
    publicId,
    displayName,
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    modalities,
    capabilities,
    reasoningEfforts,
  } = value as Record<string, unknown>;
  const count = (item: unknown) =>
    typeof item === 'number' && Number.isInteger(item) && item > 0 && item <= MAX_TOKENS ? item : null;
  const words = (item: unknown) =>
    Array.isArray(item)
      ? item.flatMap((entry) =>
          typeof entry === 'string' && entry.trim() && entry.length <= 32 ? [entry.trim().toLowerCase()] : []
        )
      : [];
  const context = count(contextWindow);
  const maxInput = count(maxInputTokens);
  const maxOutput = maxOutputTokens === null || maxOutputTokens === undefined ? null : count(maxOutputTokens);
  if (
    typeof publicId !== 'string' ||
    !MODEL_ID_PATTERN.test(publicId) ||
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    displayName.length > 80 ||
    context === null ||
    maxInput === null ||
    maxInput > context
  ) {
    return null;
  }
  const knownModalities = [...new Set(words(modalities))].filter((modality) =>
    (CLOUD_MODEL_MODALITIES as readonly string[]).includes(modality)
  );
  const flags = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) ? capabilities : {};
  const knownCapabilities = Object.fromEntries(
    CLOUD_MODEL_CAPABILITIES.map((key) => [key, (flags as Record<string, unknown>)[key] === true] as const)
  );
  const efforts = [...new Set(words(reasoningEfforts))].slice(0, 8);
  return {
    publicId,
    displayName: displayName.trim(),
    contextWindow: context,
    maxInputTokens: maxInput,
    maxOutputTokens: maxOutput,
    modalities: knownModalities.includes('text') ? knownModalities : ['text', ...knownModalities],
    capabilities: {
      ...knownCapabilities,
      vision: knownCapabilities.vision === true && knownModalities.includes('image'),
    },
    reasoningEfforts: efforts,
  };
}

async function answerMailConfig(
  probe: CloudLinkProbe,
  id: string,
  input: Parameters<CloudLinkProbe['mailConfig']>[0]
): Promise<CloudAnswer> {
  try {
    return { id, ok: true, data: await probe.mailConfig(input) };
  } catch (error) {
    return addonFailure(id, error);
  }
}
