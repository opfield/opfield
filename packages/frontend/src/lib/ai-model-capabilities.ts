import type { AIProviderStatus } from "@/types/ai";

export function selectedModelSupportsImages(
  status: AIProviderStatus | null,
  selectedModel: string | null
): boolean {
  if (!status?.enabled) return false;
  if (status.providerType !== "opfield_inference") return status.supportsImages;
  if (!selectedModel) return false;
  return status.models.find((model) => model.id === selectedModel)?.supportsImages === true;
}
