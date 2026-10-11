import { motion } from "framer-motion";
import { ArrowLeft, Check, ExternalLink, MoreHorizontal, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { CopyValueField } from "@/components/common/CopyValueField";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import type { InferenceOAuthSession, InferenceProviderCatalogItem } from "@/types/inference";

type AuthType = "oauth" | "api_key" | "local";

const STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

const CALLBACK_STATUS_POLL_MS = 500;

export function InferenceProviderConnectDialog({
  open,
  catalog,
  initialProviderId,
  onOpenChange,
  onConnected,
  locked = false,
  onBack,
  onSkip,
}: {
  open: boolean;
  catalog: InferenceProviderCatalogItem[];
  initialProviderId?: string;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void | Promise<void>;
  locked?: boolean;
  onBack?: () => void;
  onSkip?: () => void;
}) {
  const initial = useMemo(
    () =>
      catalog.find((provider) => provider.id === initialProviderId) ??
      catalog.find((provider) => provider.featured) ??
      catalog[0],
    [catalog, initialProviderId]
  );
  const [providerId, setProviderId] = useState("");
  const [authType, setAuthType] = useState<AuthType>("api_key");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [oauth, setOAuth] = useState<InferenceOAuthSession | null>(null);
  const [callback, setCallback] = useState("");
  const [saving, setSaving] = useState(false);
  const initializedDraftRef = useRef<string | null>(null);
  const callbackAttempt = useRef(0);
  const onOpenChangeRef = useRef(onOpenChange);
  const onConnectedRef = useRef(onConnected);
  onOpenChangeRef.current = onOpenChange;
  onConnectedRef.current = onConnected;
  const selected = catalog.find((provider) => provider.id === providerId);
  const oauthProvider = oauth
    ? catalog.find((provider) => provider.id === oauth.providerId)
    : selected;
  const authorizationProviderLabel = (oauthProvider?.label ?? "Provider").replace(
    /\s+subscription$/i,
    ""
  );
  const contentKey = oauth ? `oauth-${oauth.completionMode}` : "setup";

  useEffect(() => {
    if (!open) {
      initializedDraftRef.current = null;
      return;
    }
    if (!initial) return;
    const draftKey = initialProviderId ?? "default";
    if (initializedDraftRef.current === draftKey) return;
    initializedDraftRef.current = draftKey;
    setProviderId(initial.id);
    setAuthType(
      initial.authTypes.includes("oauth") ? "oauth" : (initial.authTypes[0] ?? "api_key")
    );
    setName("");
    setApiKey("");
    setBaseUrl(initial.baseUrl);
    setAllowPrivateNetwork(false);
    setOAuth(null);
    setCallback("");
  }, [initial, initialProviderId, open]);

  const selectProvider = (id: string) => {
    const provider = catalog.find((item) => item.id === id);
    setProviderId(id);
    setAuthType(
      provider?.authTypes.includes("oauth") ? "oauth" : (provider?.authTypes[0] ?? "api_key")
    );
    setBaseUrl(provider?.baseUrl ?? "");
    setOauthState(null);
  };

  const setOauthState = useCallback((session: InferenceOAuthSession | null) => {
    if (
      session &&
      (session.status === "error" || session.status === "expired" || session.status === "cancelled")
    ) {
      toast.error(
        session.errorMessage ??
          (session.status === "expired"
            ? "Authorization timed out after 10 minutes"
            : session.status === "cancelled"
              ? "Authorization was cancelled"
              : "Authorization failed")
      );
      setOAuth(null);
      return;
    }
    setOAuth(session);
  }, []);

  const finish = useCallback(
    async (session: InferenceOAuthSession) => {
      setOauthState(session);
      if (session.status !== "complete") return;
      toast.success("Provider connected");
      onOpenChangeRef.current(false);
      await onConnectedRef.current();
    },
    [setOauthState]
  );

  useEffect(() => {
    if (!open || !oauth || oauth.status !== "pending" || oauth.completionMode !== "device_poll")
      return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const session = await api.getInferenceOAuthStatus(oauth.id);
        if (cancelled) return;
        await finish(session);
        if (session.status === "pending") {
          timer = window.setTimeout(poll, Math.max(1, session.pollIntervalSeconds ?? 5) * 1000);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Authorization status check failed");
          setOauthState(null);
        }
      }
    };
    timer = window.setTimeout(poll, Math.max(1, oauth.pollIntervalSeconds ?? 5) * 1000);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [finish, oauth, open, setOauthState]);

  useEffect(() => {
    if (!open || !oauth || oauth.status !== "pending") return;
    const remaining = Math.max(0, new Date(oauth.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(async () => {
      try {
        await finish(await api.getInferenceOAuthStatus(oauth.id));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Authorization timed out");
        setOauthState(null);
      }
    }, remaining + 250);
    return () => window.clearTimeout(timer);
  }, [finish, oauth, open, setOauthState]);

  const completeCallback = async () => {
    const value = callback.trim();
    if (
      !oauth ||
      oauth.status !== "pending" ||
      oauth.completionMode !== "paste_callback" ||
      !isCompleteCallback(value, oauth.providerId) ||
      saving
    )
      return;
    const attempt = ++callbackAttempt.current;
    setSaving(true);
    try {
      let session = await api.completeInferenceOAuth(oauth.id, value);
      while (session.status === "pending" && callbackAttempt.current === attempt) {
        await new Promise((resolve) => window.setTimeout(resolve, CALLBACK_STATUS_POLL_MS));
        if (callbackAttempt.current !== attempt) return;
        session = await api.getInferenceOAuthStatus(oauth.id);
      }
      if (callbackAttempt.current === attempt) await finish(session);
    } catch (error) {
      if (callbackAttempt.current === attempt)
        toast.error(error instanceof Error ? error.message : "Authorization failed");
    } finally {
      if (callbackAttempt.current === attempt) setSaving(false);
    }
  };

  const connect = async () => {
    if (!selected || !name.trim()) return;
    const startOAuth = async () => {
      try {
        const session = await api.startInferenceOAuth({
          providerId: selected.id,
          connectionName: name.trim(),
          acceptTerms: selected.subscription,
          termsVersion: selected.termsVersion,
        });
        setOauthState(session);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to connect provider");
        return false;
      }
    };
    if (authType === "oauth" && selected.subscription) {
      await confirmAction(
        {
          title: "Review Provider Terms",
          description:
            "The provider may not permit third-party subscription connectors and may restrict or block your account. Review the provider's current Terms of Service before continuing. Continue only if you accept this risk.",
          confirmLabel: "Continue to authorization",
          cancelLabel: "Go back",
          variant: "default",
        },
        startOAuth
      );
      return;
    }
    setSaving(true);
    try {
      if (authType === "oauth") {
        await startOAuth();
      } else {
        await api.createInferenceProviderConnection({
          providerId: selected.id,
          name: name.trim(),
          authType,
          ...(authType === "api_key" ? { apiKey } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          allowPrivateNetwork,
        });
        toast.success("Provider connected");
        onOpenChange(false);
        await onConnected();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to connect provider");
    } finally {
      setSaving(false);
    }
  };

  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      callbackAttempt.current += 1;
      setSaving(false);
      if (oauth?.status === "pending") void api.cancelInferenceOAuth(oauth.id).catch(() => {});
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={locked ? () => {} : close}>
      <DialogContent
        hideCloseButton={locked}
        className="sm:max-w-xl"
        onEscapeKeyDown={locked ? (event) => event.preventDefault() : undefined}
        onPointerDownOutside={locked ? (event) => event.preventDefault() : undefined}
        onInteractOutside={locked ? (event) => event.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>Connect Inference Provider</DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="space-y-2">
            <p>
              Connect a subscription account or API credential so Gateway can discover the models
              available from this provider.
            </p>
            <p>
              The connection stays managed by Gateway and can be reviewed, changed, or removed later
              from Gateway Inference settings.
            </p>
          </div>
        </DialogDescription>
        <AnimatedHeight>
          <motion.div key={contentKey} {...STEP_ANIMATION}>
            {!oauth && (
              <div className="border border-border">
                <SettingsControlRow title="Provider">
                  <Select
                    value={providerId}
                    onValueChange={selectProvider}
                    disabled={Boolean(initialProviderId)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {catalog.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsControlRow>
                <SettingsControlRow title="Connection name">
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Team account"
                  />
                </SettingsControlRow>
                {selected && selected.authTypes.length > 1 && (
                  <SettingsControlRow title="Authentication">
                    <Select
                      value={authType}
                      onValueChange={(value) => setAuthType(value as AuthType)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {selected.authTypes.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type.replace("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsControlRow>
                )}
                {authType === "api_key" && (
                  <SettingsControlRow title="API key">
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      autoComplete="off"
                    />
                  </SettingsControlRow>
                )}
                {(selected?.allowBaseUrlOverride || !selected?.baseUrl) && (
                  <SettingsControlRow title="Base URL">
                    <Input
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://provider.example/v1"
                    />
                  </SettingsControlRow>
                )}
                {(selected?.allowBaseUrlOverride || authType === "local") && (
                  <SettingsControlRow
                    title="Allow private network"
                    description="Only for an explicitly trusted private endpoint"
                    help="Allows loopback, RFC 1918, and private IPv6 provider addresses. Link-local and metadata ranges remain blocked; enable only for a trusted endpoint."
                  >
                    <Switch
                      checked={allowPrivateNetwork}
                      onChange={setAllowPrivateNetwork}
                      ariaLabel="Allow private network"
                    />
                  </SettingsControlRow>
                )}
              </div>
            )}
            {oauth && (
              <div className="space-y-3 border border-border p-4">
                {oauth.completionMode === "device_poll" ? (
                  <>
                    <p className="text-sm">
                      Complete authorization in the provider window. Gateway checks the status
                      automatically.
                    </p>
                    {oauth.userCode && (
                      <CopyValueField
                        label="Authorization code"
                        value={oauth.userCode}
                        valueClassName="font-mono"
                        actions={
                          <Button
                            variant="ghost"
                            className="rounded-none border-l border-border bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() =>
                              window.open(oauth.authorizationUrl, "_blank", "noopener,noreferrer")
                            }
                          >
                            <ExternalLink />
                            Open
                          </Button>
                        }
                      />
                    )}
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Waiting for provider authorization…
                    </p>
                  </>
                ) : (
                  <>
                    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                      <li>Open {authorizationProviderLabel} authorization and sign in.</li>
                      <li>
                        Copy the code {authorizationProviderLabel} shows, or the final localhost
                        callback URL.
                      </li>
                      <li>Paste it below and confirm with the checkmark.</li>
                    </ol>
                    <Button asChild variant="outline">
                      <a href={oauth.authorizationUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        Open {authorizationProviderLabel} authorization
                      </a>
                    </Button>
                    <form
                      className="flex min-w-0 border border-input bg-background"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void completeCallback();
                      }}
                    >
                      <Input
                        value={callback}
                        onChange={(event) => setCallback(event.target.value)}
                        placeholder={
                          oauth.providerId === "xai"
                            ? "Paste authorization code or callback URL"
                            : "Paste code#state or callback URL"
                        }
                        className="min-w-0 flex-1 border-0"
                        disabled={saving}
                        autoFocus
                      />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="icon"
                        className="relative rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                        disabled={!isCompleteCallback(callback.trim(), oauth.providerId)}
                        pending={saving}
                        aria-label={`Complete ${authorizationProviderLabel} authorization`}
                        title="Complete authorization"
                      >
                        <Check />
                      </Button>
                    </form>
                    {saving && (
                      <p className="text-xs text-muted-foreground">Completing authorization…</p>
                    )}
                  </>
                )}
              </div>
            )}
          </motion.div>
        </AnimatedHeight>
        <DialogFooter>
          {locked ? (
            <>
              {onSkip && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (oauth?.status === "pending")
                      void api.cancelInferenceOAuth(oauth.id).catch(() => {});
                    onSkip();
                  }}
                  disabled={saving}
                >
                  <MoreHorizontal />
                  Skip
                </Button>
              )}
              {onBack && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (oauth?.status === "pending")
                      void api.cancelInferenceOAuth(oauth.id).catch(() => {});
                    onBack();
                  }}
                  disabled={saving}
                >
                  <ArrowLeft />
                  Back
                </Button>
              )}
            </>
          ) : (
            <Button variant="outline" onClick={() => close(false)}>
              {oauth ? "Close" : "Cancel"}
            </Button>
          )}
          {!oauth && (
            <Button
              onClick={() => void connect()}
              disabled={!selected || !name.trim() || (authType === "api_key" && !apiKey.trim())}
              pending={saving}
            >
              {authType === "oauth" ? "Start authorization" : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isCompleteCallback(value: string, providerId: string) {
  if (!value) return false;
  if (providerId === "xai" && /^[A-Za-z0-9_-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return Boolean(url.searchParams.get("code") && url.searchParams.get("state"));
  } catch {
    const [code, state] = value.split("#", 2);
    return Boolean(code?.trim() && state?.trim());
  }
}
