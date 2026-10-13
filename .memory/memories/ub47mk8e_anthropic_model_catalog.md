---
{
  "id": "ub47mk8e",
  "file_name": "ub47mk8e_anthropic_model_catalog",
  "tags": [
    "anthropic",
    "backend",
    "inference",
    "model-catalog"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1790152704389,
  "updated_at": 1791851879183
}
---
Opfield's "Add inference model" dialog fills Display name, context window, max input/output tokens, modalities, capabilities, reasoning efforts, pricing and the Auto-compaction limit from the known catalog in packages/backend/src/modules/inference/providers/inference-provider-model-catalog.ts.

- ANTHROPIC_MODELS (shared by providerId 'anthropic' and 'anthropic-apikey') maps an upstream model id to claudeModel(displayName, maxInputTokens, maxOutputTokens, inputPrice, outputPrice, cachedInputPrice = inputPrice * 0.1). claudeModel derives autoCompactTokenLimit via compactLimit(maxInputTokens) and sets capabilities { reasoning, tools, vision } = true.
- When a model id is absent from the catalog, discovery-only metadata leaves the dialog showing "REASONING/TOOLS/VISION UNAVAILABLE" and "Auto-compaction limit: Not reported by the provider; enter a value to continue", which blocks Add model. Adding the catalog row is enough to unblock it.
- knownProviderModel() lowercases the id and also tries an undated key by stripping a trailing -YYYY-MM-DD or -NNNN, so a version-suffixed id such as claude-opus-5-5 needs its own exact key.
- Anthropic adaptive-thinking detection in inference-provider-wire.ts uses the regex /claude-(?:fable|mythos|sonnet|opus)-5(?:\b|-)/, and model-scoped quota families in inference-core/inference-core-provider-map.ts match on the family substring, so point releases of an existing family need no change there.
- Precedent commit: e27e8743 "fix(inference): read subscription quota per core account and know Claude 5.1".
