import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
import { createClientUuid } from "@/lib/client-id";
import { api } from "@/services/api";
import type {
  AccessIdentityProvider,
  AccessIdentityProviderKind,
  AccessIdentityProviderRequest,
} from "@/types";

const GOOGLE_ISSUER = "https://accounts.google.com";

function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Adds or edits a Google or OIDC provider access lists can offer. The client secret is
 * write-only: blank keeps the stored one. A new provider gets its id here, so its redirect URI
 * can be registered with the provider before it is saved.
 */
export function IdentityProviderDialog({
  open,
  onOpenChange,
  provider,
  signInOrigin,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider to edit; null adds one. */
  provider: AccessIdentityProvider | null;
  /** "https://access.acme.dev": where visitors sign in and providers send them back. */
  signInOrigin: string;
  onSaved: () => void;
}) {
  const id = useId();
  // A new provider that came back with another id than the one offered continues as an edit.
  const [current, setCurrent] = useState<AccessIdentityProvider | null>(provider);
  const [newId, setNewId] = useState("");
  const [kind, setKind] = useState<AccessIdentityProviderKind>("oidc");
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [groupsClaim, setGroupsClaim] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent(provider);
    setNewId(createClientUuid());
    setKind(provider?.kind ?? "oidc");
    setName(provider?.name ?? "");
    setIssuer(provider?.kind === "oidc" ? provider.issuer : "");
    setClientId(provider?.clientId ?? "");
    setClientSecret("");
    setGroupsClaim(provider ? (provider.groupsClaim ?? "") : "groups");
  }, [open, provider]);

  const isEdit = current !== null;
  const providerId = current?.id ?? newId;
  const redirectUri = current?.redirectUri ?? `${signInOrigin}/access/idp/${providerId}/callback`;

  const save = async () => {
    if (!name.trim()) return void toast.error("Name is required");
    if (kind === "oidc" && !issuer.trim()) return void toast.error("Issuer URL is required");
    if (!clientId.trim()) return void toast.error("Client ID is required");
    if (!isEdit && !clientSecret) return void toast.error("Client secret is required");

    const data: AccessIdentityProviderRequest = {
      kind,
      name: name.trim(),
      issuer: kind === "oidc" ? issuer.trim() : GOOGLE_ISSUER,
      clientId: clientId.trim(),
      ...(clientSecret ? { clientSecret } : {}),
      groupsClaim: kind === "oidc" ? groupsClaim.trim() || null : null,
    };
    setSaving(true);
    try {
      if (current) {
        await api.updateAccessIdentityProvider(current.id, data);
        toast.success("Identity provider updated");
      } else {
        const created = await api.createAccessIdentityProvider({ ...data, id: newId });
        if (created.id !== newId) {
          setCurrent(created);
          setClientSecret("");
          onSaved();
          toast.message("Provider added. Register the redirect URI below with the provider.");
          return;
        }
        toast.success("Identity provider added");
      }
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastApiError(error, "Failed to save identity provider");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    const ok = await confirm({
      title: "Remove Identity Provider",
      description: `Remove ${current.name}? Access lists stop offering it and visitors signed in with it sign in again.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try {
      await api.deleteAccessIdentityProvider(current.id);
      toast.success("Identity provider removed");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastApiError(error, "Failed to remove identity provider");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Identity Provider" : "Add Identity Provider"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Type">
            <Select
              value={kind}
              onValueChange={(next) => setKind(next as AccessIdentityProviderKind)}
              disabled={isEdit}
            >
              <SelectTrigger aria-label="Type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google">Google</SelectItem>
                <SelectItem value="oidc">OIDC</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Name" htmlFor={`${id}-name`} hint="Shown on the sign-in button.">
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {kind === "oidc" ? (
            <Field label="Issuer URL" htmlFor={`${id}-issuer`}>
              <Input
                id={`${id}-issuer`}
                type="url"
                value={issuer}
                onChange={(event) => setIssuer(event.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Client ID" htmlFor={`${id}-client-id`}>
            <Input
              id={`${id}-client-id`}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </Field>
          <Field label="Client secret" htmlFor={`${id}-client-secret`}>
            <Input
              id={`${id}-client-secret`}
              type="password"
              autoComplete="new-password"
              // The stored secret is never sent back; blank keeps it.
              placeholder={isEdit ? "Keep current secret" : "Client secret"}
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </Field>
          {kind === "oidc" ? (
            <Field
              label="Groups claim"
              htmlFor={`${id}-groups`}
              hint="Claim the SSO group rules read."
            >
              <Input
                id={`${id}-groups`}
                value={groupsClaim}
                onChange={(event) => setGroupsClaim(event.target.value)}
              />
            </Field>
          ) : null}
          <CopyValueField label="Redirect URI" value={redirectUri} />
        </div>
        <DialogFooter className="shrink-0">
          {isEdit ? (
            <Button variant="destructive" onClick={() => void remove()} disabled={saving}>
              <Trash2 />
              Remove
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} pending={saving}>
            {isEdit ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
