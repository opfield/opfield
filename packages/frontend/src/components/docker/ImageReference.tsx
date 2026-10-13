import { ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import { formatDisplayImageRef } from "@/lib/docker-image-ref";
import { cn } from "@/lib/utils";
import { isInternalRegistryImage, workloadImageLabel } from "@/lib/workload-image-label";
import type { DockerImageSource } from "@/types";

const DIGEST_PREFIX = "sha256:";
const SHORT_DIGEST_LENGTH = 12;

/** Splits a display reference into the part that may truncate and a short digest that stays visible. */
function splitImageReference(value: string): { name: string; digest: string | null } {
  const display = formatDisplayImageRef(value);
  const at = display.indexOf("@");
  if (at < 0) return { name: display, digest: null };
  const digest = display.slice(at + 1);
  const short = digest.startsWith(DIGEST_PREFIX)
    ? `${DIGEST_PREFIX}${digest.slice(DIGEST_PREFIX.length, DIGEST_PREFIX.length + SHORT_DIGEST_LENGTH)}`
    : digest.slice(0, SHORT_DIGEST_LENGTH);
  return { name: display.slice(0, at), digest: short };
}

/**
 * An image reference on one line: the repository truncates with an ellipsis, a digest stays
 * visible in short form, and the full reference is in the tooltip and copied by the icon. An image
 * Opfield built from Git shows its repository and commit (the shared workload label), and an internal
 * copy the image it was copied from; the internal reference stays in the tooltip and the copy.
 */
export function ImageReference({
  value,
  source,
  sourceImage,
  copyable = true,
  className,
}: {
  value: string | null | undefined;
  source?: DockerImageSource | null;
  sourceImage?: string | null;
  copyable?: boolean;
  className?: string;
}) {
  const reference = (value ?? "").trim();
  if (!reference || reference === "—") return <span className={className}>{reference || "—"}</span>;
  const label = workloadImageLabel({ image: reference, source, sourceImage });
  const internal = isInternalRegistryImage(reference);
  const shown = internal && sourceImage?.trim() ? sourceImage.trim() : reference;
  const { name, digest } =
    label.kind === "source" || label.kind === "internal"
      ? { name: label.text, digest: null }
      : splitImageReference(shown);
  return (
    <span
      className={cn(
        "flex min-w-0 max-w-full items-center justify-end gap-1.5 font-mono",
        className
      )}
      title={reference}
    >
      <span className="flex min-w-0">
        <span className="min-w-0 truncate">{name}</span>
        {digest ? <span className="shrink-0">@{digest}</span> : null}
      </span>
      {copyable ? (
        // Inline copy icon inside the value text, like the ID rows; a Button would change the row height.
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-primary"
          aria-label="Copy image reference"
          title="Copy image reference"
          onClick={() =>
            navigator.clipboard.writeText(reference).then(
              () => toast.success("Copied to clipboard"),
              () => toast.error("Failed to copy")
            )
          }
        >
          <ClipboardCopy className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}
