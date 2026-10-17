import { randomUUID } from 'node:crypto';
import { LEGACY_PROVIDER_CLIENT_ID } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceCredentialPayload } from './inference-provider.types.js';

const PROD_API = 'https://cloudcode-pa.googleapis.com';
const DAILY_API = 'https://daily-cloudcode-pa.googleapis.com';
const USER_AGENT = `antigravity/1.104.0 ${LEGACY_PROVIDER_CLIENT_ID}`;
type Fetcher = typeof fetch;

export async function discoverAntigravityProject(
  accessToken: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  const loaded = await fetcher(`${PROD_API}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (loaded.ok) {
    const project = extractProject(await loaded.json().catch(() => null));
    if (project) return project;
  }
  const onboarded = await fetcher(`${DAILY_API}/v1internal:onboardUser`, {
    method: 'POST',
    headers: { ...headers, 'x-goog-api-client': 'gl-node/24 antigravity/1.104.0' },
    body: JSON.stringify({
      tier_id: 'free-tier',
      metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity', ide_version: USER_AGENT },
    }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (onboarded.ok) {
    const project = extractProject(await onboarded.json().catch(() => null));
    if (project) return project;
  }
  throw new AppError(
    502,
    'INFERENCE_ANTIGRAVITY_PROJECT_UNAVAILABLE',
    'Cloud Code Assist project discovery failed for this account'
  );
}

export function antigravityRequest(
  credential: InferenceCredentialPayload,
  upstreamModel: string,
  wireBody: Record<string, unknown>,
  affinityKey?: string
): { path: string; body: Record<string, unknown>; headers: Record<string, string> } {
  if (!credential.projectId) {
    throw new AppError(
      401,
      'INFERENCE_ANTIGRAVITY_PROJECT_REQUIRED',
      'Cloud Code Assist project is missing; reconnect this account'
    );
  }
  const wireRequest = {
    ...wireBody,
    sessionId: affinityKey ?? randomUUID(),
  };
  return {
    path: '/v1internal:streamGenerateContent?alt=sse',
    body: {
      model: upstreamModel,
      userAgent: 'antigravity',
      requestType: 'agent',
      project: credential.projectId,
      requestId: `agent-${randomUUID()}`,
      request: wireRequest,
    },
    headers: { 'User-Agent': USER_AGENT, 'x-goog-api-client': 'gl-node/24 antigravity/1.104.0' },
  };
}

export function unwrapAntigravityPayload(value: Record<string, unknown>): Record<string, unknown> {
  const response = asObject(value.response);
  return response ?? value;
}

function extractProject(value: unknown): string | undefined {
  const data = asObject(value);
  const response = asObject(data?.response);
  for (const source of [data, response]) {
    if (!source) continue;
    for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
      const candidate = source[key];
      if (typeof candidate === 'string' && candidate) return candidate;
      const nested = asObject(candidate);
      if (typeof nested?.id === 'string' && nested.id) return nested.id;
    }
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export const __testOnly = { extractProject };
