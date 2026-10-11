import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { inferenceTokenChangedChannel } from "@/services/user-resource-events";
import { useAuthStore } from "@/stores/auth";
import type { InferenceToken } from "@/types/inference";

export function InferenceTokensSection({ canManage }: { canManage: boolean }) {
  const userId = useAuthStore((state) => state.user?.id);
  const [tokens, setTokens] = useState<InferenceToken[]>([]);
  const [loading, setLoading] = useState(true);
  const initialLoading = useInitialLoading(loading);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  useContentLoading(initialLoading);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listInferenceTokens();
      setTokens(result.filter((token) => token.status === "active"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load inference tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);
  useRealtime(userId ? inferenceTokenChangedChannel(userId) : null, () => void load(), {
    onReconnect: load,
  });

  const openCreate = () => {
    setName("");
    setCreateOpen(true);
  };

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const result = await api.createInferenceToken(name.trim());
      setSecret(result.token);
      setSecretOpen(true);
      setCreateOpen(false);
      await load();
      toast.success("Inference token created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create inference token");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: InferenceToken) => {
    const accepted = await confirm({
      title: "Revoke Inference Token",
      description: `Revoke “${token.name}”? Clients using it will lose access immediately.`,
      confirmLabel: "Revoke",
    });
    if (!accepted) return;
    setRevokingId(token.id);
    try {
      await api.revokeInferenceToken(token.id);
      await load();
      toast.success("Inference token revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke inference token");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <>
      <PanelShell
        title="Inference API Tokens"
        description="Use the Gateway inference base URL with a dedicated gwi_ credential."
        icon={<KeyRound className="h-4 w-4" />}
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Create Token
            </Button>
          ) : null
        }
      >
        {initialLoading ? null : tokens.length === 0 ? (
          <EmptyState
            message={
              canManage
                ? "No inference API tokens created yet."
                : "No inference API tokens available."
            }
            {...(canManage ? { actionLabel: "Create one", onAction: openCreate } : {})}
            embedded
          />
        ) : (
          <div className="divide-y divide-border">
            {tokens.map((token) => (
              <div
                key={token.id}
                className="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-accent/50 sm:gap-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{token.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono">{token.tokenPrefix}...</span>
                      {" · Created "}
                      <RelativeTime value={token.createdAt} />
                      {token.lastUsedAt ? (
                        <>
                          {" · Last used "}
                          <RelativeTime value={token.lastUsedAt} />
                        </>
                      ) : (
                        " · Never used"
                      )}
                    </p>
                  </div>
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={`Revoke ${token.name}`}
                    pending={revokingId === token.id}
                    onClick={() => void revoke(token)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </PanelShell>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Inference Token</DialogTitle>
            <DialogDescription>The token will be shown once after creation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="inference-token-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="inference-token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g., Codex on MacBook"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} pending={creating} disabled={!name.trim()}>
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimeSecretDialog
        open={secretOpen}
        onOpenChange={setSecretOpen}
        title="Inference Token Created"
        fields={secret ? [{ label: "Inference token", value: secret }] : null}
        onClosed={() => setSecret(null)}
      />
    </>
  );
}
