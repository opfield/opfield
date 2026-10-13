import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import {
  AllowedAddressesRow,
  currentTokenExpiry,
  ExpiryField,
  type ExpiryValue,
  expiryError,
  expiryRequestValue,
  newTokenExpiry,
  sameAddresses,
  sameExpiry,
  TokenLimitsMeta,
} from "@/components/common/TokenLimitFields";
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
import { toastApiError } from "@/lib/api-error-toast";
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
  const [expiry, setExpiry] = useState<ExpiryValue>(newTokenExpiry);
  const [allowedIps, setAllowedIps] = useState<string[]>([]);
  // The token the edit dialog shows; kept while the dialog closes.
  const [editing, setEditing] = useState<InferenceToken | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editExpiry, setEditExpiry] = useState<ExpiryValue>(newTokenExpiry);
  const [initialEditExpiry, setInitialEditExpiry] = useState<ExpiryValue>(newTokenExpiry);
  const [editAllowedIps, setEditAllowedIps] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useContentLoading(initialLoading);

  const createExpiryInvalid = expiryError(expiry) !== null;
  const editNameChanged = !!editing && editName.trim() !== editing.name;
  const editExpiryChanged = !sameExpiry(editExpiry, initialEditExpiry);
  const editIpsChanged = !!editing && !sameAddresses(editAllowedIps, editing.allowedIps ?? []);
  const editExpiryInvalid = editExpiryChanged && expiryError(editExpiry) !== null;
  const editChanged = editNameChanged || editExpiryChanged || editIpsChanged;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listInferenceTokens();
      setTokens(result.filter((token) => token.status === "active"));
    } catch (error) {
      toastApiError(error, "Failed to load inference tokens");
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
    setExpiry(newTokenExpiry());
    setAllowedIps([]);
    setCreateOpen(true);
  };

  const openEdit = (token: InferenceToken) => {
    const current = currentTokenExpiry(token.expiresAt);
    setEditing(token);
    setEditName(token.name);
    setEditExpiry(current);
    setInitialEditExpiry(current);
    setEditAllowedIps(token.allowedIps ?? []);
    setEditOpen(true);
  };

  const create = async () => {
    if (!name.trim() || createExpiryInvalid) return;
    setCreating(true);
    try {
      const result = await api.createInferenceToken(name.trim(), {
        expiresAt: expiryRequestValue(expiry),
        allowedIps,
      });
      setSecret(result.token);
      setSecretOpen(true);
      setCreateOpen(false);
      await load();
      toast.success("Inference token created");
    } catch (error) {
      toastApiError(error, "Failed to create inference token");
    } finally {
      setCreating(false);
    }
  };

  const save = async () => {
    if (!editing || !editName.trim() || !editChanged || editExpiryInvalid) return;
    setSaving(true);
    try {
      await api.updateInferenceToken(editing.id, {
        ...(editNameChanged ? { name: editName.trim() } : {}),
        ...(editExpiryChanged ? { expiresAt: expiryRequestValue(editExpiry) } : {}),
        ...(editIpsChanged ? { allowedIps: editAllowedIps } : {}),
      });
      setEditOpen(false);
      await load();
      toast.success("Inference token updated");
    } catch (error) {
      toastApiError(error, "Failed to update inference token");
    } finally {
      setSaving(false);
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
      toastApiError(error, "Failed to revoke inference token");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <>
      <PanelShell
        title="Inference API Tokens"
        description="Use the Opfield inference base URL with a dedicated opfi_ credential."
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
                className={
                  canManage
                    ? "flex cursor-pointer items-center justify-between gap-3 p-4 transition-colors hover:bg-accent/50 sm:gap-4"
                    : "flex items-center justify-between gap-3 p-4 transition-colors hover:bg-accent/50 sm:gap-4"
                }
                onClick={canManage ? () => openEdit(token) : undefined}
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
                      <TokenLimitsMeta expiresAt={token.expiresAt} allowedIps={token.allowedIps} />
                    </p>
                  </div>
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={`Revoke ${token.name}`}
                    pending={revokingId === token.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      void revoke(token);
                    }}
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Inference Token</DialogTitle>
          </DialogHeader>
          <DialogDescription>The token will be shown once after creation.</DialogDescription>
          <div className="space-y-4">
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
            <ExpiryField value={expiry} onChange={setExpiry} />
            <AllowedAddressesRow value={allowedIps} onChange={setAllowedIps} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              pending={creating}
              disabled={!name.trim() || createExpiryInvalid}
            >
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Inference Token</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="inference-token-edit-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="inference-token-edit-name"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                placeholder="e.g., Codex on MacBook"
              />
            </div>
            <ExpiryField
              value={editExpiry}
              onChange={setEditExpiry}
              showError={editExpiryChanged}
            />
            <AllowedAddressesRow value={editAllowedIps} onChange={setEditAllowedIps} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Close
            </Button>
            <Button
              onClick={() => void save()}
              pending={saving}
              disabled={!editName.trim() || !editChanged || editExpiryInvalid}
            >
              Save
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
