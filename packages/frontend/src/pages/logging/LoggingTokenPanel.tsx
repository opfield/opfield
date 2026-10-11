import { Key, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
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
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { LoggingEnvironment, LoggingIngestToken } from "@/types";

export function LoggingTokenPanel({
  environment,
  canDelete,
  createDialogOpen,
  onCreateDialogOpenChange,
}: {
  environment: LoggingEnvironment;
  canDelete: boolean;
  createDialogOpen: boolean;
  onCreateDialogOpenChange: (open: boolean) => void;
}) {
  const [tokens, setTokens] = useState<LoggingIngestToken[]>([]);
  // The first list holds the tab; refreshes after changes update it in place.
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdTokenOpen, setCreatedTokenOpen] = useState(false);
  useContentLoading(!tokensLoaded);

  const load = useCallback(() => {
    api
      .listLoggingTokens(environment.id)
      .then(setTokens)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load tokens")
      )
      .finally(() => setTokensLoaded(true));
  }, [environment.id]);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime(
    "logging.token.changed",
    (payload) => {
      const event = payload as { environmentId?: string };
      if (event.environmentId === environment.id) load();
    },
    { onReconnect: load }
  );

  const create = async () => {
    setCreating(true);
    try {
      const token = await api.createLoggingToken(environment.id, { name });
      setCreateDialogOpen(false);
      if (token.token) {
        setCreatedToken(token.token);
        setCreatedTokenOpen(true);
      }
      load();
    } catch (error) {
      if (!handleLicenseApiError(error, "Logging ingest tokens")) {
        toast.error(error instanceof Error ? error.message : "Failed to create token");
      }
    } finally {
      setCreating(false);
    }
  };

  const setCreateDialogOpen = (nextOpen: boolean) => {
    onCreateDialogOpenChange(nextOpen);
    if (!nextOpen) setName("");
  };

  const revoke = async (token: LoggingIngestToken) => {
    if (
      !(await confirm({
        title: "Revoke Ingest Token",
        description: `Revoke ${token.name}? Services using this token will stop ingesting logs.`,
        confirmLabel: "Revoke",
      }))
    ) {
      return;
    }
    await api.deleteLoggingToken(environment.id, token.id);
    load();
  };

  return (
    <>
      <PanelShell title="Ingest Tokens" description="Write-only tokens for external services">
        {tokens.length > 0 ? (
          <div className="divide-y divide-border">
            {tokens.map((token) => (
              <div key={token.id} className="flex items-center justify-between gap-4 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                    <Key className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{token.name}</p>
                      <Badge variant={token.enabled ? "success" : "secondary"} size="inline">
                        {token.enabled ? "ENABLED" : "DISABLED"}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {token.tokenPrefix}... &middot; Created{" "}
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
                {canDelete && (
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => void revoke(token)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState message="No ingest tokens created yet" embedded />
        )}
      </PanelShell>
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Ingest Token</DialogTitle>
            <DialogDescription>Generate a write-only token for this environment.</DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production collector"
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button pending={creating} disabled={!name.trim()} onClick={() => void create()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <OneTimeSecretDialog
        open={createdTokenOpen}
        onOpenChange={setCreatedTokenOpen}
        title="Ingest Token Created"
        fields={createdToken ? [{ label: "Ingest token", value: createdToken }] : null}
        onClosed={() => setCreatedToken(null)}
      />
    </>
  );
}
