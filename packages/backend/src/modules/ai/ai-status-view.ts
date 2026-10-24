import { container } from '@/container.js';
import type { User } from '@/types.js';
import { AISettingsService } from './ai.settings.service.js';
import { AIProviderRuntimeService } from './ai-provider-runtime.service.js';

/**
 * GET /ai/status, also get_opfield_runtime ai_status: whether the AI assistant is available to the caller and the
 * models it may pick. Any signed-in user may read it.
 */
export async function readAIStatusForUser(user: User) {
  if (container.isRegistered(AIProviderRuntimeService)) {
    return container.resolve(AIProviderRuntimeService).statusForUser(user);
  }
  const settingsService = container.resolve(AISettingsService);
  const config = await settingsService.getConfig();
  return {
    enabled: await settingsService.isEnabled(),
    providerType: config.providerType,
    defaultModel: config.model,
    allowUserModelSelection: false,
    allowUserReasoningEffortSelection: config.allowUserReasoningEffortSelection,
    reasoningEfforts: ['default', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'default',
    supportsImages: config.supportsImages,
    models: [],
  };
}
