import { PanelShell } from "@/components/common/PanelShell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import type { AIContextUsage } from "@/stores/ai";

interface AIContextUsageDialogProps {
  usage: AIContextUsage | null;
  onClose: () => void;
}

function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function Breakdown({ title, items }: { title: string; items: AIContextUsage["systemBreakdown"] }) {
  if (items.length === 0) return null;

  return (
    <PanelShell title={title} bodyClassName="divide-y divide-border">
      {[...items]
        .sort((left, right) => right.tokens - left.tokens)
        .slice(0, 6)
        .map((item) => (
          <UsageRow
            key={item.label}
            label={item.label}
            value={`~${item.tokens.toLocaleString()} tokens`}
          />
        ))}
    </PanelShell>
  );
}

export function AIContextUsageDialog({ usage, onClose }: AIContextUsageDialogProps) {
  const displayedUsage = useRetainedDialogValue(usage, usage !== null);

  const estimateNote =
    displayedUsage?.source === "fallback"
      ? "The server estimate is unavailable, so these values use a local fallback."
      : displayedUsage?.source === "settings"
        ? "These values combine the local chat with the configured assistant context."
        : null;

  return (
    <Dialog
      open={usage !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Context Usage</DialogTitle>
          <DialogDescription>Estimated context for the next assistant request.</DialogDescription>
        </DialogHeader>

        {displayedUsage && (
          <div className="space-y-3">
            <PanelShell bodyClassName="divide-y divide-border">
              <UsageRow
                label="Context used"
                value={`${displayedUsage.estimatedTokens.toLocaleString()} / ${displayedUsage.limit.toLocaleString()} (${displayedUsage.percent}%)`}
              />
              <UsageRow
                label="Chat"
                value={`~${displayedUsage.chatTokens.toLocaleString()} tokens · ${displayedUsage.messageCount} ${
                  displayedUsage.messageCount === 1 ? "message" : "messages"
                }`}
              />
              <UsageRow
                label="System prompt"
                value={`~${displayedUsage.systemTokens.toLocaleString()} tokens`}
              />
              <UsageRow
                label="Tools"
                value={`~${displayedUsage.toolsTokens.toLocaleString()} tokens · ${displayedUsage.toolCount} available`}
              />
              <UsageRow label="Reasoning" value={displayedUsage.reasoningEffort} />
            </PanelShell>

            <Breakdown title="System breakdown" items={displayedUsage.systemBreakdown} />
            <Breakdown title="Tool breakdown" items={displayedUsage.toolBreakdown} />

            {estimateNote && <p className="text-xs text-muted-foreground">{estimateNote}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
