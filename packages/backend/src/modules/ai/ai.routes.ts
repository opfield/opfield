import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScope, sessionOnly } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import { aiStatusRoute, getAiConfigRoute, listAiToolsRoute, updateAiConfigRoute } from './ai.openapi.js';
import { AISandboxService } from './ai.sandbox.service.js';
import { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import {
  AIConfigUpdateSchema,
  AIContextEstimateRequestSchema,
  AIUserSkillCreateSchema,
  AIUserSkillUpdateSchema,
  PageContextSchema,
} from './ai.schemas.js';
import { AIService } from './ai.service.js';
import { AISettingsService } from './ai.settings.service.js';
import { AISkillService } from './ai.skills.js';
import { AI_TOOLS } from './ai.tools.js';
import { AIConversationService, isConversationMessageId } from './ai-conversation.service.js';
import { AIConversationFolderService } from './ai-conversation-folder.service.js';
import { AIProviderRuntimeService } from './ai-provider-runtime.service.js';
import { AIRunService } from './ai-run.service.js';

export const aiRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function promptAuditSummary(prompt: string): { hash: string; length: number; empty: boolean } {
  return {
    hash: hashPrompt(prompt),
    length: prompt.length,
    empty: prompt.trim().length === 0,
  };
}

function skillAuditSummary(skill: { name: string; description: string; instructions: string; enabled: boolean }) {
  return {
    name: skill.name,
    enabled: skill.enabled,
    description: promptAuditSummary(skill.description),
    instructions: promptAuditSummary(skill.instructions),
  };
}

function changedConfigFields(config: Record<string, unknown>): string[] {
  return Object.keys(config).sort();
}

function humanizeToolName(name: string): string {
  const acronyms = new Set(['ai', 'api', 'ca', 'crl', 'dns', 'http', 'https', 'id', 'ip', 'pki', 'ssl', 'url']);
  return name
    .split('_')
    .map((part) => (acronyms.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function toolSubject(name: string): string {
  return humanizeToolName(
    name.replace(
      /^(list|get|create|update|delete|remove|manage|query|run|scan|reveal|test|pull|start|stop|restart|inspect)_/,
      ''
    )
  ).toLowerCase();
}

function userFacingToolDescription(name: string, category: string, destructive: boolean): string {
  if (name === 'discover_tools') return 'Find available Opfield tool groups and capabilities.';
  if (name === 'read_skill') return 'Read one available skill without activating it.';
  if (name === 'activate_skill') return 'Activate one available skill until the next context compaction.';
  if (name === 'get_current_context') return 'Read the page and resource currently open in the UI.';
  if (name === 'end_conversation') return 'Close the current assistant conversation with a reason.';
  if (name === 'find_resource') return 'Search Opfield resources by name, type, or identifier.';
  if (name === 'search_chats') return 'Search previous AI chats for relevant context.';
  if (name === 'search_compacted_history') return 'Search exact details from compacted history in the current chat.';
  if (name === 'find_in_chat') return 'Search within a specific previous AI chat.';
  if (name === 'read_chat_slice') return 'Read a bounded slice of messages from a previous AI chat.';
  if (name === 'list_chat_projects') return 'List AI chat projects available as retrieval boundaries.';
  if (name === 'internal_documentation') return 'Search the assistant documentation for Opfield operations.';
  if (name === 'wait') return 'Pause briefly before checking an operation again.';
  if (name === 'web_search') return 'Search the web when current external information is needed.';

  const subject = toolSubject(name);
  if (name.startsWith('list_')) return `View ${subject} records.`;
  if (name.startsWith('get_') || name.startsWith('inspect_')) return `View details for ${subject}.`;
  if (name.startsWith('create_')) return `Create ${subject}.`;
  if (name.startsWith('update_') || name.startsWith('manage_')) return `Change ${subject}.`;
  if (name.startsWith('delete_') || name.startsWith('remove_')) return `Delete ${subject}.`;
  if (name.startsWith('query_') || name.startsWith('run_') || name.startsWith('scan_')) return `Run ${subject}.`;
  if (name.startsWith('pull_')) return `Pull ${subject}.`;
  if (name.startsWith('start_')) return `Start ${subject}.`;
  if (name.startsWith('stop_')) return `Stop ${subject}.`;
  if (name.startsWith('restart_')) return `Restart ${subject}.`;
  if (name.startsWith('reveal_')) return `Reveal ${subject}.`;
  if (name.startsWith('test_')) return `Test ${subject}.`;

  return `${destructive ? 'Change' : 'Use'} ${category.toLowerCase()} capabilities.`;
}

const CreateAIConversationFolderSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
});

const UpdateAIConversationFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'name or description is required',
  });

const ReorderAIConversationFoldersSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      sortOrder: z.number().int().min(0),
    })
  ),
});

const MoveAIConversationsToFolderSchema = z.object({
  conversationIds: z.array(z.string().uuid()).min(1),
  folderId: z.string().uuid().nullable(),
});

const UpdateAIConversationSchema = z.object({
  title: z.string().trim().min(1).max(255),
});

const UpdateAIConversationProviderSchema = z.object({
  model: z.string().trim().min(1).max(255),
  reasoningEffort: z.string().trim().min(1).max(64).nullable(),
});

aiRoutes.use('*', authMiddleware);
aiRoutes.use('*', sessionOnly);

// GET /api/ai/status — check if AI features are enabled (any authenticated user)
aiRoutes.openapi(aiStatusRoute, async (c) => {
  if (container.isRegistered(AIProviderRuntimeService)) {
    return c.json(await container.resolve(AIProviderRuntimeService).statusForUser(c.get('user')!));
  }
  const settingsService = container.resolve(AISettingsService);
  const config = await settingsService.getConfig();
  return c.json({
    enabled: await settingsService.isEnabled(),
    providerType: config.providerType,
    defaultModel: config.model,
    allowUserModelSelection: false,
    allowUserReasoningEffortSelection: config.allowUserReasoningEffortSelection,
    reasoningEfforts: ['default', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'default',
    supportsImages: config.supportsImages,
    models: [],
  });
});

aiRoutes.get('/conversations', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AIConversationService);
  const user = c.get('user')!;
  const data = await service.listConversations(user.id);
  return c.json({ data });
});

// Scenario catalogue for the full AI Workspace start screen. The server owns
// visibility so a card is never an alternate way around a permission check.
aiRoutes.get('/scenarios', requireScope('ai:workspace:use'), async (c) => {
  const rawContext = c.req.query('context');
  let parsed: ReturnType<typeof PageContextSchema.safeParse> | null = null;
  if (rawContext) {
    try {
      parsed = PageContextSchema.safeParse(JSON.parse(rawContext));
    } catch {
      return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid page context' }, 400);
    }
  }
  if (rawContext && !parsed?.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Invalid page context' }, 400);
  }
  const available = container.isRegistered(TOKENS.CommercialEdition)
    ? await container
        .resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition)
        .listAIScenarios(c.get('user')!, parsed?.data)
    : [];
  const scenarios = available.map(
    ({ kickoffInstruction: _kickoffInstruction, requiredAnyScopes: _requiredAnyScopes, ...scenario }) => scenario
  );
  return c.json({ data: scenarios });
});

aiRoutes.get('/conversation-folders', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AIConversationFolderService);
  const user = c.get('user')!;
  const data = await service.listFolders(user.id);
  return c.json({ data });
});

aiRoutes.post('/conversation-folders', requireScope('ai:workspace:use'), async (c) => {
  const parsed = CreateAIConversationFolderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);

  const service = container.resolve(AIConversationFolderService);
  const user = c.get('user')!;
  const data = await service.createFolder(user.id, parsed.data);
  return c.json({ data }, 201);
});

aiRoutes.patch('/conversation-folders/:id', requireScope('ai:workspace:use'), async (c) => {
  const parsed = UpdateAIConversationFolderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);

  const service = container.resolve(AIConversationFolderService);
  const user = c.get('user')!;
  const data = await service.updateFolder(user.id, c.req.param('id'), parsed.data);
  return c.json({ data });
});

aiRoutes.delete('/conversation-folders/:id', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AIConversationFolderService);
  const user = c.get('user')!;
  await service.deleteFolder(user.id, c.req.param('id'));
  return c.json({ data: { deleted: true } });
});

aiRoutes.put('/conversation-folders/reorder', requireScope('ai:workspace:use'), async (c) => {
  const parsed = ReorderAIConversationFoldersSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);

  const service = container.resolve(AIConversationFolderService);
  const user = c.get('user')!;
  const data = await service.reorderFolders(user.id, parsed.data);
  return c.json({ data });
});

aiRoutes.put('/conversation-folders/move-conversations', requireScope('ai:workspace:use'), async (c) => {
  const parsed = MoveAIConversationsToFolderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);

  const service = container.resolve(AIConversationFolderService);
  const user = c.get('user')!;
  const data = await service.moveConversationsToFolder(user.id, parsed.data);
  return c.json({ data });
});

aiRoutes.get('/conversations/:id', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AIConversationService);
  const user = c.get('user')!;
  const data = await service.getConversation(user.id, c.req.param('id'));
  if (!data) return c.json({ code: 'NOT_FOUND', message: 'Conversation not found' }, 404);
  return c.json({ data });
});

aiRoutes.patch('/conversations/:id', requireScope('ai:workspace:use'), async (c) => {
  const parsed = UpdateAIConversationSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);

  const service = container.resolve(AIConversationService);
  const user = c.get('user')!;
  const data = await service.renameConversation(user.id, c.req.param('id'), parsed.data.title);
  if (!data) return c.json({ code: 'NOT_FOUND', message: 'Conversation not found' }, 404);
  return c.json({ data });
});

aiRoutes.patch('/conversations/:id/provider', requireScope('ai:workspace:use'), async (c) => {
  const parsed = UpdateAIConversationProviderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);

  const user = c.get('user')!;
  const conversationService = container.resolve(AIConversationService);
  const conversation = await conversationService.getConversation(user.id, c.req.param('id'));
  if (!conversation) return c.json({ code: 'NOT_FOUND', message: 'Conversation not found' }, 404);

  const status = await container.resolve(AIProviderRuntimeService).statusForUser(user);
  if (status.providerType === 'openai_compatible') {
    if (!status.allowUserReasoningEffortSelection) {
      return c.json(
        { code: 'AI_REASONING_EFFORT_SELECTION_DISABLED', message: 'Reasoning effort selection is disabled' },
        403
      );
    }
    if (parsed.data.reasoningEffort && !status.reasoningEfforts.includes(parsed.data.reasoningEffort)) {
      return c.json(
        {
          code: 'AI_REASONING_EFFORT_UNAVAILABLE',
          message: 'The selected reasoning effort is unavailable for this provider',
        },
        400
      );
    }
    await container.resolve(AIRunService).updateConversationProvider({
      userId: user.id,
      conversationId: conversation.id,
      model: status.defaultModel,
      reasoningEffort: parsed.data.reasoningEffort,
      modelDisplayName: status.defaultModel,
      previousModelDisplayName: conversation.model ?? undefined,
    });
    const data = await conversationService.getConversation(user.id, conversation.id);
    return c.json({ data });
  }
  const model = status.models.find((candidate) => candidate.id === parsed.data.model);
  if (!model) return c.json({ code: 'AI_MODEL_UNAVAILABLE', message: 'The selected model is unavailable' }, 404);
  const modelAllowedWithoutSelection = model.id === status.defaultModel || conversation.model === model.id;
  if (!status.allowUserModelSelection && !modelAllowedWithoutSelection) {
    return c.json({ code: 'AI_MODEL_SELECTION_DISABLED', message: 'AI model selection is disabled' }, 403);
  }
  if (parsed.data.reasoningEffort && !model.reasoningEfforts.includes(parsed.data.reasoningEffort)) {
    return c.json(
      {
        code: 'AI_REASONING_EFFORT_UNAVAILABLE',
        message: 'The selected reasoning effort is unavailable for this model',
      },
      400
    );
  }

  const previousModel = status.models.find((candidate) => candidate.id === conversation.model);
  await container.resolve(AIRunService).updateConversationProvider({
    userId: user.id,
    conversationId: conversation.id,
    model: model.id,
    reasoningEffort: parsed.data.reasoningEffort,
    modelDisplayName: model.displayName,
    previousModelDisplayName: previousModel?.displayName,
  });
  const data = await conversationService.getConversation(user.id, conversation.id);
  return c.json({ data });
});

aiRoutes.delete('/conversations/:id', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AIConversationService);
  const user = c.get('user')!;
  const deleted = await service.deleteConversation(user.id, c.req.param('id'));
  if (!deleted) return c.json({ code: 'NOT_FOUND', message: 'Conversation not found' }, 404);
  return c.json({ data: { deleted: true } });
});

aiRoutes.post('/conversations/:id/rollback', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AIConversationService);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  if (!messageId) return c.json({ code: 'VALIDATION_ERROR', message: 'messageId is required' }, 400);
  if (!isConversationMessageId(messageId)) {
    return c.json({ code: 'NOT_FOUND', message: 'This message is not saved yet. Try again in a moment.' }, 404);
  }

  const runService = container.resolve(AIRunService);
  await runService.stopActiveRunForRollback({ conversationId: c.req.param('id'), userId: user.id });

  const result = await service.rollbackToMessage(user.id, c.req.param('id'), messageId);
  if (!result) return c.json({ code: 'NOT_FOUND', message: 'Conversation message not found' }, 404);
  return c.json({ data: result });
});

aiRoutes.post('/context-estimate', requireScope('ai:workspace:use'), async (c) => {
  const parsed = AIContextEstimateRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: 'VALIDATION_ERROR', message: parsed.error.message }, 400);

  const service = container.resolve(AIService);
  const user = c.get('user')!;
  const data = await service.getContextEstimate(
    user,
    parsed.data.context,
    parsed.data.conversationId ?? undefined,
    parsed.data.model,
    parsed.data.reasoningEffort,
    parsed.data.messages
  );
  return c.json({ data });
});

// GET /api/ai/config — full config for admin display (admin only)
aiRoutes.openapi({ ...getAiConfigRoute, middleware: requireScope('feat:ai:configure') }, async (c) => {
  const settingsService = container.resolve(AISettingsService);
  const [config, opfieldInferenceModels] = await Promise.all([
    settingsService.getConfigForAdmin(),
    container.isRegistered(AIProviderRuntimeService)
      ? container.resolve(AIProviderRuntimeService).adminModels()
      : Promise.resolve([]),
  ]);
  return c.json({ data: { ...config, opfieldInferenceModels } });
});

// PUT /api/ai/config — update config (admin only)
aiRoutes.openapi({ ...updateAiConfigRoute, middleware: requireScope('feat:ai:configure') }, async (c) => {
  const body = AIConfigUpdateSchema.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: body.error.message }, 400);
  }

  const settingsService = container.resolve(AISettingsService);
  const oldCustomSystemPrompt = Object.hasOwn(body.data, 'customSystemPrompt')
    ? (await settingsService.getConfig()).customSystemPrompt
    : undefined;
  await settingsService.updateConfig(body.data);
  const [config, opfieldInferenceModels] = await Promise.all([
    settingsService.getConfigForAdmin(),
    container.isRegistered(AIProviderRuntimeService)
      ? container.resolve(AIProviderRuntimeService).adminModels()
      : Promise.resolve([]),
  ]);
  if (oldCustomSystemPrompt !== undefined && oldCustomSystemPrompt !== config.customSystemPrompt) {
    const user = c.get('user')!;
    const auditService = container.resolve(AuditService);
    const genericAuditEmitted = await auditService.log({
      userId: user.id,
      action: 'ai.config.update',
      resourceType: 'ai-config',
      details: {
        changedFields: changedConfigFields(body.data),
        customSystemPromptChanged: true,
      },
    });
    const promptAuditEntry = {
      userId: user.id,
      action: 'ai.config.prompt.update',
      resourceType: 'ai-config',
      details: {
        old: promptAuditSummary(oldCustomSystemPrompt),
        new: promptAuditSummary(config.customSystemPrompt),
      },
    };
    if (genericAuditEmitted) {
      await auditService.log(promptAuditEntry);
    } else {
      await auditService.log(promptAuditEntry, { markRequest: false });
    }
  }
  return c.json({ data: { ...config, opfieldInferenceModels } });
});

// AI skills are shared installation-wide. Settings readers may inspect them;
// a dedicated scope gates every user-skill mutation.
aiRoutes.get('/skills', requireScope('feat:ai:configure'), async (c) => {
  const skills = new AISkillService(container.resolve(AISettingsService));
  return c.json({ data: await skills.listAllForSettings() });
});

aiRoutes.post('/skills', requireScope('ai:skills:manage'), async (c) => {
  const body = AIUserSkillCreateSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ code: 'VALIDATION_ERROR', message: body.error.message }, 400);
  const skill = await new AISkillService(container.resolve(AISettingsService)).create(body.data);
  const user = c.get('user')!;
  await container.resolve(AuditService).log({
    userId: user.id,
    action: 'ai.skill.create',
    resourceType: 'ai-skill',
    resourceId: skill.id,
    details: skillAuditSummary(skill),
  });
  return c.json({ data: skill }, 201);
});

aiRoutes.patch('/skills/:id', requireScope('ai:skills:manage'), async (c) => {
  const body = AIUserSkillUpdateSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ code: 'VALIDATION_ERROR', message: body.error.message }, 400);
  const skill = await new AISkillService(container.resolve(AISettingsService)).update(c.req.param('id'), body.data);
  const user = c.get('user')!;
  await container.resolve(AuditService).log({
    userId: user.id,
    action: 'ai.skill.update',
    resourceType: 'ai-skill',
    resourceId: skill.id,
    details: { changedFields: Object.keys(body.data).sort(), ...skillAuditSummary(skill) },
  });
  return c.json({ data: skill });
});

aiRoutes.delete('/skills/:id', requireScope('ai:skills:manage'), async (c) => {
  const skill = await new AISkillService(container.resolve(AISettingsService)).delete(c.req.param('id'));
  const user = c.get('user')!;
  await container.resolve(AuditService).log({
    userId: user.id,
    action: 'ai.skill.delete',
    resourceType: 'ai-skill',
    resourceId: skill.id,
    details: skillAuditSummary(skill),
  });
  return c.json({ data: { id: skill.id } });
});

// GET /api/ai/tools — list all tool definitions grouped by category (admin only)
aiRoutes.openapi({ ...listAiToolsRoute, middleware: requireScope('feat:ai:configure') }, async (c) => {
  const grouped: Record<
    string,
    Array<{
      name: string;
      displayName: string;
      displayDescription: string;
      destructive: boolean;
      requiredScope: string;
    }>
  > = {};

  for (const tool of AI_TOOLS) {
    if (!grouped[tool.category]) grouped[tool.category] = [];
    grouped[tool.category].push({
      name: tool.name,
      displayName: humanizeToolName(tool.name),
      displayDescription: userFacingToolDescription(tool.name, tool.category, tool.destructive),
      destructive: tool.destructive,
      requiredScope: tool.requiredScope,
    });
  }

  return c.json({ data: grouped });
});

aiRoutes.get('/sandbox/status', requireScope('ai:sandbox:use'), async (c) => {
  const service = container.resolve(AISandboxService);
  const status = service.status();
  return c.json({ data: { ...status, state: status.status } });
});

aiRoutes.get('/sandbox/jobs', requireScope('ai:sandbox:use'), async (c) => {
  const service = container.resolve(AISandboxService);
  const user = c.get('user')!;
  const activeOnly = c.req.query('activeOnly') === 'true';
  const statusRaw = c.req.query('status');
  const status =
    statusRaw &&
    ['queued', 'running', 'exited', 'killed', 'timeout', 'failed', 'revoked', 'expired'].includes(statusRaw)
      ? statusRaw
      : undefined;
  const limitRaw = Number(c.req.query('limit') ?? 50);
  const data = await service.listJobs(user, {
    activeOnly,
    status,
    limit: Number.isFinite(limitRaw) ? limitRaw : 50,
  });
  return c.json({ data });
});

aiRoutes.post('/sandbox/jobs/:id/kill', requireScope('ai:sandbox:use'), async (c) => {
  const service = container.resolve(AISandboxService);
  const user = c.get('user')!;
  const data = await service.killProcess(user, c.req.param('id'));
  return c.json({ data });
});

aiRoutes.get('/sandbox/jobs/:id/output', requireScope('ai:sandbox:use'), async (c) => {
  const service = container.resolve(AISandboxService);
  const user = c.get('user')!;
  const tailRaw = Number(c.req.query('tail') ?? 200);
  const data = await service.readProcessOutput(user, c.req.param('id'), Number.isFinite(tailRaw) ? tailRaw : 200);
  return c.json({ data });
});

const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

aiRoutes.post('/sandbox/artifacts', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AISandboxArtifactService);
  const user = c.get('user')!;
  const body = await c.req.parseBody();
  const file = body.file;
  const conversationId = typeof body.conversationId === 'string' && body.conversationId ? body.conversationId : null;
  if (!(file instanceof File)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Image file is required' }, 400);
  }
  if (!file.type.startsWith('image/')) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Only image attachments are supported' }, 400);
  }
  if (file.size > MAX_CHAT_IMAGE_BYTES) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Image attachment must be 10 MB or smaller' }, 400);
  }
  const artifact = await service.saveFromBuffer({
    userId: user.id,
    conversationId,
    filename: file.name || 'image',
    mediaType: file.type,
    buffer: Buffer.from(await file.arrayBuffer()),
  });
  return c.json({
    data: {
      artifactId: artifact.id,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      downloadUrl: artifact.downloadUrl,
      kind: 'image',
    },
  });
});

aiRoutes.get('/sandbox/artifacts', requireScope('ai:workspace:use'), async (c) => {
  const artifactService = container.resolve(AISandboxArtifactService);
  const conversationService = container.resolve(AIConversationService);
  const user = c.get('user')!;
  const pageRaw = Number(c.req.query('page') ?? 1);
  const limitRaw = Number(c.req.query('limit') ?? 50);
  const page = Number.isInteger(pageRaw) ? Math.max(1, pageRaw) : 1;
  const limit = Number.isInteger(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 50;
  const result = await artifactService.listPageForUser(user.id, page, limit);
  const conversationTitles = await conversationService.listConversationTitles(
    user.id,
    result.items.map((artifact) => artifact.conversationId).filter((id): id is string => Boolean(id))
  );
  return c.json({
    data: result.items.map((artifact) => ({
      ...artifact,
      conversationTitle: artifact.conversationId ? (conversationTitles[artifact.conversationId] ?? null) : null,
    })),
    nextPage: result.nextPage,
  });
});

aiRoutes.delete('/sandbox/artifacts/:id', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AISandboxArtifactService);
  const user = c.get('user')!;
  await service.delete(user.id, c.req.param('id'));
  return c.json({ data: { deleted: true } });
});

aiRoutes.get('/sandbox/artifacts/:id/download', requireScope('ai:workspace:use'), async (c) => {
  const service = container.resolve(AISandboxArtifactService);
  const user = c.get('user')!;
  const artifact = await service.getDownload(user.id, c.req.param('id'));
  c.header('Content-Type', artifact.metadata.mediaType);
  c.header('Content-Length', String(artifact.metadata.sizeBytes));
  c.header('Content-Disposition', `attachment; filename="${contentDispositionFilename(artifact.metadata.filename)}"`);
  return c.body(Readable.toWeb(createReadStream(artifact.filePath)) as ReadableStream);
});

function contentDispositionFilename(filename: string): string {
  return filename.replace(/["\r\n\\]/g, '_');
}
