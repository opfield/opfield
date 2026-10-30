import { motion } from "framer-motion";
import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { AnimatedSwitch, CONTENT_SWITCH_ANIMATION } from "@/components/common/AnimatedSwitch";
import { confirm } from "@/components/common/ConfirmDialog";
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
import { api } from "@/services/api";
import type {
  AccessIdentityProvider,
  AccessIdentityProviderKind,
  AccessIdentityProviderRequest,
} from "@/types";

const GOOGLE_ISSUER = "https://accounts.google.com";

/** Where a provider sends visitors back: the sign-in of the protected route itself. */
const REDIRECT_URI_PATTERN = "https://<route host>/_opfield/access/provider-callback";

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
 * write-only: blank keeps the stored one. Each protected route signs visitors in on its own
 * address, so the provider needs the redirect URI of every such route.
 */
export function IdentityProviderDialog({
  open,
  onOpenChange,
  provider,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider to edit; null adds one. */
  provider: AccessIdentityProvider | null;
  onSaved: () => void;
}) {
  const id = useId();
  const current = provider;
  const [kind, setKind] = useState<AccessIdentityProviderKind>("oidc");
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [groupsClaim, setGroupsClaim] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(provider?.kind ?? "oidc");
    setName(provider?.name ?? "");
    setIssuer(provider?.kind === "oidc" ? provider.issuer : "");
    setClientId(provider?.clientId ?? "");
    setClientSecret("");
    setGroupsClaim(provider ? (provider.groupsClaim ?? "") : "groups");
  }, [open, provider]);

  const isEdit = current !== null;

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
        await api.createAccessIdentityProvider(data);
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
    setRemoving(true);
    try {
      await api.deleteAccessIdentityProvider(current.id);
      toast.success("Identity provider removed");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastApiError(error, "Failed to remove identity provider");
    } finally {
      setRemoving(false);
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
          {/* The fields of the chosen type: switching the type replaces them in place. */}
          <AnimatedSwitch>
            <motion.div key={kind} {...CONTENT_SWITCH_ANIMATION} className="space-y-4">
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
            </motion.div>
          </AnimatedSwitch>
          <Field label="Redirect URI">
            <p className="text-xs text-muted-foreground">
              Register{" "}
              <span className="break-all font-mono text-foreground">{REDIRECT_URI_PATTERN}</span>{" "}
              with the provider for the address of every route an access list with this provider
              protects.
            </p>
          </Field>
        </div>
        <DialogFooter className="shrink-0">
          {isEdit ? (
            <Button
              variant="destructive"
              onClick={() => void remove()}
              pending={removing}
              disabled={saving}
            >
              <Trash2 />
              Remove
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} pending={saving} disabled={removing}>
            {isEdit ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
