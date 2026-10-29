import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { OneTimeSecretDialog } from "@/components/common/OneTimeSecretDialog";
import { PanelShell } from "@/components/common/PanelShell";
import {
  ExpiryField,
  type ExpiryValue,
  expiryError,
  expiryRequestValue,
  newTokenExpiry,
} from "@/components/common/TokenLimitFields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { formatDate } from "@/lib/utils";
import { api } from "@/services/api";
import type { AccessServiceToken, AccessServiceTokenCreated } from "@/types";

function expiryText(expiresAt: string | null): string {
  if (!expiresAt) return "no expiry";
  return new Date(expiresAt).getTime() <= Date.now()
    ? `expired ${formatDate(expiresAt)}`
    : `expires ${formatDate(expiresAt)}`;
}

/**
 * Service tokens of the Sign-in settings dialog: credentials scripts send in the
 * Opfield-Access-Client-Id / -Secret headers instead of signing in. The secret shows once.
 */
export function AccessServiceTokensPanel({
  onLoaded,
}: {
  /** Called once the first list is in, so the dialog can open complete. */
  onLoaded: () => void;
}) {
  const id = useId();
  const [tokens, setTokens] = useState<AccessServiceToken[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<ExpiryValue>(newTokenExpiry);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AccessServiceTokenCreated | null>(null);
  const [createdOpen, setCreatedOpen] = useState(false);

  const load = useCallback(() => {
    api
      .listAccessServiceTokens()
      .then(setTokens)
      .catch((error) => toastApiError(error, "Failed to load service tokens"))
      .finally(onLoaded);
  }, [onLoaded]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setName("");
    setExpiry(newTokenExpiry());
    setCreateOpen(true);
  };

  const create = async () => {
    setCreating(true);
    try {
      const token = await api.createAccessServiceToken({
        name: name.trim(),
        expiresAt: expiryRequestValue(expiry),
      });
      setCreateOpen(false);
      setCreated(token);
      setCreatedOpen(true);
      load();
    } catch (error) {
      toastApiError(error, "Failed to create service token");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: AccessServiceToken) => {
    const ok = await confirm({
      title: "Revoke Service Token",
      description: `Revoke ${token.name}? Scripts that send it are turned away.`,
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    try {
      await api.deleteAccessServiceToken(token.id);
      toast.success("Service token revoked");
      load();
    } catch (error) {
      toastApiError(error, "Failed to revoke service token");
    }
  };

  return (
    <>
      <PanelShell
        title="Service tokens"
        description="Credentials scripts send instead of signing in."
        headerActionsClassName="pl-4"
        actions={
          <Button onClick={openCreate}>
            <Plus />
            Create token
          </Button>
        }
      >
        {tokens.length > 0 ? (
          <div className="divide-y divide-border">
            {tokens.map((token) => (
              <div key={token.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{token.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    Client <span className="font-mono">{token.clientId}</span> ·{" "}
                    {expiryText(token.expiresAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Revoke ${token.name}`}
                  onClick={() => void revoke(token)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </PanelShell>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Service Token</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={`${id}-name`} className="text-sm font-medium">
                Name
              </label>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g., Status checker"
              />
            </div>
            <ExpiryField value={expiry} onChange={setExpiry} />
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              pending={creating}
              disabled={!name.trim() || expiryError(expiry) !== null}
              onClick={() => void create()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimeSecretDialog
        open={createdOpen}
        onOpenChange={setCreatedOpen}
        title="Service Token Created"
        description="Scripts send these as the Opfield-Access-Client-Id and Opfield-Access-Client-Secret headers."
        fields={
          created
            ? [
                { label: "Client ID", value: created.clientId },
                { label: "Client secret", value: created.clientSecret },
              ]
            : null
        }
        onClosed={() => setCreated(null)}
      />
    </>
  );
}
