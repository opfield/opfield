import { describe, expect, it } from 'vitest';
import { LEGACY_CORE_RELEASE_LINE } from '@/lib/legacy-compat.js';
import { chatCompletionUsage } from './inference-core-chat-usage.js';
import { coreAdmitsNativeChat, edgeChatAdmissionRequired } from './inference-core-edge-chat.js';

const openRouterKey = { providerId: 'openrouter', authType: 'api_key' };

describe('edge Chat admission', () => {
  it('admits at the edge only for cores before opfield.5', () => {
    for (const version of [
      '2.60.0-opfield.4',
      '2.60.0-thesqlabs.6',
      `2.25.0-${LEGACY_CORE_RELEASE_LINE}.27`,
      '2.60.0',
      'dev',
      null,
    ]) {
      expect(coreAdmitsNativeChat(version)).toBe(false);
      expect(edgeChatAdmissionRequired(openRouterKey, { nativeChatAdmission: coreAdmitsNativeChat(version) })).toBe(
        true
      );
    }
    for (const version of ['2.60.0-opfield.5', 'v2.60.0-opfield.6', '2.61.0-opfield.1']) {
      expect(coreAdmitsNativeChat(version)).toBe(true);
      expect(edgeChatAdmissionRequired(openRouterKey, { nativeChatAdmission: coreAdmitsNativeChat(version) })).toBe(
        false
      );
    }
  });

  it('never admits at the edge for routes the core always admits', () => {
    expect(
      edgeChatAdmissionRequired({ providerId: 'openrouter', authType: 'oauth' }, { nativeChatAdmission: false })
    ).toBe(false);
    expect(edgeChatAdmissionRequired({ providerId: 'openai', authType: 'oauth' }, { nativeChatAdmission: false })).toBe(
      false
    );
  });
});

describe('chatCompletionUsage', () => {
  it('splits cache reads, cache writes and reasoning out of the Chat totals', () => {
    expect(
      chatCompletionUsage({
        prompt_tokens: 100,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 15 },
      })
    ).toEqual({
      uncachedInputTokens: 50,
      cachedInputTokens: 30,
      cacheWriteTokens: 20,
      outputTokens: 25,
      reasoningTokens: 15,
    });
    expect(
      chatCompletionUsage({
        prompt_tokens: 100,
        completion_tokens: 40,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 20,
      })
    ).toEqual({
      uncachedInputTokens: 50,
      cachedInputTokens: 30,
      cacheWriteTokens: 20,
      outputTokens: 40,
      reasoningTokens: 0,
    });
  });
});
