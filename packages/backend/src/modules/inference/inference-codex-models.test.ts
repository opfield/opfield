import { describe, expect, it } from 'vitest';
import { type CodexCatalogModel, codexModelsResponse } from './inference-codex-models.js';

const model: CodexCatalogModel = {
  id: 'claude-work',
  display_name: 'Claude Work',
  context_window: 1_000_000,
  max_input_tokens: 950_000,
  auto_compact_token_limit: 800_000,
  input_modalities: ['text', 'image', 'pdf'],
  capabilities: { reasoning: true, tools: true },
  supported_reasoning_efforts: ['low', 'high', 'imaginary'],
  default_reasoning_effort: 'high',
  supported_service_tiers: [],
  upstreamModelIds: ['claude-opus-5-5'],
};
const upstream = {
  slug: 'gpt-5.6-sol',
  shell_type: 'unified_exec',
  tool_mode: 'code_mode_only',
  use_responses_lite: true,
  minimal_client_version: '0.142.2',
  available_in_plans: ['pro'],
  upgrade: { model: 'later' },
  model_messages: { instructions_template: 'Provider instructions', approvals: {} },
  base_instructions: 'Provider instructions',
  supported_reasoning_levels: [{ effort: 'low', description: 'Provider words' }],
  truncation_policy: { mode: 'tokens', limit: 10_000 },
};
const gpt = { ...model, id: 'work-gpt', upstreamModelIds: ['gpt-5.6-sol'], supported_reasoning_efforts: ['low'] };

describe('codexModelsResponse', () => {
  it('describes a model with no provider entry from what Opfield knows', () => {
    const [entry] = codexModelsResponse([model], [], '0.162.1').models;
    for (const field of ['slug', 'display_name', 'supported_reasoning_levels', 'shell_type', 'visibility']) {
      expect(entry).toHaveProperty(field);
    }
    expect(entry).toMatchObject({
      slug: 'claude-work',
      priority: 0,
      supported_in_api: true,
      support_verbosity: false,
      experimental_supported_tools: [],
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      default_reasoning_level: 'high',
      input_modalities: ['text', 'image'],
      use_responses_lite: false,
      effective_context_window_percent: 95,
    });
    expect(entry?.supported_reasoning_levels.map((level) => level.effort)).toEqual(['low', 'high']);
    expect(entry?.base_instructions).toBeTruthy();
  });

  it('keeps provider instructions and tool settings but publishes Opfield identity and access', () => {
    const [entry] = codexModelsResponse([gpt], [upstream], '0.162.1').models;
    expect(entry).toMatchObject({
      slug: 'work-gpt',
      shell_type: 'unified_exec',
      tool_mode: 'code_mode_only',
      use_responses_lite: false,
      upgrade: null,
      service_tiers: [],
      base_instructions: 'Provider instructions',
      supported_reasoning_levels: [{ effort: 'low', description: 'Provider words' }],
    });
    expect(entry).not.toHaveProperty('minimal_client_version');
    expect(entry).not.toHaveProperty('available_in_plans');
  });

  it('leaves out a model the provider refuses for this client version, and keeps the order gap free', () => {
    const models = [gpt, model];
    expect(
      codexModelsResponse(models, [upstream], '0.142.1').models.map(({ slug, priority }) => [slug, priority])
    ).toEqual([['claude-work', 0]]);
    expect(codexModelsResponse(models, [upstream], '0.142.2').models).toHaveLength(2);
    expect(codexModelsResponse(models, [upstream], undefined).models).toHaveLength(2);
  });

  it('lets Codex load tools on demand on every model with tools, with or without a provider entry', () => {
    const glm = { ...model, id: 'glm', upstreamModelIds: ['glm-5.3'] };
    expect(codexModelsResponse([glm], [], undefined).models[0]).toMatchObject({ supports_search_tool: true });
    expect(codexModelsResponse([gpt], [upstream], undefined).models[0]).toMatchObject({ supports_search_tool: true });
    const noTools = { ...model, capabilities: { tools: false } };
    expect(codexModelsResponse([noTools], [], undefined).models[0]).toMatchObject({ supports_search_tool: false });
  });

  it('turns tools off for a model without them, whatever the provider entry says', () => {
    const [entry] = codexModelsResponse([{ ...gpt, capabilities: { tools: false } }], [upstream], undefined).models;
    expect(entry).toMatchObject({ shell_type: 'disabled', apply_patch_tool_type: null, tool_mode: null });
    expect(entry?.supported_reasoning_levels).toEqual([]);
  });

  it('applies the system prompt to both instruction fields', () => {
    const append = { ...gpt, system_prompt: { text: 'House rules', mode: 'append' as const } };
    expect(codexModelsResponse([append], [upstream], undefined).models[0]).toMatchObject({
      base_instructions: 'Provider instructions\n\nHouse rules',
      model_messages: { instructions_template: 'Provider instructions\n\nHouse rules' },
    });
    const replace = { ...model, system_prompt: { text: 'Only this', mode: 'replace' as const } };
    expect(codexModelsResponse([replace], [], undefined).models[0]?.base_instructions).toBe('Only this');
  });
});
