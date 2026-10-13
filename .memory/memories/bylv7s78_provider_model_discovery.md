---
{
  "id": "bylv7s78",
  "file_name": "bylv7s78_provider_model_discovery",
  "tags": [
    "codex-catalog",
    "inference",
    "inference-core",
    "model-discovery",
    "xai",
    "zai"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1790946941011,
  "updated_at": 1790946941011
}
---
Verified while fixing empty Z.AI and sparse xAI model lists (Opfield PR #5, inference-core PR #3):

- syncCoreConnection in inference-provider.service.ts keeps only core /api/models rows whose ids appear in the core live probe (POST /api/providers/test via coreProviderLiveModels). A probe that answers { ok: true, modelIds: [] } therefore empties a connection while syncStatus stays success. Check the probe first when a connection is healthy but lists no models. null (static_catalog/forward_auth) disables the filter.
- The core probe must parse provider-specific discovery envelopes (registry modelDiscovery envelopeKey/idField, e.g. Z.AI { models: [{ slug }] } at https://api.z.ai/api/v1/models). Opfield saves Z.AI as core-<id> with templateId zai and the legacy chat baseUrl; the core still resolves the registry discovery spec through destinationAliases.
- capabilities.tools === false makes packages/gateway-inference/src/codex-catalog.ts disable shell and apply_patch for that model in Codex. Core rows carry a capabilities list only when the upstream roster publishes one, so a missing list means unknown, not no tools.
- inheritFamilyMetadata (inference-provider.service.helpers.ts) fills modalities and reasoning levels of an id-only <family><major>.<minor> model from the newest earlier version on the same account, labelled fallback with metadata.inherited_from.
- A core registry change (new model metadata) reaches production only after an inference-core release and Opfield's core pin update.
