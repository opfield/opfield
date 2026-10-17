import { LEGACY_PROVIDER_CLIENT_ID } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import type { InferenceCredentialPayload } from './inference-provider.types.js';

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const HEADERS = {
  'Editor-Version': `${LEGACY_PROVIDER_CLIENT_ID}/1.0`,
  'Editor-Plugin-Version': `${LEGACY_PROVIDER_CLIENT_ID}/1.0`,
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': LEGACY_PROVIDER_CLIENT_ID,
  Accept: 'application/json',
};

export async function exchangeGithubCopilotCredential(
  githubAccessToken: string,
  fetcher: Fetcher = fetch
): Promise<InferenceCredentialPayload> {
  const [tokenResponse, userResponse] = await Promise.all([
    fetcher(COPILOT_TOKEN_URL, {
      headers: { ...HEADERS, Authorization: `token ${githubAccessToken}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    }),
    fetcher(GITHUB_USER_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubAccessToken}`,
        'User-Agent': LEGACY_PROVIDER_CLIENT_ID,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    }),
  ]);
  if (!tokenResponse.ok) {
    throw new AppError(
      502,
      'INFERENCE_OAUTH_EXCHANGE_FAILED',
      `GitHub Copilot token exchange failed (${tokenResponse.status})`
    );
  }
  if (!userResponse.ok) {
    throw new AppError(
      502,
      'INFERENCE_OAUTH_IDENTITY_FAILED',
      `GitHub identity lookup failed (${userResponse.status})`
    );
  }
  const token = asObject(await tokenResponse.json());
  const user = asObject(await userResponse.json());
  const accessToken = stringValue(token?.token);
  if (!accessToken)
    throw new AppError(502, 'INFERENCE_OAUTH_INVALID_RESPONSE', 'Copilot token exchange returned no token');
  const expiresAt = numberValue(token?.expires_at);
  const accountId = numberValue(user?.id)?.toString() ?? stringValue(user?.login);
  if (!accountId) throw new AppError(502, 'INFERENCE_OAUTH_IDENTITY_FAILED', 'GitHub account identity is unavailable');
  return {
    accessToken,
    refreshToken: githubAccessToken,
    expiresAt: expiresAt ? expiresAt * 1000 - 2 * 60_000 : Date.now() + 23 * 60_000,
    accountId,
    email: stringValue(user?.email)?.toLowerCase(),
    tokenType: 'copilot',
  };
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
