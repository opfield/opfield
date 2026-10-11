import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from './errors.js';
import { withFileLock as withSharedFileLock } from './file-lock.js';
import type { Fetch } from './http.js';

export interface CodexCatalogMetadata {
  etag?: string;
  catalogVersion?: string;
  lastSyncedAt: string;
  /**
   * Codex's own instructions, kept apart from the catalog: once a Gateway model prompt is
   * applied the catalog no longer holds the harness default, so it cannot be recovered from it.
   */
  harnessBaseInstructions?: CodexBaseInstructionsCatalog;
}

export interface CatalogSyncResult {
  status: 'updated' | 'unchanged' | 'stale';
  catalogVersion?: string;
  modelCount: number;
  warning?: string;
}

interface CodexCatalog {
  models: Array<Record<string, unknown>>;
}

export interface CodexBaseInstructionsCatalog {
  bySlug: Readonly<Record<string, string>>;
  fallback: string;
}

/** Standard model entry served by `GET {adapters.openai.baseUrl}/models`. */
export interface GatewayInferenceModel {
  id: string;
  display_name: string;
  context_window: number;
  max_input_tokens: number;
  max_output_tokens?: number;
  auto_compact_token_limit: number | null;
  input_modalities: string[];
  capabilities: Record<string, boolean>;
  supported_reasoning_efforts: string[];
  default_reasoning_effort: string | null;
  supported_service_tiers?: string[];
  /** Administrator-configured harness instructions for this model. */
  system_prompt?: { text: string; mode: 'append' | 'replace' };
}

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

export async function syncCodexCatalog(input: {
  modelsUrl: string;
  token: string;
  catalogFile: string;
  metadataFile: string;
  lockFile: string;
  fetch?: Fetch;
  now?: () => Date;
  baseInstructions?: CodexBaseInstructionsCatalog;
}): Promise<CatalogSyncResult> {
  return withFileLock(input.lockFile, async () => {
    const existing = await readCatalog(input.catalogFile);
    const metadata = await readMetadata(input.metadataFile);
    const url = new URL(input.modelsUrl);
    const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${input.token}` });
    if (metadata?.etag) headers.set('If-None-Match', metadata.etag);

    let response: Response;
    try {
      response = await (input.fetch ?? globalThis.fetch)(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (existing) {
        return {
          status: 'stale',
          catalogVersion: metadata?.catalogVersion,
          modelCount: visibleModelCount(existing),
          warning: 'Opfield is unavailable; retained the last-good Codex catalog.',
        };
      }
      throw new CliError('CATALOG_NETWORK_ERROR', 'Could not download the Codex model catalog.', { cause: error });
    }

    if (response.status === 304) {
      if (!existing) throw new CliError('CATALOG_MISSING', 'Opfield returned 304 but no local catalog exists.');
      return {
        status: 'unchanged',
        catalogVersion: metadata?.catalogVersion,
        modelCount: visibleModelCount(existing),
      };
    }
    if (response.status === 401) {
      throw new CliError(
        'RUNTIME_TOKEN_REVOKED',
        'The Codex runtime token is invalid or revoked. Run setup codex to issue a new token.',
        { exitCode: 2 }
      );
    }
    if (!response.ok) {
      if (existing && response.status >= 500) {
        return {
          status: 'stale',
          catalogVersion: metadata?.catalogVersion,
          modelCount: visibleModelCount(existing),
          warning: `Opfield returned HTTP ${response.status}; retained the last-good Codex catalog.`,
        };
      }
      throw new CliError('CATALOG_REQUEST_FAILED', `Opfield catalog request failed with HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new CliError('CATALOG_INVALID', 'Opfield returned invalid Codex catalog JSON.', { cause: error });
    }
    // A catalog written before model prompts existed still holds the pristine harness
    // instructions; afterwards only the metadata copy is trustworthy.
    const baseInstructions =
      input.baseInstructions ??
      harnessBaseInstructionsFromMetadata(metadata) ??
      (existing ? codexBaseInstructionsFromCatalog(existing) : null);
    if (!baseInstructions) {
      throw new CliError(
        'CODEX_BASE_INSTRUCTIONS_MISSING',
        'Codex bundled model instructions are unavailable; update or repair the Codex installation.'
      );
    }
    const catalog = codexCatalogFromModels(parseGatewayModels(payload), baseInstructions);
    const catalogVersion = stripEtag(response.headers.get('etag'));
    const now = (input.now?.() ?? new Date()).toISOString();
    await atomicJsonWrite(input.catalogFile, catalog, 0o600);
    await atomicJsonWrite(
      input.metadataFile,
      {
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
        ...(catalogVersion ? { catalogVersion } : {}),
        lastSyncedAt: now,
        harnessBaseInstructions: baseInstructions,
      } satisfies CodexCatalogMetadata,
      0o600
    );
    return { status: 'updated', catalogVersion, modelCount: visibleModelCount(catalog) };
  });
}

function parseGatewayModels(value: unknown): GatewayInferenceModel[] {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { object?: unknown }).object !== 'list' ||
    !Array.isArray((value as { data?: unknown }).data)
  ) {
    throw new CliError('CATALOG_INVALID', 'Opfield model list must contain a data array.');
  }
  const models = (value as { data: Array<Record<string, unknown>> }).data;
  if (models.length === 0) throw new CliError('CATALOG_EMPTY', 'Opfield has no models available to this user.');
  for (const model of models) {
    if (!model || typeof model !== 'object') throw new CliError('CATALOG_INVALID', 'Opfield model entry is invalid.');
    for (const key of [
      'id',
      'display_name',
      'context_window',
      'max_input_tokens',
      'auto_compact_token_limit',
      'input_modalities',
      'capabilities',
      'supported_reasoning_efforts',
      'default_reasoning_effort',
    ]) {
      if (!(key in model)) throw new CliError('CATALOG_INVALID', `Opfield model entry is missing ${key}.`);
    }
    if (typeof model.id !== 'string' || !model.id.trim()) {
      throw new CliError('CATALOG_INVALID', 'Opfield model id is invalid.');
    }
  }
  return models as unknown as GatewayInferenceModel[];
}

/**
 * Converts the standard Gateway model list into the Codex `model_catalog_json`
 * shape. This mapping used to happen server-side on the removed codex catalog
 * endpoint; the single stable /api/inference/v1 prefix serves only the
 * standard list, so the CLI performs the conversion locally.
 */
export function codexCatalogFromModels(
  models: GatewayInferenceModel[],
  baseInstructions: CodexBaseInstructionsCatalog
): CodexCatalog {
  return {
    models: models.map((model, index) => {
      const supported = model.supported_reasoning_efforts.filter((effort) => CODEX_EFFORTS.has(effort));
      const defaultEffort =
        model.default_reasoning_effort && supported.includes(model.default_reasoning_effort)
          ? model.default_reasoning_effort
          : supported[0];
      const reasoning = model.capabilities.reasoning === true && supported.length > 0;
      const fast = model.supported_service_tiers?.includes('priority') === true;
      return {
        slug: model.id,
        display_name: model.display_name,
        description: `Opfield inference model ${model.display_name}`,
        default_reasoning_level: reasoning ? defaultEffort : null,
        supported_reasoning_levels: reasoning
          ? supported.map((effort) => ({ effort, description: EFFORT_DESCRIPTIONS[effort] ?? effort }))
          : [],
        shell_type: model.capabilities.tools === false ? 'disabled' : 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: index,
        additional_speed_tiers: fast ? ['fast'] : [],
        service_tiers: fast
          ? [{ id: 'priority', name: 'Fast', description: '1.5x speed, 2x Opfield credit usage' }]
          : [],
        default_service_tier: null,
        availability_nux: null,
        upgrade: null,
        base_instructions: modelBaseInstructions(
          baseInstructions.bySlug[model.id] ?? baseInstructions.fallback,
          model.system_prompt
        ),
        model_messages: null,
        include_skills_usage_instructions: false,
        supports_reasoning_summary_parameter: reasoning,
        default_reasoning_summary: reasoning ? 'auto' : 'none',
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: model.capabilities.tools === false ? null : 'freeform',
        web_search_tool_type: 'text',
        truncation_policy: { mode: 'tokens', limit: model.auto_compact_token_limit },
        supports_parallel_tool_calls: model.capabilities.tools !== false,
        supports_image_detail_original: model.input_modalities.includes('image'),
        context_window: model.context_window,
        max_context_window: model.context_window,
        auto_compact_token_limit: model.auto_compact_token_limit,
        comp_hash: null,
        effective_context_window_percent: Math.max(
          1,
          Math.min(100, Math.floor((model.max_input_tokens / model.context_window) * 100))
        ),
        experimental_supported_tools: [],
        input_modalities: model.input_modalities.filter((value) => ['audio', 'image', 'text'].includes(value)),
        // Routed tool-capable models must use Codex's deferred code-mode catalog.
        // Advertising this as false makes the harness inline its full tool surface
        // into the first request before Gateway can route it to the real provider.
        supports_search_tool: model.capabilities.tools !== false,
        // Responses Lite is an internal Codex-backend transport. Gateway terminates
        // and re-encodes Responses requests, so advertising it makes Codex send a
        // compact tool protocol that cannot be preserved end-to-end.
        use_responses_lite: false,
        auto_review_model_override: null,
        tool_mode: model.capabilities.tools === false ? null : 'code_mode_only',
        multi_agent_version: null,
      };
    }),
  };
}

function modelBaseInstructions(harnessDefault: string, prompt: GatewayInferenceModel['system_prompt']): string {
  const text = typeof prompt?.text === 'string' ? prompt.text.trim() : '';
  if (!text) return harnessDefault;
  return prompt?.mode === 'replace' ? text : `${harnessDefault}\n\n${text}`;
}

function harnessBaseInstructionsFromMetadata(
  metadata: CodexCatalogMetadata | null
): CodexBaseInstructionsCatalog | null {
  const stored = metadata?.harnessBaseInstructions;
  if (!stored || typeof stored.fallback !== 'string' || !stored.fallback.trim()) return null;
  const bySlug: Record<string, string> = {};
  for (const [slug, value] of Object.entries(stored.bySlug ?? {})) {
    if (typeof value === 'string' && value.trim()) bySlug[slug] = value;
  }
  return { bySlug, fallback: stored.fallback };
}

export function codexBaseInstructionsFromCatalog(value: unknown): CodexBaseInstructionsCatalog {
  if (!value || typeof value !== 'object' || !Array.isArray((value as CodexCatalog).models)) {
    throw new CliError('CODEX_BUNDLED_CATALOG_INVALID', 'Codex bundled model catalog is invalid.');
  }
  const bySlug: Record<string, string> = {};
  let fallback = '';
  for (const model of (value as CodexCatalog).models) {
    const slug = typeof model.slug === 'string' ? model.slug : '';
    const instructions = typeof model.base_instructions === 'string' ? model.base_instructions : '';
    if (!instructions.trim()) continue;
    if (slug) bySlug[slug] = instructions;
    if (!fallback) fallback = instructions;
  }
  if (!fallback) {
    throw new CliError(
      'CODEX_BUNDLED_CATALOG_INVALID',
      'Codex bundled model catalog does not contain base instructions.'
    );
  }
  return { bySlug, fallback };
}

export function assertCodexCatalog(value: unknown): asserts value is CodexCatalog {
  if (!value || typeof value !== 'object' || !Array.isArray((value as CodexCatalog).models)) {
    throw new CliError('CATALOG_INVALID', 'Codex catalog must contain a models array.');
  }
  const models = (value as CodexCatalog).models;
  if (models.length === 0) throw new CliError('CATALOG_EMPTY', 'Opfield has no models available to this user.');
  for (const model of models) {
    if (!model || typeof model !== 'object') throw new CliError('CATALOG_INVALID', 'Codex catalog model is invalid.');
    for (const key of [
      'slug',
      'display_name',
      'description',
      'visibility',
      'supported_in_api',
      'base_instructions',
      'context_window',
      'auto_compact_token_limit',
      'input_modalities',
      'supported_reasoning_levels',
    ]) {
      if (!(key in model)) throw new CliError('CATALOG_INVALID', `Codex catalog model is missing ${key}.`);
    }
    if (typeof model.slug !== 'string' || !model.slug.trim()) {
      throw new CliError('CATALOG_INVALID', 'Codex catalog model slug is invalid.');
    }
    if (
      'web_search_tool_type' in model &&
      model.web_search_tool_type !== 'text' &&
      model.web_search_tool_type !== 'text_and_image'
    ) {
      throw new CliError('CATALOG_INVALID', 'Codex catalog model web_search_tool_type is invalid.');
    }
    for (const key of ['supports_search_tool', 'use_responses_lite']) {
      if (key in model && typeof model[key] !== 'boolean') {
        throw new CliError('CATALOG_INVALID', `Codex catalog model ${key} is invalid.`);
      }
    }
  }
  if (visibleModelCount(value as CodexCatalog) === 0) {
    throw new CliError('CATALOG_EMPTY', 'Opfield catalog has no visible API models.');
  }
}

export async function readCatalog(file: string): Promise<CodexCatalog | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    assertCodexCatalog(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof CliError) throw error;
    throw new CliError('CATALOG_INVALID', `Local Codex catalog is unreadable: ${file}`, { cause: error });
  }
}

export async function readVisibleCatalogModels(file: string): Promise<string[]> {
  const catalog = await readCatalog(file);
  if (!catalog) return [];
  return catalog.models
    .filter((model) => model.visibility === 'list' && model.supported_in_api === true)
    .map((model) => String(model.slug))
    .sort((left, right) => left.localeCompare(right));
}

export async function readCatalogMetadata(file: string): Promise<CodexCatalogMetadata | null> {
  return readMetadata(file);
}

async function readMetadata(file: string): Promise<CodexCatalogMetadata | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CodexCatalogMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function visibleModelCount(catalog: CodexCatalog): number {
  return catalog.models.filter((model) => model.visibility === 'list' && model.supported_in_api === true).length;
}

function stripEtag(etag: string | null): string | undefined {
  return etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined;
}

async function atomicJsonWrite(file: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporary, mode);
  await rename(temporary, file);
  await chmod(file, mode);
}

export async function withFileLock<T>(lockFile: string, operation: () => Promise<T>): Promise<T> {
  return withSharedFileLock(lockFile, operation, 'CATALOG_LOCKED');
}
