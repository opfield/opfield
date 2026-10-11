import { Check, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AccessPanel } from "@/components/access/AccessPanel";
import { AccessScopesDialog } from "@/components/access/AccessScopesDialog";
import { useAccessEditor } from "@/components/access/use-access-editor";
import { AuthWindowLoader } from "@/components/auth/AuthShell";
import { Notice } from "@/components/common/Notice";
import {
  allResourcePages,
  canLoadScopeResource,
  loadScopeResourceList,
  reportScopeLoadError,
} from "@/components/common/scope-list-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deriveAllowedResourceIdsByScope, parseScopesForForm } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import type {
  DatabaseConnection,
  LoggingSchema,
  Node,
  OAuthConsentPreview,
  ProxyHost,
} from "@/types";
import { RESOURCE_SCOPABLE_SCOPES, TOKEN_SCOPES } from "@/types";

type OAuthScopeItem = {
  value: string;
  label: string;
  desc: string;
  group: string;
};

type ConsentResult = {
  kind: "approved" | "denied";
  redirectUrl: string;
};

const OAUTH_ONLY_SCOPES: Record<string, Omit<OAuthScopeItem, "value">> = {
  "inference:setup": {
    label: "Set up inference clients",
    desc: "Configure supported inference clients and manage their dedicated runtime tokens.",
    group: "Inference",
  },
};

function scopeItem(scope: string): OAuthScopeItem {
  const oauthOnlyScope = OAUTH_ONLY_SCOPES[scope];
  if (oauthOnlyScope) return { value: scope, ...oauthOnlyScope };

  const match = [...TOKEN_SCOPES]
    .sort((a, b) => b.value.length - a.value.length)
    .find((item) => scope === item.value || scope.startsWith(`${item.value}:`));
  return {
    value: scope,
    label: match?.label ?? scope,
    desc: match?.desc ?? scope,
    group: match?.group ?? "Scope",
  };
}

function isLoopbackCallbackUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function OAuthConsent() {
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request") ?? "";
  const [preview, setPreview] = useState<OAuthConsentPreview | null>(null);
  // What the request grants unless narrowed: everything grantable but the high-risk scopes.
  const [defaultScopes, setDefaultScopes] = useState<string[]>([]);
  const [scopesOpen, setScopesOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const isSubmitting = submitting !== null;
  const [result, setResult] = useState<ConsentResult | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [databases, setDatabases] = useState<DatabaseConnection[]>([]);
  const [loggingSchemas, setLoggingSchemas] = useState<LoggingSchema[]>([]);
  const [resourceListsReady, setResourceListsReady] = useState(false);
  const { cas, fetchCAs } = useCAStore();
  // Consent is outside the dashboard shell, so the signed-in account is loaded here: the
  // restriction pickers only offer folders and resources that account can see.
  const accountScopes = useAuthStore((state) => state.user?.scopes);
  const [accountResolved, setAccountResolved] = useState(() =>
    Boolean(useAuthStore.getState().user)
  );

  useEffect(() => {
    if (useAuthStore.getState().user) return;
    let cancelled = false;
    void api
      .getCurrentUser()
      .then((user) => {
        if (!cancelled && !useAuthStore.getState().user) useAuthStore.getState().setUser(user);
      })
      .catch(() => {
        // The consent request itself reports a missing or expired session.
      })
      .finally(() => {
        if (!cancelled) setAccountResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!requestId) {
      setError("Missing OAuth request.");
      return;
    }
    try {
      const data = await api.getOAuthConsent(requestId);
      setPreview(data);
      setDefaultScopes(
        data.grantableScopes.filter((scope) => !data.manualApprovalScopes.includes(scope))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "OAuth request could not be loaded");
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountScopes) return;
    let active = true;
    void Promise.allSettled([
      canLoadScopeResource("pki:ca:view") ? fetchCAs() : undefined,
      loadScopeResourceList("nodes:details", () =>
        allResourcePages((page) => api.listNodes({ page, limit: 100 }))
      )
        .then(setNodes)
        .catch((error) => {
          setNodes([]);
          reportScopeLoadError("nodes", error);
        }),
      loadScopeResourceList("proxy:view", () =>
        allResourcePages((page) => api.listProxyHosts({ page, limit: 100 }))
      )
        .then(setProxyHosts)
        .catch((error) => {
          setProxyHosts([]);
          reportScopeLoadError("routes", error);
        }),
      loadScopeResourceList("databases:view", () =>
        allResourcePages((page) => api.listDatabases({ page, limit: 100 }))
      )
        .then(setDatabases)
        .catch((error) => {
          setDatabases([]);
          reportScopeLoadError("databases", error);
        }),
      loadScopeResourceList("logs:schemas:view", () => api.listLoggingSchemas())
        .then(setLoggingSchemas)
        .catch((error) => {
          setLoggingSchemas([]);
          reportScopeLoadError("logging schemas", error);
        }),
    ]).then(() => {
      if (active) setResourceListsReady(true);
    });
    return () => {
      active = false;
    };
  }, [accountScopes, fetchCAs]);

  const grantableParsed = useMemo(
    () => parseScopesForForm(preview?.grantableScopes ?? []),
    [preview?.grantableScopes]
  );

  const grantableScopeItems = useMemo(
    () => grantableParsed.baseScopes.map(scopeItem),
    [grantableParsed.baseScopes]
  );
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(preview?.grantableScopes ?? []),
    [preview?.grantableScopes]
  );
  // The request as access lines; the scope picker narrows it.
  const access = useAccessEditor({
    open: preview !== null && accountResolved,
    scopes: defaultScopes,
  });
  const finalSelectedScopes = access.scopes;
  const hasManualApprovalScopes = (preview?.manualApprovalScopes.length ?? 0) > 0;

  const resourceLabel = preview?.resourceInfo.name ?? "Gateway API";
  const redirectHost = useMemo(() => {
    if (!preview?.redirect.uri) return null;
    try {
      return new URL(preview.redirect.uri).host;
    } catch {
      return preview.redirect.uri;
    }
  }, [preview?.redirect.uri]);

  const approve = async () => {
    if (!requestId || finalSelectedScopes.length === 0) return;
    setSubmitting("approve");
    try {
      const result = await api.approveOAuthConsent(requestId, finalSelectedScopes);
      if (preview?.redirect.isExternal) {
        window.location.href = result.redirectUrl;
        return;
      }
      if (!isLoopbackCallbackUrl(result.redirectUrl)) {
        throw new Error("Gateway returned an invalid loopback OAuth callback");
      }
      setResult({ kind: "approved", redirectUrl: result.redirectUrl });
      setSubmitting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization failed");
      setSubmitting(null);
    }
  };

  const deny = async () => {
    if (!requestId) return;
    setSubmitting("deny");
    try {
      const result = await api.denyOAuthConsent(requestId);
      if (preview?.redirect.isExternal) {
        window.location.href = result.redirectUrl;
        return;
      }
      if (!isLoopbackCallbackUrl(result.redirectUrl)) {
        throw new Error("Gateway returned an invalid loopback OAuth callback");
      }
      setResult({ kind: "denied", redirectUrl: result.redirectUrl });
      setSubmitting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not deny authorization");
      setSubmitting(null);
    }
  };

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md border border-border bg-card p-5">
          <h1 className="text-lg font-semibold text-foreground">OAuth authorization failed</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  // The scope list mounts once the account is known, so its pickers load for that account.
  if (!preview || !accountResolved)
    return <AuthWindowLoader label="Loading authorization request..." />;

  if (result) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <iframe
          title="OAuth callback delivery"
          src={result.redirectUrl}
          className="hidden"
          sandbox=""
          aria-hidden="true"
        />
        <div className="w-full max-w-md border border-border bg-card p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted">
              {result.kind === "approved" ? (
                <Check className="h-5 w-5 text-foreground" />
              ) : (
                <X className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Gateway OAuth</p>
              <h1 className="text-lg font-semibold text-foreground">
                {result.kind === "approved" ? "Authorization complete" : "Authorization denied"}
              </h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            The OAuth response was sent to the application. If the application did not finish
            signing in, use the callback button to open the authorization result directly.
          </p>
          <div className="mt-5 flex justify-start">
            <Button asChild>
              <a href={result.redirectUrl} rel="noreferrer">
                Open callback
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Resource and folder pickers change the card's size, so it stays hidden behind the loader
  // until their first load ends.
  const cardReady = (!accountScopes || resourceListsReady) && access.catalog.ready;

  return (
    <>
      {cardReady ? null : <AuthWindowLoader label="Loading authorization request..." />}
      <div
        className="h-[100dvh] overflow-y-auto bg-background px-4 py-4 sm:py-8"
        style={cardReady ? undefined : { visibility: "hidden" }}
        aria-busy={cardReady ? undefined : true}
        data-reveal-phase={cardReady ? "revealed" : "pending"}
        data-oauth-consent-scroll-viewport=""
      >
        <div className="flex min-h-full items-center justify-center">
          <div
            className="flex w-full max-w-2xl flex-col border border-border bg-card"
            data-oauth-consent-card=""
          >
            <div className="border-b border-border p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <img src="/android-chrome-192x192.png" alt="Gateway" className="h-9 w-9" />
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">Gateway OAuth</p>
                      <h1 className="text-xl font-semibold text-foreground">
                        Authorize {resourceLabel} access
                      </h1>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{preview.client.name}</span> is
                    requesting scoped access to{" "}
                    <span className="font-medium text-foreground">{resourceLabel}</span>.
                  </p>
                </div>
                <Badge variant="warning" className="shrink-0">
                  Unverified client
                </Badge>
              </div>
            </div>

            <div className="flex flex-col divide-y divide-border" data-oauth-consent-body="">
              <section className="p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted text-sm font-semibold">
                    {(preview.account.name || preview.account.email).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {preview.account.name ?? preview.account.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {preview.account.email}
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-3 p-5">
                <Notice tone="warning" title="Only authorize tools you trust">
                  Gateway cannot verify this client; it can only enforce the scopes you approve and
                  the permissions your account currently has.
                </Notice>

                {preview.redirect.isExternal && (
                  <Notice tone="destructive" title="External OAuth callback">
                    If you authorize this request, the authorization result will be sent to{" "}
                    {redirectHost ?? "an external callback URL"}.
                  </Notice>
                )}

                {hasManualApprovalScopes && (
                  <Notice tone="destructive" title="Some requested scopes are high-risk">
                    They can reveal sensitive data, export private key material, or perform
                    high-risk operations, and stay out of the access below until you approve them
                    under Review scopes.
                  </Notice>
                )}
              </section>

              <section className="p-5">
                <AccessPanel
                  views={access.views}
                  description={`What ${preview.client.name} asks for.`}
                />
              </section>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-border p-5 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="link"
                className="mr-auto h-auto p-0"
                onClick={() => setScopesOpen(true)}
                disabled={isSubmitting}
              >
                <span data-oauth-consent-scope-count="">
                  Review {finalSelectedScopes.length} scope
                  {finalSelectedScopes.length === 1 ? "" : "s"}
                </span>
              </Button>
              <Button
                variant="outline"
                onClick={deny}
                pending={submitting === "deny"}
                disabled={isSubmitting}
              >
                <X className="h-4 w-4" />
                Deny
              </Button>
              <Button
                onClick={approve}
                pending={submitting === "approve"}
                disabled={isSubmitting || finalSelectedScopes.length === 0}
              >
                <Check className="h-4 w-4" />
                Authorize
              </Button>
            </div>
          </div>
        </div>
      </div>
      <AccessScopesDialog
        open={scopesOpen}
        onOpenChange={setScopesOpen}
        title={`Scopes for ${preview.client.name}`}
        scopes={finalSelectedScopes}
        onApply={access.replaceScopes}
        picker={{
          scopes: grantableScopeItems,
          cas,
          nodes,
          proxyHosts,
          databases,
          loggingSchemas,
          restrictableScopes: RESOURCE_SCOPABLE_SCOPES,
          allowedResourceIds: allowedResourceIdsByScope,
        }}
      />
    </>
  );
}
