import { managedLabel } from "@/lib/docker-managed-labels";
import { LEGACY_REGISTRY_NAMESPACE } from "../../../backend/src/lib/legacy-compat";

/** Managed label holding the image reference an imported archive was built from. */
export const ARCHIVE_IMAGE_REFERENCE_LABEL = "archive.image.reference";

export function resolveDeploymentImageReference(
  image: string | null | undefined,
  configuredImage: string,
  sourceImageReference?: string | null,
  inspect?: Record<string, any>
): string {
  const isPublicReference = (value?: string | null) =>
    Boolean(value && !/^sha256:/i.test(value) && !new RegExp(String.raw`(^|\/)${LEGACY_REGISTRY_NAMESPACE}\/availability\/`, "i").test(value));
  const inspectedImage = inspect && resolveContainerImageReference(inspect);
  if (isPublicReference(inspectedImage)) return inspectedImage!;
  if (isPublicReference(image)) return image!;
  // Only map the configured artifact. A standby slot may hold an older image.
  if (image === configuredImage && isPublicReference(sourceImageReference))
    return sourceImageReference!;
  return image || inspectedImage || "—";
}

export function resolveContainerImageReference(container: Record<string, any>): string {
  const config = (container.Config ?? {}) as Record<string, any>;
  const labels = (config.Labels ?? container.Labels ?? {}) as Record<string, string>;
  return (
    managedLabel(labels, ARCHIVE_IMAGE_REFERENCE_LABEL) || config.Image || container.Image || ""
  );
}

export function stripRegistryHostFromImageName(imageName: string): string {
  const trimmed = imageName.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("@")) return trimmed;

  const firstSlash = trimmed.indexOf("/");
  if (firstSlash === -1) return trimmed;

  const firstSegment = trimmed.slice(0, firstSlash);
  const looksLikeRegistryHost =
    firstSegment === "localhost" || firstSegment.includes(".") || firstSegment.includes(":");

  return looksLikeRegistryHost ? trimmed.slice(firstSlash + 1) : trimmed;
}

export function formatDisplayImageRef(imageRef: string): string {
  const trimmed = imageRef.trim();
  if (!trimmed) return trimmed;

  const digestIndex = trimmed.indexOf("@");
  if (digestIndex >= 0) {
    const imageName = trimmed.slice(0, digestIndex);
    const digest = trimmed.slice(digestIndex + 1);
    return `${stripRegistryHostFromImageName(imageName)}@${digest}`;
  }

  const lastColon = trimmed.lastIndexOf(":");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastColon === -1 || lastSlash > lastColon) {
    return stripRegistryHostFromImageName(trimmed);
  }

  const imageName = trimmed.slice(0, lastColon);
  const tag = trimmed.slice(lastColon + 1);
  return `${stripRegistryHostFromImageName(imageName)}:${tag}`;
}
