import { Plus } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
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
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AccessIdentityProvider } from "@/types";
import { AccessServiceTokensPanel } from "./AccessServiceTokensPanel";
import { IdentityProviderDialog } from "./IdentityProviderDialog";
import { SessionSelect } from "./SessionSelect";

const DEFAULT_SESSION_TTL_SECONDS = 86_400;

/**
 * The installation's sign-in settings, opened from the Access Lists header: the default session
 * length, identity providers (admin:system) and service tokens (acl:edit). Every protected route
 * serves its own sign-in page.
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
        .then((settings) => setSessionTtlSeconds(settings.defaultSessionTtlSeconds))
        .catch((error) => toastApiError(error, "Failed to load sign-in settings")),
      loadProviders(),
    ]).finally(() => setSettingsLoading(false));
  }, [canEditSettings, canManageTokens, loadProviders, open]);

  const tokensLoaded = useCallback(() => setTokensLoading(false), []);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAccessSignInSettings({ defaultSessionTtlSeconds: sessionTtlSeconds });
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
          <AnimatedHeight>
            <div className="space-y-6">
              {canEditSettings ? (
                <>
                  <div className="space-y-1.5">
                    <label htmlFor={`${id}-session`} className="text-sm font-medium">
                      Default session length
                    </label>
                    <SessionSelect
                      id={`${id}-session`}
                      value={sessionTtlSeconds}
                      onChange={(value) =>
                        setSessionTtlSeconds(value ?? DEFAULT_SESSION_TTL_SECONDS)
                      }
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
          </AnimatedHeight>
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
        onSaved={providerChanged}
      />
    </>
  );
}
