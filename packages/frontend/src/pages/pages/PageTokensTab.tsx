import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { Switch } from "@/components/ui/switch";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { formatDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageDeployToken, PageDeployTokenCreated } from "@/types";

export function PageTokensTab({ projectId }: { projectId: string }) {
  const canManage = useAuthStore((state) =>
    state.hasScopedAccess(`pages:tokens:manage:${projectId}`)
  );
  const [tokens, setTokens] = useState<PageDeployToken[]>([]);
  const [loading, setLoading] = useState(true);
  const initialLoading = useInitialLoading(loading);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [allowUserTag, setAllowUserTag] = useState(true);
  const [allowedTagPatterns, setAllowedTagPatterns] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [createdToken, setCreatedToken] = useState<PageDeployTokenCreated | null>(null);
  const [createdTokenOpen, setCreatedTokenOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading((current) => current || tokens.length === 0);
    try {
      setTokens((await api.listPageDeployTokens(projectId)).filter((token) => !token.revokedAt));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load deploy tokens");
    } finally {
      setLoading(false);
    }
  }, [projectId, tokens.length]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(
    "pages.token.changed",
    (payload) => {
      const event = payload as { projectId?: string };
      if (!event.projectId || event.projectId === projectId) void load();
    },
    { onReconnect: load }
  );

  const openCreate = () => {
    setName("");
    setAllowUserTag(true);
    setAllowedTagPatterns("");
    setExpiresAt("");
    setDialogOpen(true);
  };

  const create = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const created = await api.createPageDeployToken(projectId, {
        name: name.trim(),
        allowedTagPatterns: allowedTagPatterns
          .split(",")
          .map((pattern) => pattern.trim())
          .filter(Boolean),
        allowUserTag,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      setCreatedToken(created);
      setCreatedTokenOpen(true);
      setDialogOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create deploy token");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (token: PageDeployToken) => {
    if (
      !(await confirm({
        title: "Revoke Deploy Token",
        description: `Revoke ${token.name}? New uploads using ${token.tokenPrefix} will stop authenticating.`,
        confirmLabel: "Revoke",
        variant: "destructive",
      }))
    ) {
      return;
    }
    try {
      await api.revokePageDeployToken(projectId, token.id);
      toast.success("Deploy token revoked");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke deploy token");
    }
  };

  useContentLoading(initialLoading);

  return (
    <div className="flex flex-col gap-4">
      <PanelShell
        icon={<KeyRound className="h-4 w-4" />}
        title="Deploy tokens"
        description="Use a token with the resumable webhook API. The raw secret is shown exactly once."
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Create token
            </Button>
          ) : undefined
        }
      >
        {initialLoading ? null : tokens.length === 0 ? (
          <EmptyState
            message="No deploy tokens have been created."
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
                      {token.allowUserTag
                        ? token.allowedTagPatterns.length > 0
                          ? ` · Tags: ${token.allowedTagPatterns.join(", ")}`
                          : " · Tags: any"
                        : " · Tags disabled"}
                      {token.expiresAt ? ` · Expires ${formatDate(token.expiresAt)}` : ""}
                    </p>
                  </div>
                </div>
                {canManage && !token.revokedAt && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => void revoke(token)}
                    aria-label={`Revoke ${token.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </PanelShell>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Deploy Token</DialogTitle>
            <DialogDescription>The token will be shown once after creation.</DialogDescription>
          </DialogHeader>
          <PanelShell
            icon={<KeyRound className="h-4 w-4" />}
            title="Token"
            description="Authentication and Tag publication limits for this deploy token."
          >
            <SettingsControlRow title="Name" controlsClassName="sm:min-w-56">
              <Input
                id="page-deploy-token-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="GitLab Pages webhook"
                autoFocus
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Publish Tags"
              description="Allow this token to publish an explicitly requested Tag in addition to latest."
              controlsClassName="sm:min-w-0"
            >
              <Switch
                checked={allowUserTag}
                onChange={setAllowUserTag}
                ariaLabel="Allow deploy token to publish Tags"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Allowed Tag patterns"
              description="Optional comma-separated patterns such as mr-* or staging. Empty allows any Tag."
              controlsClassName="sm:min-w-56"
            >
              <Input
                value={allowedTagPatterns}
                onChange={(event) => setAllowedTagPatterns(event.target.value)}
                placeholder="mr-*, staging"
                disabled={!allowUserTag}
                aria-label="Allowed Tag patterns"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Expiration"
              description="Optional. An expired token can no longer start or resume deployments."
              controlsClassName="sm:min-w-56"
            >
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className="[&::-webkit-calendar-picker-indicator]:pointer-events-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                aria-label="Deploy token expiration"
              />
            </SettingsControlRow>
          </PanelShell>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim() || saving}>
              <Plus className="h-4 w-4" />
              {saving ? "Creating..." : "Create token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimeSecretDialog
        open={createdTokenOpen}
        onOpenChange={setCreatedTokenOpen}
        title="Deploy Token Created"
        fields={createdToken ? [{ label: "Deploy token", value: createdToken.token }] : null}
        onClosed={() => setCreatedToken(null)}
      />
    </div>
  );
}
