import { ExternalLink, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SCOPE_PICKER_VIEWPORT, ScopePicker } from "@/components/common/ScopePicker";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import {
  buildFinalScopes,
  deriveAllowedResourceIdsByScope,
  hasSelectableScopeBase,
  parseScopesForForm,
  requiresResourceSelection,
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
import { API_TOKEN_SCOPES, MCP_TOKEN_SCOPES, RESOURCE_SCOPABLE_SCOPES } from "@/types";

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

function isMcpResource(resource: string): boolean {
  try {
    return new URL(resource).pathname.replace(/\/+$/, "") === "/api/mcp";
  } catch {
    return false;
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
  const [editableBaseScopes, setEditableBaseScopes] = useState<string[]>([]);
  const [editableResourceScopes, setEditableResourceScopes] = useState<Record<string, string[]>>(
    {}
  );
  const [initialResourceLimitedScopes, setInitialResourceLimitedScopes] = useState<string[]>([]);
  const [savingScopes, setSavingScopes] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryValue>(() => currentTokenExpiry(null));
  const [initialExpiry, setInitialExpiry] = useState<ExpiryValue>(() => currentTokenExpiry(null));
  const [allowedIps, setAllowedIps] = useState<string[]>([]);
  const userScopes = useMemo(() => user?.scopes ?? [], [user?.scopes]);
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(userScopes),
    [userScopes]
  );

  const editableScopeCatalog = useMemo(
    () =>
      selectedAuthorization && isMcpResource(selectedAuthorization.resource)
        ? MCP_TOKEN_SCOPES
        : API_TOKEN_SCOPES,
    [selectedAuthorization]
  );
  const finalEditableScopes = useMemo(
    () => buildFinalScopes(editableBaseScopes, editableResourceScopes),
    [editableBaseScopes, editableResourceScopes]
  );
  const scopesChanged = useMemo(() => {
    if (!selectedAuthorization) return false;
    return (
      selectedAuthorization.scopes.slice().sort().join("\n") !== finalEditableScopes.join("\n")
    );
  }, [finalEditableScopes, selectedAuthorization]);
  // The grant's own expiry and addresses are sent (and the expiry checked) only when changed.
  const expiryChanged = !sameExpiry(expiry, initialExpiry);
  const allowedIpsChanged =
    !!selectedAuthorization && !sameAddresses(allowedIps, selectedAuthorization.allowedIps ?? []);
  const expiryInvalid = expiryChanged && expiryError(expiry) !== null;
  const visibleScopes = useMemo(() => {
    return editableScopeCatalog.filter((scope) => {
      return (
        editableBaseScopes.includes(scope.value) || hasSelectableScopeBase(userScopes, scope.value)
      );
    });
  }, [editableBaseScopes, editableScopeCatalog, userScopes]);
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
    const parsed = parseScopesForForm(authorization.scopes);
    setSelectedAuthorization(authorization);
    setEditableBaseScopes(parsed.baseScopes);
    setEditableResourceScopes(parsed.resources);
    setInitialResourceLimitedScopes(Object.keys(parsed.resources));
    resetLimits(authorization);
  };

  const toggleScope = (scope: string) => {
    setEditableBaseScopes((current) => {
      if (current.includes(scope)) {
        setEditableResourceScopes((resources) => {
          const next = { ...resources };
          delete next[scope];
          return next;
        });
        return current.filter((item) => item !== scope);
      }

      const allowedResourceIds = allowedResourceIdsByScope[scope];
      if (allowedResourceIds?.length) {
        setEditableResourceScopes((resources) => ({ ...resources, [scope]: allowedResourceIds }));
      }
      return [...current, scope];
    });
  };

  const toggleResourceScope = (scope: string, resourceId: string) => {
    setEditableResourceScopes((current) => {
      const selected = current[scope] ?? [];
      const hasResource = selected.includes(resourceId);
      return {
        ...current,
        [scope]: hasResource
          ? selected.filter((item) => item !== resourceId)
          : [...selected, resourceId],
      };
    });
  };

  const saveScopes = async () => {
    if (!selectedAuthorization || finalEditableScopes.length === 0 || expiryInvalid) return;
    for (const scope of editableBaseScopes) {
      if (
        requiresResourceSelection(scope, allowedResourceIdsByScope, initialResourceLimitedScopes) &&
        (editableResourceScopes[scope]?.length ?? 0) === 0
      ) {
        toast.error(`Select at least one resource for ${scope}`);
        return;
      }
    }
    setSavingScopes(true);
    try {
      const updated = await api.updateOAuthAuthorization(selectedAuthorization.id, {
        ...(scopesChanged ? { scopes: finalEditableScopes } : {}),
        ...(expiryChanged ? { expiresAt: expiryRequestValue(expiry) } : {}),
        ...(allowedIpsChanged ? { allowedIps } : {}),
      });
      setAuthorizations((current) => {
        const next = current.map((item) => (item.id === updated.id ? updated : item));
        api.setCache("settings:oauth-authorizations", next);
        return next;
      });
      const parsed = parseScopesForForm(updated.scopes);
      setSelectedAuthorization(updated);
      setEditableBaseScopes(parsed.baseScopes);
      setEditableResourceScopes(parsed.resources);
      setInitialResourceLimitedScopes(Object.keys(parsed.resources));
      resetLimits(updated);
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
        <DialogContent className="sm:max-w-2xl">
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

              {/* One line of facts, so the scope list keeps the room in a laptop window. */}
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

              <ScopePicker
                header={<span className="text-sm font-medium">Scopes</span>}
                scopes={visibleScopes}
                selected={editableBaseScopes}
                onToggle={toggleScope}
                resources={editableResourceScopes}
                onResourcesChange={setEditableResourceScopes}
                onToggleResource={toggleResourceScope}
                cas={cas}
                nodes={nodesList}
                proxyHosts={proxyHostsList}
                databases={databasesList}
                loggingSchemas={loggingSchemasList}
                restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
                allowedResourceIds={allowedResourceIdsByScope}
                viewportClassName={SCOPE_PICKER_VIEWPORT}
                footer={`${finalEditableScopes.length} scope${finalEditableScopes.length !== 1 ? "s" : ""}`}
              />
            </div>
          )}
          {selectedAuthorization && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setSelectedAuthorization(null)}>
                Close
              </Button>
              <Button
                onClick={() => void saveScopes()}
                pending={savingScopes}
                disabled={
                  !(scopesChanged || expiryChanged || allowedIpsChanged) ||
                  finalEditableScopes.length === 0 ||
                  expiryInvalid
                }
              >
                Save
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
