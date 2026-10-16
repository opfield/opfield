import type {
  InferenceDiscoveredModel,
  InferenceModel,
  InferenceModelMetadataField,
  InferenceModelMetadataSource,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
  InferenceProviderModelPricing,
} from "@/types/inference";

export const CLIENT_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
] as const;

export interface ModelForm {
  publicId: string;
  displayName: string;
  subscriptionMultiplier: string;
  contextWindow: string;
  maxInputTokens: string;
  maxOutputTokens: string;
  autoCompactTokenLimit: string;
}

export interface ModelPricingForm {
  inputPrice: string;
  outputPrice: string;
  imagePrice: string;
  searchPrice: string;
  realtimePrice: string;
}

export interface ProviderModelBinding {
  connection: InferenceProviderConnection;
  model: InferenceDiscoveredModel;
}

export interface ProviderModelOption {
  key: string;
  providerId: string;
  providerLabel: string;
  remoteModelId: string;
  displayName: string;
  sourceType: "subscription" | "api";
  bindings: ProviderModelBinding[];
  totalAccounts: number;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  autoCompactTokenLimit: number | null;
  modalities: string[];
  capabilities: Record<string, boolean>;
  capabilityLimitations: Record<string, string[]>;
  reasoningEfforts: string[];
  metadataSources: Partial<Record<InferenceModelMetadataField, InferenceModelMetadataSource>>;
  pricing: InferenceProviderModelPricing | null;
}

const METADATA_FIELDS: InferenceModelMetadataField[] = [
  "displayName",
  "contextWindow",
  "maxInputTokens",
  "maxOutputTokens",
  "autoCompactTokenLimit",
  "reasoningEfforts",
  "modalities",
  "capabilities",
];

/**
 * A field is provider-reported only when every account's value came from the provider. Any
 * catalog value wins over a calculation, and any calculation wins over a live answer.
 */
function commonMetadataSources(bindings: ProviderModelBinding[]) {
  const sources: Partial<Record<InferenceModelMetadataField, InferenceModelMetadataSource>> = {};
  for (const field of METADATA_FIELDS) {
    const values = bindings.map(({ model }) => model.metadataSources?.[field]);
    if (values.includes("fallback")) sources[field] = "fallback";
    else if (
      values.length &&
      values.every((value) => value === "provider" || value === "derived")
    ) {
      sources[field] = values.includes("derived") ? "derived" : "provider";
    }
  }
  return sources;
}

export const EMPTY_MODEL_FORM: ModelForm = {
  publicId: "",
  displayName: "",
  subscriptionMultiplier: "1",
  contextWindow: "",
  maxInputTokens: "",
  maxOutputTokens: "",
  autoCompactTokenLimit: "",
};

/** Empty means no price: the model still serves requests, with tokens recorded and the cost unknown. */
export const EMPTY_MODEL_PRICING: ModelPricingForm = {
  inputPrice: "",
  outputPrice: "",
  imagePrice: "",
  searchPrice: "",
  realtimePrice: "",
};

/**
 * A public model ID suggested from a display name: only the characters the backend accepts (a-z 0-9 . _ / -), so a
 * name such as "Qwen: Qwen3.8 Max (0902)" becomes "qwen-qwen3.8-max-0902".
 */
export function publicIdFromName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._/]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 255);
}

export function providerModelKey(providerId: string, remoteModelId: string) {
  return `${providerId}:${remoteModelId}`;
}

/** Subscription providers whose live model roster reports each model's reasoning effort levels. */
const PROVIDERS_WITH_LIVE_REASONING_EFFORTS = new Set(["openai", "anthropic"]);

/**
 * A model can be offered for publishing only when every account reports the limits Opfield
 * needs to route and compact requests. On subscriptions whose live roster reports effort
 * levels, a reasoning model that only has built-in catalog levels is not offered either:
 * the provider no longer lists it with reasoning support. Other providers publish ids only,
 * so their catalog levels remain valid.
 */
export function hasRequiredModelMetadata(option: ProviderModelOption) {
  return (
    option.contextWindow != null &&
    option.maxInputTokens != null &&
    option.autoCompactTokenLimit != null &&
    !(
      PROVIDERS_WITH_LIVE_REASONING_EFFORTS.has(option.providerId) &&
      option.reasoningEfforts.length > 0 &&
      option.metadataSources.reasoningEfforts === "fallback"
    )
  );
}

export function providerModelLabels(options: ProviderModelOption[]) {
  const counts = new Map<string, number>();
  for (const option of options) {
    const key = normalizedDisplayName(option.displayName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(
    options.map((option) => {
      const duplicated = (counts.get(normalizedDisplayName(option.displayName)) ?? 0) > 1;
      return [
        option.key,
        duplicated ? `${option.displayName} · ${option.remoteModelId}` : option.displayName,
      ];
    })
  );
}

export function buildProviderModelOptions(
  connections: InferenceProviderConnection[],
  catalog: InferenceProviderCatalogItem[]
): ProviderModelOption[] {
  const providers = new Map(catalog.map((provider) => [provider.id, provider]));
  const active = connections.filter((connection) => connection.enabled);
  const apiProviderLabels = new Map(
    [...new Set(active.map((connection) => connection.providerId))].map((providerId) => [
      providerId,
      [
        ...new Set(
          active
            .filter((connection) => connection.providerId === providerId)
            .map((connection) => connection.name.trim())
            .filter(Boolean)
        ),
      ].join(", "),
    ])
  );
  const groups = new Map<string, ProviderModelBinding[]>();
  for (const connection of active) {
    for (const model of connection.discoveredModels.filter((candidate) => candidate.available)) {
      const key = providerModelKey(connection.providerId, model.remoteModelId);
      groups.set(key, [...(groups.get(key) ?? []), { connection, model }]);
    }
  }
  return [...groups.entries()]
    .map(([key, bindings]) => {
      const first = bindings[0]!;
      const provider = providers.get(first.connection.providerId);
      const totalAccounts = active.filter(
        (connection) => connection.providerId === first.connection.providerId
      ).length;
      const capabilityKeys = new Set(
        bindings.flatMap(({ model }) => Object.keys(model.capabilities))
      );
      const capabilities: Record<string, boolean> = {};
      const capabilityLimitations: Record<string, string[]> = {};
      for (const capability of [...capabilityKeys].sort()) {
        const missing = bindings.filter(({ model }) => model.capabilities[capability] !== true);
        capabilities[capability] = missing.length === 0;
        if (missing.length) {
          capabilityLimitations[capability] = missing.map(({ connection }) => connection.name);
        }
      }
      const modalities = intersect(bindings.map(({ model }) => model.modalities));
      const reasoningEfforts = intersect(bindings.map(({ model }) => model.reasoningEfforts));
      const pricing = commonPricing(bindings.map(({ model }) => model.pricing ?? null));
      return {
        key,
        providerId: first.connection.providerId,
        providerLabel: provider?.subscription
          ? provider.label
          : apiProviderLabels.get(first.connection.providerId) ||
            provider?.label ||
            first.connection.providerId,
        remoteModelId: first.model.remoteModelId,
        displayName: first.model.displayName || first.model.remoteModelId,
        sourceType: provider?.subscription ? "subscription" : "api",
        bindings,
        totalAccounts,
        contextWindow: minimum(bindings.map(({ model }) => model.contextWindow)),
        maxInputTokens: minimum(bindings.map(({ model }) => model.maxInputTokens)),
        maxOutputTokens: minimum(bindings.map(({ model }) => model.maxOutputTokens)),
        autoCompactTokenLimit: minimum(bindings.map(({ model }) => model.autoCompactTokenLimit)),
        modalities: modalities.length ? modalities : ["text"],
        capabilities,
        capabilityLimitations,
        reasoningEfforts,
        metadataSources: commonMetadataSources(bindings),
        pricing,
      } satisfies ProviderModelOption;
    })
    .sort((left, right) =>
      `${left.providerLabel}:${left.displayName}`.localeCompare(
        `${right.providerLabel}:${right.displayName}`
      )
    );
}

export function formFromModel(model: InferenceModel): ModelForm {
  return {
    publicId: model.publicId,
    displayName: model.displayName,
    subscriptionMultiplier: String(model.subscriptionMultiplier),
    contextWindow: String(model.contextWindow),
    maxInputTokens: String(model.maxInputTokens),
    maxOutputTokens: model.maxOutputTokens == null ? "" : String(model.maxOutputTokens),
    autoCompactTokenLimit: String(model.autoCompactTokenLimit),
  };
}

export function formWithProviderModel(
  current: ModelForm,
  option: ProviderModelOption,
  replaceIdentity = false
): ModelForm {
  const safeAutoCompactTokenLimit =
    option.autoCompactTokenLimit != null && option.maxInputTokens != null
      ? Math.min(option.autoCompactTokenLimit, option.maxInputTokens)
      : option.autoCompactTokenLimit;
  return {
    ...current,
    publicId:
      !replaceIdentity && current.publicId
        ? current.publicId
        : publicIdFromName(option.displayName),
    displayName: !replaceIdentity && current.displayName ? current.displayName : option.displayName,
    contextWindow: technicalValue(option.contextWindow, current.contextWindow, replaceIdentity),
    maxInputTokens: technicalValue(option.maxInputTokens, current.maxInputTokens, replaceIdentity),
    maxOutputTokens: technicalValue(
      option.maxOutputTokens,
      current.maxOutputTokens,
      replaceIdentity
    ),
    autoCompactTokenLimit: technicalValue(
      safeAutoCompactTokenLimit,
      current.autoCompactTokenLimit,
      replaceIdentity
    ),
  };
}

export function modelTechnicalLimits(form: ModelForm) {
  return {
    contextWindow: Number(form.contextWindow),
    maxInputTokens: Number(form.maxInputTokens),
    maxOutputTokens: optionalTechnicalValue(form.maxOutputTokens),
    autoCompactTokenLimit: Number(form.autoCompactTokenLimit),
  };
}

export function manualMetadataForProviderModel(form: ModelForm, option: ProviderModelOption) {
  const limits = modelTechnicalLimits(form);
  const detectedAutoCompact =
    option.autoCompactTokenLimit != null && option.maxInputTokens != null
      ? Math.min(option.autoCompactTokenLimit, option.maxInputTokens)
      : option.autoCompactTokenLimit;
  const manualMetadata = {
    ...(option.contextWindow !== limits.contextWindow
      ? { contextWindow: limits.contextWindow }
      : {}),
    ...(option.maxInputTokens !== limits.maxInputTokens
      ? { maxInputTokens: limits.maxInputTokens }
      : {}),
    ...(option.maxOutputTokens !== limits.maxOutputTokens && limits.maxOutputTokens !== null
      ? { maxOutputTokens: limits.maxOutputTokens }
      : {}),
    ...(detectedAutoCompact !== limits.autoCompactTokenLimit
      ? { autoCompactTokenLimit: limits.autoCompactTokenLimit }
      : {}),
  };
  return Object.keys(manualMetadata).length > 0 ? manualMetadata : undefined;
}

export function hasCompleteTechnicalLimits(form: ModelForm) {
  const limits = modelTechnicalLimits(form);
  return (
    [limits.contextWindow, limits.maxInputTokens, limits.autoCompactTokenLimit].every(
      (value) => Number.isSafeInteger(value) && value > 0
    ) &&
    (limits.maxOutputTokens === null ||
      (Number.isSafeInteger(limits.maxOutputTokens) && limits.maxOutputTokens > 0)) &&
    limits.autoCompactTokenLimit <= limits.maxInputTokens
  );
}

export function defaultReasoningMap(
  wireEfforts: string[],
  persisted: Record<string, string>
): Record<string, string> {
  if (Object.keys(persisted).length) {
    const ordered = wireEfforts.flatMap((effort) =>
      Object.hasOwn(persisted, effort) ? [[effort, persisted[effort]!] as const] : []
    );
    const known = new Set(ordered.map(([effort]) => effort));
    return Object.fromEntries([
      ...ordered,
      ...Object.entries(persisted).filter(([effort]) => !known.has(effort)),
    ]);
  }
  return Object.fromEntries(
    CLIENT_REASONING_EFFORTS.flatMap((effort) =>
      wireEfforts.includes(effort) ? [[effort, effort]] : []
    )
  );
}

export function exposedReasoningEfforts(map: Record<string, string>): string[] {
  return Object.entries(map).flatMap(([clientEffort, upstreamEffort]) =>
    clientEffort.trim() && upstreamEffort.trim() ? [clientEffort.trim()] : []
  );
}

export function normalizeReasoningMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).flatMap(([clientEffort, upstreamEffort]) => {
      const client = clientEffort.trim();
      const upstream = upstreamEffort.trim();
      return client && upstream ? [[client, upstream]] : [];
    })
  );
}

function priceField(microdollars: number | null | undefined): string {
  return microdollars == null ? "" : String(microdollars / 1_000_000);
}

export function pricingFromModel(model: InferenceModel | null): ModelPricingForm {
  const pricing = model?.sources[0]?.pricing;
  if (!pricing) return EMPTY_MODEL_PRICING;
  return {
    inputPrice: priceField(pricing.inputMicrodollarsPerMillion),
    outputPrice: priceField(pricing.outputMicrodollarsPerMillion),
    imagePrice: priceField(pricing.otherUnitPrices.image_generation),
    searchPrice: priceField(pricing.otherUnitPrices.web_search_query),
    realtimePrice: priceField(pricing.otherUnitPrices.realtime_session),
  };
}

export function pricingFromProvider(
  pricing: InferenceProviderModelPricing | null | undefined
): ModelPricingForm {
  if (!pricing) return EMPTY_MODEL_PRICING;
  return {
    inputPrice: priceField(pricing.inputMicrodollarsPerMillion),
    outputPrice: priceField(pricing.outputMicrodollarsPerMillion),
    imagePrice: priceField(pricing.otherUnitPrices?.image_generation),
    searchPrice: priceField(pricing.otherUnitPrices?.web_search_query),
    realtimePrice: priceField(pricing.otherUnitPrices?.realtime_session),
  };
}

function microdollars(value: string): number {
  return Math.round(Number(value) * 1_000_000);
}

/** The manual pricing to save, or undefined for a model left without a price. */
export function pricingPayload(pricing: ModelPricingForm) {
  if (!hasTokenPrice(pricing)) return undefined;
  const unitPrices: Record<string, string> = {
    image_generation: pricing.imagePrice,
    image_edit: pricing.imagePrice,
    web_search_query: pricing.searchPrice,
    realtime_session: pricing.realtimePrice,
  };
  return {
    version: `manual-${new Date().toISOString()}`,
    inputMicrodollarsPerMillion: microdollars(pricing.inputPrice),
    outputMicrodollarsPerMillion: microdollars(pricing.outputPrice),
    otherUnitPrices: Object.fromEntries(
      Object.entries(unitPrices)
        .filter(([, value]) => value.trim())
        .map(([key, value]) => [key, microdollars(value)])
    ),
    source: "manual" as const,
  };
}

/** Input and output token prices are both set; without them the model has no price. */
export function hasTokenPrice(pricing: ModelPricingForm): boolean {
  return Boolean(pricing.inputPrice.trim() && pricing.outputPrice.trim());
}

export function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Every price set is a non-negative number, and the token prices are either both set or, for a model without a
 * price, all prices are empty.
 */
export function hasValidPricing(pricing: ModelPricingForm): boolean {
  const valid = Object.values(pricing).every((value) => {
    if (!value.trim()) return true;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0;
  });
  if (!valid) return false;
  if (hasTokenPrice(pricing)) return true;
  return Object.values(pricing).every((value) => !value.trim());
}

function intersect(values: string[][]) {
  const first = values[0] ?? [];
  return first.filter((value) => values.every((items) => items.includes(value)));
}

function minimum(values: Array<number | null>) {
  const known = values.filter((value): value is number => value != null && value > 0);
  return known.length ? Math.min(...known) : null;
}

function commonPricing(
  values: Array<InferenceProviderModelPricing | null>
): InferenceProviderModelPricing | null {
  const first = values[0];
  if (!first || values.some((value) => !value || JSON.stringify(value) !== JSON.stringify(first)))
    return null;
  return first;
}

function technicalValue(detected: number | null, current: string, replace: boolean) {
  if (!replace && current.trim()) return current;
  return detected != null ? String(detected) : "";
}

function optionalTechnicalValue(value: string) {
  return value.trim() ? Number(value) : null;
}

function normalizedDisplayName(value: string) {
  return value.trim().toLowerCase();
}
