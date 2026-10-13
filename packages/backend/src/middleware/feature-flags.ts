import type { MiddlewareHandler } from 'hono';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { type GeneralFeatureSettings, GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { AppEnv } from '@/types.js';

export function requireOpfieldFeature(feature: keyof GeneralFeatureSettings, label: string): MiddlewareHandler<AppEnv> {
  return async (_c, next) => {
    const settings = container.resolve(GeneralSettingsService);
    if (!(await settings.isFeatureEnabled(feature))) {
      throw new AppError(403, 'FEATURE_DISABLED', `${label} feature is disabled`);
    }
    await next();
  };
}
