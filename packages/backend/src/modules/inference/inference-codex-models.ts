/**
 * The Codex `ModelsResponse` catalog behind `model_catalog_url`, for Codex clients connected straight to Opfield.
 * Field names and required fields follow `codex-rs/protocol/src/openai_models.rs`. Listing a model here grants
 * nothing: inference requests enforce model access on their own.
 */
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('InferenceCodexModels');

const CODEX_BASE_INSTRUCTIONS = `You are Codex, a coding agent working with the user in their workspace.
Use the provided tools to inspect and modify the workspace when the task requires it. Keep tool calls and reasoning separate from the final answer, and report what you verified.`;

const CODEX_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  none: 'No additional reasoning',
  minimal: 'Minimal reasoning for straightforward tasks',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balanced speed and reasoning depth',
  high: 'Greater reasoning depth for complex tasks',
  xhigh: 'Extra high reasoning depth for complex tasks',
  max: 'Maximum provider reasoning depth',
  ultra: 'Maximum reasoning for the hardest tasks',
};
const CODEX_MODALITIES = new Set(['text', 'image', 'audio']);
/** Keeps tool output to what Codex itself keeps for OpenAI models; unrelated to the compaction limit. */
const TOOL_OUTPUT_TOKENS = 10_000;

export interface CodexCatalogModel {
  id: string;
  display_name: string;
  context_window: number;
  max_input_tokens: number;
  auto_compact_token_limit: number;
  input_modalities: string[];
  capabilities: Record<string, boolean>;
  supported_reasoning_efforts: string[];
  default_reasoning_effort: string | null;
  system_prompt?: { text: string; mode: 'append' | 'replace' };
  supported_service_tiers: string[];
  /** The ids this model routes to, to find the provider's own catalog entry. */
  upstreamModelIds: string[];
}

type UpstreamEntry = Record<string, unknown> & { slug: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `major.minor.patch` as Codex sends it, or null when a client sends none or something else. */
export function parseCodexClientVersion(value: string | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value?.trim() ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function olderThan(client: [number, number, number], minimum: [number, number, number]) {
  for (const index of [0, 1, 2] as const) {
    if (client[index] !== minimum[index]) return client[index] < minimum[index];
  }
  return false;
}

function instructions(model: CodexCatalogModel, base: string) {
  if (!model.system_prompt) return base;
  return model.system_prompt.mode === 'replace' ? model.system_prompt.text : `${base}\n\n${model.system_prompt.text}`;
}

function reasoningFields(model: CodexCatalogModel, upstream: UpstreamEntry | null) {
  const supported = model.supported_reasoning_efforts.filter((effort) => CODEX_EFFORTS.has(effort));
  const reasoning = model.capabilities.reasoning === true && supported.length > 0;
  const presets = Array.isArray(upstream?.supported_reasoning_levels) ? upstream.supported_reasoning_levels : [];
  const presetFor = (effort: string) =>
    presets.map(record).find((preset) => preset?.effort === effort)?.description ?? EFFORT_DESCRIPTIONS[effort];
  return {
    reasoning,
    default_reasoning_level: !reasoning
      ? null
      : model.default_reasoning_effort && supported.includes(model.default_reasoning_effort)
        ? model.default_reasoning_effort
        : supported[0],
    supported_reasoning_levels: reasoning
      ? supported.map((effort) => ({ effort, description: presetFor(effort) ?? effort }))
      : [],
  };
}

/** What Opfield knows and decides about a model, whichever entry it lands on. */
function publishedFields(model: CodexCatalogModel, index: number, upstream: UpstreamEntry | null) {
  const { reasoning, ...levels } = reasoningFields(model, upstream);
  const fast = model.supported_service_tiers.includes('priority');
  const tools = model.capabilities.tools !== false;
  return {
    reasoning,
    fields: {
      slug: model.id,
      display_name: model.display_name,
      description: `Opfield Inference model ${model.display_name}`,
      ...levels,
      visibility: 'list',
      supported_in_api: true,
      priority: index,
      additional_speed_tiers: fast ? ['fast'] : [],
      service_tiers: fast ? [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] : [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
      context_window: model.context_window,
      max_context_window: model.context_window,
      auto_compact_token_limit: model.auto_compact_token_limit,
      effective_context_window_percent: Math.max(
        1,
        Math.min(100, Math.floor((model.max_input_tokens / model.context_window) * 100))
      ),
      input_modalities: model.input_modalities.filter((value) => CODEX_MODALITIES.has(value)),
      supports_image_detail_original: model.input_modalities.includes('image'),
      // Responses Lite is private to the Codex backend: the compact tool protocol it switches on does not survive routing.
      use_responses_lite: false,
      ...(tools
        ? {}
        : { shell_type: 'disabled', apply_patch_tool_type: null, tool_mode: null, multi_agent_version: null }),
    },
  };
}

function ownEntry(model: CodexCatalogModel, index: number) {
  const { reasoning, fields } = publishedFields(model, index, null);
  const tools = model.capabilities.tools !== false;
  return {
    shell_type: 'shell_command',
    apply_patch_tool_type: 'freeform',
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summary_parameter: reasoning,
    default_reasoning_summary: reasoning ? 'auto' : 'none',
    support_verbosity: false,
    default_verbosity: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: TOOL_OUTPUT_TOKENS },
    comp_hash: null,
    experimental_supported_tools: [],
    supports_search_tool: tools && model.capabilities.search === true,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null,
    ...fields,
    base_instructions: instructions(model, CODEX_BASE_INSTRUCTIONS),
  };
}

/** The provider's entry keeps its instructions and tool settings; identity, limits and access come from Opfield. */
function upstreamEntry(model: CodexCatalogModel, index: number, upstream: UpstreamEntry) {
  const { minimal_client_version: _minimum, available_in_plans: _plans, ...rest } = upstream;
  const messages = record(upstream.model_messages);
  const template = messages?.instructions_template ?? upstream.base_instructions;
  const text = instructions(model, typeof template === 'string' && template ? template : CODEX_BASE_INSTRUCTIONS);
  return {
    ...rest,
    ...publishedFields(model, index, upstream).fields,
    ...(messages ? { model_messages: { ...messages, instructions_template: text } } : {}),
    base_instructions: text,
  };
}

/** Entries in `models` of the core's own catalog; a malformed one simply goes unused. */
export function codexCatalogEntries(body: unknown): UpstreamEntry[] {
  const models = record(body)?.models;
  if (!Array.isArray(models)) {
    logger.warn('Inference core returned no Codex model catalog');
    return [];
  }
  return models.filter((entry): entry is UpstreamEntry => typeof record(entry)?.slug === 'string');
}

export function codexModelsResponse(
  models: CodexCatalogModel[],
  upstream: UpstreamEntry[],
  clientVersion: string | undefined
) {
  const client = parseCodexClientVersion(clientVersion);
  const bySlug = new Map(upstream.map((entry) => [entry.slug, entry]));
  const listed: Array<ReturnType<typeof ownEntry> | ReturnType<typeof upstreamEntry>> = [];
  for (const model of models) {
    const entry = model.upstreamModelIds.map((id) => bySlug.get(id)).find(Boolean);
    const minimum = parseCodexClientVersion(
      typeof entry?.minimal_client_version === 'string' ? entry.minimal_client_version : undefined
    );
    // The provider refuses this client version for the model, so the picker must not offer it.
    if (client && minimum && olderThan(client, minimum)) continue;
    listed.push(entry ? upstreamEntry(model, listed.length, entry) : ownEntry(model, listed.length));
  }
  return { models: listed };
}
