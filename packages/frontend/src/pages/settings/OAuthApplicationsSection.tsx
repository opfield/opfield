import { ExternalLink, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AccessDialogFooter } from "@/components/access/AccessDialogFooter";
import { AccessSection } from "@/components/access/AccessSection";
import { useAccessEditor } from "@/components/access/use-access-editor";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
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
  sameAddresses,
  sameExpiry,
  TokenLimitsMeta,
} from "@/components/common/TokenLimitFields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import {
  deriveAllowedResourceIdsByScope,
  hasSelectableScopeBase,
  parseScopesForForm,
} from "@/lib/scope-utils";
import { formatDate } from "@/lib/utils";
import { api } from "@/services/api";
import { oauthAuthorizationChangedChannel } from "@/services/user-resource-events";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import type {
  DatabaseConnection,
  LoggingSchema,
  Node,
  OAuthAuthorization,
  ProxyHost,
} from "@/types";
import { MCP_TOKEN_SCOPES, RESOURCE_SCOPABLE_SCOPES } from "@/types";

const NO_SCOPES: string[] = [];

interface OAuthApplicationsSectionProps {
  nodesList: Node[];
  proxyHostsList: ProxyHost[];
  databasesList: DatabaseConnection[];
  loggingSchemasList: LoggingSchema[];
  /** The resource lists above are still loading; the details dialog waits for them. */
  resourceListsLoading?: boolean;
}

/** Reports a load to the enclosing dialog while rendered inside its content. */
function ReportLoading({ loading }: { loading: boolean }) {
  useContentLoading(loading);
  return null;
}

function resourceLabel(resource: string): string {
  try {
    const url = new URL(resource);
    if (url.pathname === "/api") return "Opfield API";
    if (url.pathname === "/api/mcp") return "Opfield MCP";
    return url.pathname || url.host;
  } catch {
    return resource;
  }
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export function OAuthApplicationsSection({
  nodesList,
  proxyHostsList,
  databasesList,
  loggingSchemasList,
  resourceListsLoading = false,
}: OAuthApplicationsSectionProps) {
  const { cas } = useCAStore();
  const { user } = useAuthStore();
  const [authorizations, setAuthorizations] = useState<OAuthAuthorization[]>(
    () => api.getCached<OAuthAuthorization[]>("settings:oauth-authorizations") ?? []
  );
  const [loading, setLoading] = useState(
    () => api.getCached<OAuthAuthorization[]>("settings:oauth-authorizations") === undefined
  );
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  const {
    open: authorizationOpen,
    value: storedAuthorization,
    setValue: setSelectedAuthorization,
    onOpenChange: onAuthorizationOpenChange,
  } = useDeferredDialogState<OAuthAuthorization>();
  // The dialog shows the last application until it opens again, not only for the close delay.
  const selectedAuthorization = useRetainedDialogValue(storedAuthorization, authorizationOpen);
  const [scopesOpen, setScopesOpen] = useState(false);
  const [savingScopes, setSavingScopes] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryValue>(() => currentTokenExpiry(null));
  const [initialExpiry, setInitialExpiry] = useState<ExpiryValue>(() => currentTokenExpiry(null));
  const [allowedIps, setAllowedIps] = useState<string[]>([]);
  const userScopes = useMemo(() => user?.scopes ?? [], [user?.scopes]);
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(userScopes),
    [userScopes]
  );

  // The grant as access lines, bounded by the user's own access the way a token is: a line wider
  // than the user saves as the user's part of it (its note says so), as Opfield bounds the grant.
  const access = useAccessEditor({
    open: authorizationOpen,
    scopes: selectedAuthorization?.scopes ?? NO_SCOPES,
    ownerScopes: userScopes,
  });
  // The grant's own expiry and addresses are sent (and the expiry checked) only when changed.
  const expiryChanged = !sameExpiry(expiry, initialExpiry);
  const allowedIpsChanged =
    !!selectedAuthorization && !sameAddresses(allowedIps, selectedAuthorization.allowedIps ?? []);
  const expiryInvalid = expiryChanged && expiryError(expiry) !== null;
  const selectedBaseScopes = new Set(parseScopesForForm(access.scopes).baseScopes);
  const selectedLogoUri = safeHttpUrl(selectedAuthorization?.logoUri);

  const load = useCallback(async () => {
    try {
      const data = await api.listOAuthAuthorizations();
      api.setCache("settings:oauth-authorizations", data ?? []);
      setAuthorizations(data);
    } catch (error) {
      toastApiError(error, "Failed to load OAuth applications");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(user?.id ? oauthAuthorizationChangedChannel(user.id) : null, () => void load(), {
    onReconnect: load,
  });

  const resetLimits = (authorization: OAuthAuthorization) => {
    const current = currentTokenExpiry(authorization.grantExpiresAt);
    setExpiry(current);
    setInitialExpiry(current);
    setAllowedIps(authorization.allowedIps ?? []);
  };

  const openDetails = (authorization: OAuthAuthorization) => {
    setSelectedAuthorization(authorization);
    resetLimits(authorization);
  };

  const saveScopes = async () => {
    if (!selectedAuthorization || access.scopes.length === 0 || expiryInvalid) return;
    setSavingScopes(true);
    try {
      const updated = await api.updateOAuthAuthorization(selectedAuthorization.id, {
        ...(access.changed ? { scopes: access.scopes } : {}),
        ...(expiryChanged ? { expiresAt: expiryRequestValue(expiry) } : {}),
        ...(allowedIpsChanged ? { allowedIps } : {}),
      });
      setAuthorizations((current) => {
        const next = current.map((item) => (item.id === updated.id ? updated : item));
        api.setCache("settings:oauth-authorizations", next);
        return next;
      });
      // Like a token: saved and closed; the next opening reads the grant as Opfield stored it.
      setSelectedAuthorization(null);
      toast.success("OAuth application updated");
    } catch (error) {
      toastApiError(error, "Failed to update OAuth application");
    } finally {
      setSavingScopes(false);
    }
  };

  const disconnect = async (authorization: OAuthAuthorization) => {
    const ok = await confirm({
      title: "Disconnect OAuth Application",
      description: `Revoke OAuth access for "${authorization.clientName}"? Existing OAuth tokens for this application will stop working.`,
      confirmLabel: "Disconnect",
      variant: "destructive",
    });
    if (!ok) return;

    const key = authorization.id;
    setRevokingKey(key);
    try {
      await api.revokeOAuthAuthorization(authorization.id);
      setAuthorizations((current) => {
        const next = current.filter((item) => item.id !== authorization.id);
        api.setCache("settings:oauth-authorizations", next);
        return next;
      });
      if (selectedAuthorization?.id === authorization.id) {
        setSelectedAuthorization(null);
      }
      toast.success("OAuth application disconnected");
    } catch (error) {
      toastApiError(error, "Failed to disconnect application");
    } finally {
      setRevokingKey(null);
    }
  };

  useContentLoading(loading);

  return (
    <>
      <PanelShell
        title="OAuth Applications"
        description="Applications you authorized to access Opfield with your account"
        icon={<ShieldCheck className="h-4 w-4" />}
      >
        {loading ? null : authorizations.length === 0 ? (
          <EmptyState message="No OAuth applications authorized yet." embedded />
        ) : (
          <div className="divide-y divide-border">
            {authorizations.map((authorization) => (
              <div
                key={authorization.id}
                className="flex cursor-pointer items-center justify-between gap-3 p-4 transition-colors hover:bg-accent/50 sm:gap-4"
                onClick={() => openDetails(authorization)}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                    {safeHttpUrl(authorization.logoUri) ? (
                      <img
                        src={safeHttpUrl(authorization.logoUri)!}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">
                        {authorization.clientName}
                      </p>
                      <Badge variant="secondary" size="inline">
                        {resourceLabel(authorization.resource)}
                      </Badge>
                      {safeHttpUrl(authorization.clientUri) && (
                        <a
                          href={safeHttpUrl(authorization.clientUri)!}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Website
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Authorized <RelativeTime value={authorization.createdAt} />
                      {authorization.lastUsedAt && (
                        <>
                          {" · Last used "}
                          <RelativeTime value={authorization.lastUsedAt} />
                        </>
                      )}
                      {authorization.expiresAt
                        ? ` · Expires ${formatDate(authorization.expiresAt)}`
                        : " · No expiry"}
                      {` · Scopes: ${authorization.scopes.length}`}
                      <TokenLimitsMeta withExpiry={false} allowedIps={authorization.allowedIps} />
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Disconnect ${authorization.clientName}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void disconnect(authorization);
                  }}
                  pending={revokingKey === authorization.id}
                >
                  {revokingKey === authorization.id ? null : <Trash2 className="h-4 w-4" />}
                </Button>
              </div>
            ))}
          </div>
        )}
      </PanelShell>

      <Dialog open={authorizationOpen} onOpenChange={onAuthorizationOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>OAuth Application</DialogTitle>
          </DialogHeader>
          <DialogDescription>View and edit authorized application access</DialogDescription>

          {selectedAuthorization && (
            <div className="space-y-4">
              <ReportLoading loading={resourceListsLoading} />
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                  {selectedLogoUri ? (
                    <img src={selectedLogoUri} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {selectedAuthorization.clientName}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {selectedAuthorization.clientId}
                  </p>
                </div>
              </div>

              {/* One line of facts, so the access list keeps the room in a laptop window. */}
              <p className="text-xs text-muted-foreground">
                Authorized <RelativeTime value={selectedAuthorization.createdAt} /> · Last used{" "}
                <RelativeTime value={selectedAuthorization.lastUsedAt} fallback="Never" /> ·{" "}
                {selectedAuthorization.expiresAt
                  ? `Expires ${formatDate(selectedAuthorization.expiresAt)}`
                  : "No expiry"}{" "}
                · {selectedAuthorization.activeRefreshTokens} refresh grant
                {selectedAuthorization.activeRefreshTokens !== 1 ? "s" : ""} ·{" "}
                {[...new Set([selectedAuthorization.resource, ...selectedAuthorization.resources])]
                  .map(resourceLabel)
                  .join(", ")}
              </p>

              <ExpiryField value={expiry} onChange={setExpiry} showError={expiryChanged} />
              <AllowedAddressesRow value={allowedIps} onChange={setAllowedIps} />

              <AccessSection
                editor={access}
                subject={selectedAuthorization.clientName}
                description="Never more than you can do."
                mode={{ kind: "token", ownerScopes: userScopes }}
                scopesOpen={scopesOpen}
                onScopesOpenChange={setScopesOpen}
                picker={{
                  // A grant never carries mcp:use (MCP access comes from the account), so neither
                  // an API nor an MCP grant offers it.
                  scopes: MCP_TOKEN_SCOPES.filter(
                    (scope) =>
                      selectedBaseScopes.has(scope.value) ||
                      hasSelectableScopeBase(userScopes, scope.value)
                  ),
                  cas,
                  nodes: nodesList,
                  proxyHosts: proxyHostsList,
                  databases: databasesList,
                  loggingSchemas: loggingSchemasList,
                  restrictableScopes: RESOURCE_SCOPABLE_SCOPES,
                  allowedResourceIds: allowedResourceIdsByScope,
                }}
              />
            </div>
          )}
          {selectedAuthorization && (
            <AccessDialogFooter
              scopeCount={access.scopes.length}
              onReviewScopes={() => setScopesOpen(true)}
            >
              <Button variant="outline" onClick={() => setSelectedAuthorization(null)}>
                Close
              </Button>
              <Button
                onClick={() => void saveScopes()}
                pending={savingScopes}
                disabled={
                  !(access.changed || expiryChanged || allowedIpsChanged) ||
                  access.scopes.length === 0 ||
                  expiryInvalid
                }
              >
                Save
              </Button>
            </AccessDialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
