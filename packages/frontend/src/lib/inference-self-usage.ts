import { lowInferenceUsageWindows } from "@/lib/dashboard-attention";
import type { InferenceSelfUsage } from "@/types/inference";

export const INFERENCE_SELF_USAGE_CACHE_KEY = "req:/api/inference/usage/self";
export const INFERENCE_SELF_USAGE_UPDATED_EVENT = "opfield:inference-self-usage-updated";
export const INFERENCE_USAGE_CHANGED_CHANNEL = "inference.usage.changed";
export const INFERENCE_CATALOG_CHANGED_CHANNEL = "inference.catalog.changed";
export type InferenceUsageChangedEvent = {
  targetUserId: string | null;
  reason: "limits" | "settlement";
};

/** Same rule as the Dashboard quota notices and the server's `inference-usage` attention notice. */
export function hasLowInferenceUsage(usage: InferenceSelfUsage | null): boolean {
  return lowInferenceUsageWindows(usage).length > 0;
}

export function publishInferenceSelfUsage(usage: InferenceSelfUsage): void {
  window.dispatchEvent(
    new CustomEvent<InferenceSelfUsage>(INFERENCE_SELF_USAGE_UPDATED_EVENT, {
      detail: usage,
    })
  );
}

export function subscribeToInferenceSelfUsage(
  listener: (usage: InferenceSelfUsage) => void
): () => void {
  const handleUsageUpdate = (event: Event) => {
    listener((event as CustomEvent<InferenceSelfUsage>).detail);
  };

  window.addEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, handleUsageUpdate);
  return () => window.removeEventListener(INFERENCE_SELF_USAGE_UPDATED_EVENT, handleUsageUpdate);
}
