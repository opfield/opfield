import { Plus } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
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
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AccessIdentityProvider } from "@/types";
import { AccessServiceTokensPanel } from "./AccessServiceTokensPanel";
import { IdentityProviderDialog } from "./IdentityProviderDialog";
import { SessionSelect } from "./SessionSelect";

const DEFAULT_SESSION_TTL_SECONDS = 86_400;

/** "access.acme.dev" from what was typed (a pasted URL too); "" when blank, null when invalid. */
function domainOf(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
}

/** "https://access.acme.dev" for a sign-in domain; this console's origin without one. */
function signInOriginOf(input: string): string {
  const domain = domainOf(input);
  return domain ? `https://${domain}` : window.location.origin;
}

/**
 * The installation's sign-in settings, opened from the Access Lists header: the sign-in domain,
 * the default session length, identity providers (admin:system) and service tokens (acl:edit).
 */
export function SignInSettingsDialog({
  open,
  onOpenChange,
  onProvidersChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProvidersChanged: () => void;
}) {
  const id = useId();
  const canEditSettings = useAuthStore((state) => state.hasScope("admin:system"));
  const canManageTokens = useAuthStore((state) => state.hasScope("acl:edit"));
  const [domain, setDomain] = useState("");
  const [sessionTtlSeconds, setSessionTtlSeconds] = useState(DEFAULT_SESSION_TTL_SECONDS);
  const [providers, setProviders] = useState<AccessIdentityProvider[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AccessIdentityProvider | null>(null);

  const loadProviders = useCallback(
    () =>
      api
        .listAccessIdentityProviders()
        .then(setProviders)
        .catch((error) => toastApiError(error, "Failed to load identity providers")),
    []
  );

  useEffect(() => {
    if (!open) return;
    setTokensLoading(canManageTokens);
    if (!canEditSettings) return;
    setSettingsLoading(true);
    void Promise.all([
      api
        .getAccessSignInSettings()
        .then((settings) => {
          setDomain(settings.domain ?? "");
          setSessionTtlSeconds(settings.defaultSessionTtlSeconds);
        })
        .catch((error) => toastApiError(error, "Failed to load sign-in settings")),
      loadProviders(),
    ]).finally(() => setSettingsLoading(false));
  }, [canEditSettings, canManageTokens, loadProviders, open]);

  const tokensLoaded = useCallback(() => setTokensLoading(false), []);

  const save = async () => {
    const nextDomain = domainOf(domain);
    if (nextDomain === null) {
      toast.error("Enter a domain like access.example.com");
      return;
    }
    setSaving(true);
    try {
      await api.updateAccessSignInSettings({
        domain: nextDomain || null,
        defaultSessionTtlSeconds: sessionTtlSeconds,
      });
      toast.success("Sign-in settings saved");
      onOpenChange(false);
    } catch (error) {
      toastApiError(error, "Failed to save sign-in settings");
    } finally {
      setSaving(false);
    }
  };

  const openProvider = (provider: AccessIdentityProvider | null) => {
    setEditingProvider(provider);
    setProviderDialogOpen(true);
  };

  const providerChanged = () => {
    void loadProviders();
    onProvidersChanged();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Sign-in settings</DialogTitle>
          </DialogHeader>
          <ContentLoading loading={settingsLoading || tokensLoading} />
          <div className="space-y-6">
            {canEditSettings ? (
              <>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-domain`} className="text-sm font-medium">
                    Sign-in domain
                  </label>
                  <Input
                    id={`${id}-domain`}
                    value={domain}
                    placeholder={window.location.host}
                    onChange={(event) => setDomain(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Every access list signs visitors in here. Once signed in, a visitor opens every
                    route their lists allow without signing in again.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={`${id}-session`} className="text-sm font-medium">
                    Default session length
                  </label>
                  <SessionSelect
                    id={`${id}-session`}
                    value={sessionTtlSeconds}
                    onChange={(value) => setSessionTtlSeconds(value ?? DEFAULT_SESSION_TTL_SECONDS)}
                  />
                </div>
                <PanelShell
                  title="Identity providers"
                  description="Sign-in methods access lists can offer."
                  headerActionsClassName="pl-4"
                  actions={
                    <Button onClick={() => openProvider(null)}>
                      <Plus />
                      Add provider
                    </Button>
                  }
                >
                  <div className="divide-y divide-border">
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Opfield account</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          Built in · accounts of this Opfield
                        </p>
                      </div>
                    </div>
                    {providers.map((provider) => (
                      <div
                        key={provider.id}
                        className="flex items-center justify-between gap-4 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{provider.name}</p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {provider.kind === "google"
                              ? `Client ${provider.clientId}`
                              : `OIDC · ${provider.issuer}`}
                          </p>
                        </div>
                        <Button
                          variant="link"
                          className="h-auto p-0"
                          onClick={() => openProvider(provider)}
                        >
                          Edit
                        </Button>
                      </div>
                    ))}
                  </div>
                </PanelShell>
              </>
            ) : null}
            {canManageTokens ? <AccessServiceTokensPanel onLoaded={tokensLoaded} /> : null}
          </div>
          <DialogFooter className="shrink-0">
            {canEditSettings ? (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={() => void save()} pending={saving}>
                  Save
                </Button>
              </>
            ) : (
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <IdentityProviderDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        provider={editingProvider}
        signInOrigin={signInOriginOf(domain)}
        onSaved={providerChanged}
      />
    </>
  );
}
