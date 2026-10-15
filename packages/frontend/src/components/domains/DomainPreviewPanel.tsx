import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle } from "lucide-react";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import type { DomainPreview } from "@/types/domains";

const PREVIEW_ANIMATION = {
  initial: { height: 0, opacity: 0, y: 8 },
  animate: { height: "auto", opacity: 1, y: 0 },
  exit: { height: 0, opacity: 0, y: 8 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
} as const;

/** The DNS plan of a domain about to be added: Cloudflare records, or the external DNS check. */
export function DomainPreviewPanel({
  dnsProvider,
  preview,
  previewError,
  isPreviewLoading,
}: {
  dnsProvider: "cloudflare" | "external";
  preview: DomainPreview | null;
  previewError: string | null;
  isPreviewLoading: boolean;
}) {
  return (
    <AnimatePresence initial={false}>
      {(preview || previewError || isPreviewLoading) && (
        <motion.div {...PREVIEW_ANIMATION} className="overflow-hidden">
          <PanelShell
            title={dnsProvider === "cloudflare" ? "Cloudflare DNS preview" : "DNS check"}
            actions={
              isPreviewLoading ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-label="Loading"
                />
              ) : preview && preview.status !== "ready" && preview.status !== "valid" ? (
                <Badge
                  variant={
                    preview.status === "mismatch" ||
                    preview.status === "blocked" ||
                    preview.status === "invalid"
                      ? "warning"
                      : "secondary"
                  }
                  size="inline"
                >
                  {preview.status}
                </Badge>
              ) : null
            }
            bodyClassName="divide-y divide-border"
          >
            {preview?.dnsProvider === "cloudflare" ? (
              <>
                <DetailRow
                  label="Zone"
                  value={<span className="font-medium">{preview.zoneName}</span>}
                />
                <DetailRow
                  label="Target"
                  value={
                    <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                      {preview.desiredRecords.map((record) => (
                        <Badge key={`${record.type}-${record.content}`} variant="outline">
                          {record.type} {record.content}
                        </Badge>
                      ))}
                    </div>
                  }
                />
                {preview.currentRecords.length > 0 && (
                  <DetailRow
                    label="Current"
                    value={
                      <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
                        {preview.currentRecords.map((record) => (
                          <Badge
                            key={record.id ?? `${record.type}-${record.content}`}
                            variant="outline"
                          >
                            {record.type} {record.content}
                          </Badge>
                        ))}
                      </div>
                    }
                  />
                )}
              </>
            ) : preview?.dnsProvider === "external" ? (
              <>
                <DetailRow
                  label="Expected"
                  value={
                    <span className="break-all font-mono text-xs">
                      {preview.targetIps.join(", ")}
                    </span>
                  }
                />
                <DetailRow
                  label="Resolved"
                  value={
                    <span className="break-all font-mono text-xs">
                      {[...preview.dnsRecords.a, ...preview.dnsRecords.aaaa].join(", ") ||
                        "No address records"}
                    </span>
                  }
                />
                {preview.queryName !== preview.domain && (
                  <DetailRow
                    label="Checked name"
                    value={<span className="break-all font-mono text-xs">{preview.queryName}</span>}
                  />
                )}
              </>
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {previewError ?? "Loading DNS preview..."}
              </p>
            )}
          </PanelShell>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
