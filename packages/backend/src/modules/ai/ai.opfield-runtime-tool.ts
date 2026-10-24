import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { readSystemConfigView } from '@/modules/system/system-config-view.js';
import { UpdateService } from '@/services/update.service.js';
import type { User } from '@/types.js';
import { AISandboxService } from './ai.sandbox.service.js';
import type { AIToolDefinition } from './ai.types.js';
import { readAIStatusForUser } from './ai-status-view.js';

export const OPFIELD_RUNTIME_TOOL_NAMES = new Set(['get_opfield_runtime']);

/**
 * What the console reads for every signed-in user, with the same scopes as the REST routes: no admin:update,
 * settings:opfield:view or feat:ai:configure (those tools return more and stay as they are).
 */
export const OPFIELD_RUNTIME_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'get_opfield_runtime',
    description:
      'Read what any signed-in user may read about this Opfield, as the console does. version: the running Opfield version and the cached update status (GET /api/system/version). config: upload limits and the effective feature switches; a switch the license plan does not include reads off, and node and relay addresses are filled in only with settings:opfield:view (GET /api/system/config). ai_status: whether the AI assistant is available to you and the models you may pick (GET /api/ai/status). sandbox_status: the AI sandbox runner state; needs ai:sandbox:use (GET /api/ai/sandbox/status). Settings themselves: get_opfield_settings, get_ai_settings, get_sandbox_runtime_status; updates: manage_system_updates.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['version', 'config', 'ai_status', 'sandbox_status'] },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: false,
    category: 'Maintenance',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
];

export async function executeOpfieldRuntimeTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  switch (args.operation) {
    case 'version':
      return container.resolve(UpdateService).getCachedStatus();
    case 'config':
      return readSystemConfigView(user.scopes);
    case 'ai_status':
      return readAIStatusForUser(user);
    case 'sandbox_status': {
      if (!hasScope(user.scopes, 'ai:sandbox:use')) {
        throw new AppError(403, 'FORBIDDEN', 'Missing required scope: ai:sandbox:use');
      }
      const status = container.resolve(AISandboxService).status();
      return { ...status, state: status.status };
    }
    default:
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Unsupported get_opfield_runtime operation: ${String(args.operation)}`
      );
  }
}
