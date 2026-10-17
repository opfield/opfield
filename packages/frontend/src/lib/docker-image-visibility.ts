import {
  LEGACY_INTERNAL_REGISTRY_ID,
  LEGACY_REGISTRY_NAMESPACE,
} from "../../../backend/src/lib/legacy-compat";
export function isInternalAvailabilityImage(reference: string): boolean {
  return new RegExp(
    String.raw`^(?:[^/]+\/)?${LEGACY_REGISTRY_NAMESPACE}\/availability\/`,
    "i"
  ).test(reference);
}

export function isUserDockerRegistry(registry: { id: string; source?: string }): boolean {
  return registry.source !== "system" && registry.id !== LEGACY_INTERNAL_REGISTRY_ID;
}
