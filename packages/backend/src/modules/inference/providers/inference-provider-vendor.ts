import { InferenceProviderRegistry } from './inference-provider.registry.js';

const VENDOR_BY_FAMILY: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  kimi: 'Moonshot',
};

const VENDOR_BY_PROVIDER: Record<string, string> = {
  xai: 'xAI',
  'xai-apikey': 'xAI',
  'kimi-code': 'Moonshot',
  'github-copilot': 'GitHub Copilot',
  'azure-openai': 'Azure OpenAI',
};

const registry = new InferenceProviderRegistry();

/**
 * The company a user would name for a provider connection ("Anthropic" for a Claude subscription), used in
 * error messages. Custom endpoints fall back to their catalog label.
 */
export function inferenceProviderVendorName(providerId: string | null | undefined): string | undefined {
  if (!providerId) return undefined;
  const direct = VENDOR_BY_PROVIDER[providerId];
  if (direct) return direct;
  const definition = registry.get(providerId);
  if (!definition) return undefined;
  return VENDOR_BY_FAMILY[definition.family] ?? (providerId === 'openai-compatible' ? undefined : definition.label);
}
