import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  ArrowRight,
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
  type LucideIcon,
  Monitor,
  MonitorSmartphone,
  Moon,
  Pencil,
  Plus,
  Printer,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Tablet,
  Trash2,
  UserRound,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AvatarCropDialog } from "@/components/common/AvatarCropDialog";
import { CopyButton } from "@/components/common/CopyButton";
import { CopyValueField } from "@/components/common/CopyValueField";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { PoweredByFooter } from "@/components/common/PoweredByFooter";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import {
  allResourcePages,
  loadScopeResourceList,
  reportScopeLoadError,
} from "@/components/common/scope-list-helpers";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDialogPresence,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import {
  AI_APPROVAL_MODE_META,
  AI_APPROVAL_MODES,
  type AIApprovalMode,
} from "@/lib/ai-approval-mode";
import {
  confirmBypassEverythingMode,
  updateAIApprovalModeOptimistically,
} from "@/lib/ai-user-preferences";
import { toastApiError } from "@/lib/api-error-toast";
import { deriveAllowedResourceIdsByScope, scopeMatches } from "@/lib/scope-utils";
import { cn, getInitials } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import {
  AI_SCOPE,
  type BrowserSession,
  type DatabaseConnection,
  type LoggingSchema,
  type Node,
  type ProxyHost,
} from "@/types";
import type { InferenceSelfUsage, InferenceUsageOverview } from "@/types/inference";
import { InferenceTokensSection } from "./inference/InferenceTokensSection";
import { InferenceUsage } from "./inference/InferenceUsagePanels";
import { ApiTokensSection } from "./settings/ApiTokensSection";
import { InferenceHarnessDialog } from "./settings/inference/InferenceEndpointSettingsPanel";
import { OAuthApplicationsSection } from "./settings/OAuthApplicationsSection";

const PROFILE_TABS = ["preferences", "authorizations"] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

const DEV_INFERENCE_USAGE: InferenceSelfUsage = {
  enabled: true,
  api: {
    configured: true,
    percentage: 41,
    recoveryAt: new Date(Date.now() + 86400000).toISOString(),
  },
  subscription: {
    "5h": {
      configured: true,
      percentage: 37,
      recoveryAt: new Date(Date.now() + 3600000).toISOString(),
    },
    "7d": {
      configured: true,
      percentage: 58,
      recoveryAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
    "30d": {
      configured: true,
      percentage: 22,
      recoveryAt: new Date(Date.now() + 12 * 86400000).toISOString(),
    },
  },
};

function createDevInferenceOverview(): InferenceUsageOverview {
  const dailyUsage = Array.from({ length: 30 }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (29 - index));
    const activity = index < 20 ? 0 : (index - 19) * 3;
    return {
      date: date.toISOString().slice(0, 10),
      requests: activity,
      credits: activity * 0.34,
      apiMicrodollars: activity * 1250,
      tokens: activity * 4800,
    };
  });
  const totals = dailyUsage.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      credits: sum.credits + row.credits,
      apiMicrodollars: sum.apiMicrodollars + row.apiMicrodollars,
      tokens: sum.tokens + row.tokens,
    }),
    { requests: 0, credits: 0, apiMicrodollars: 0, tokens: 0 }
  );
  return {
    windowDays: 30,
    requestTotals: [
      {
        status: "completed",
        requests: totals.requests,
        credits: String(totals.credits),
        apiMicrodollars: totals.apiMicrodollars,
        tokens: totals.tokens,
      },
    ],
    ledgerTotals: [
      {
        budgetType: "subscription",
        credits: String(totals.credits),
        apiMicrodollars: totals.apiMicrodollars,
        tokens: totals.tokens,
      },
    ],
    dailyUsage,
  };
}

const DEV_INFERENCE_OVERVIEW = createDevInferenceOverview();

function isProfileTab(value: string | null | undefined): value is ProfileTab {
  return PROFILE_TABS.includes(value as ProfileTab);
}

export function Profile() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { user, hasScope, setUser } = useAuthStore();
  const {
    theme,
    setTheme,
    showUpdateNotifications,
    setShowUpdateNotifications,
    showSystemCertificates,
    setShowSystemCertificates,
    aiApprovalMode,
  } = useUIStore();
  const [nodesList, setNodesList] = useState<Node[]>([]);
  const [proxyHostsList, setProxyHostsList] = useState<ProxyHost[]>([]);
  const [databasesList, setDatabasesList] = useState<DatabaseConnection[]>([]);
  const [loggingSchemasList, setLoggingSchemasList] = useState<LoggingSchema[]>([]);
  const [resourceListsLoading, setResourceListsLoading] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const shownAvatarFile = useRetainedDialogValue(avatarFile, avatarFile !== null);
  const [inferenceHarnessDevOpen, setInferenceHarnessDevOpen] = useState(false);
  const [inferenceProfileDevPreview, setInferenceProfileDevPreview] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const activeTab: ProfileTab = isProfileTab(tabParam) ? tabParam : "preferences";
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);

  const canUseAI = hasScope(AI_SCOPE);
  const canUseInference = inferenceEnabled && hasScope("feat:ai:use");
  const canManageInferenceTokens = hasScope("feat:ai:use");
  const canViewSystemCertificates = hasScope("admin:details:certificates");
  const userScopes = user?.scopes;

  useEffect(() => {
    if (tabParam && !isProfileTab(tabParam)) {
      navigate("/profile", { replace: true });
    }
  }, [navigate, tabParam]);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const gatewayDev = (window.gatewayDev ??= {});
    const openInferenceHarnessModal = () => setInferenceHarnessDevOpen(true);
    const showInferenceProfile = () => {
      setInferenceProfileDevPreview(true);
      navigate("/profile");
    };
    gatewayDev.openInferenceHarnessModal = openInferenceHarnessModal;
    gatewayDev.showInferenceProfile = showInferenceProfile;
    return () => {
      if (gatewayDev.openInferenceHarnessModal === openInferenceHarnessModal) {
        delete gatewayDev.openInferenceHarnessModal;
      }
      if (gatewayDev.showInferenceProfile === showInferenceProfile) {
        delete gatewayDev.showInferenceProfile;
      }
    };
  }, [navigate]);

  // Resource pickers of the token and OAuth dialogs; a dialog opened before
  // they arrive waits for them instead of filling in while open.
  useEffect(() => {
    if (activeTab !== "authorizations") return;
    let active = true;
    setResourceListsLoading(true);

    const loads: Promise<unknown>[] = [
      loadScopeResourceList("nodes:details", () =>
        allResourcePages((page) => api.listNodes({ page, limit: 100 }))
      )
        .then(setNodesList)
        .catch((error) => {
          setNodesList([]);
          reportScopeLoadError("nodes", error);
        }),
      loadScopeResourceList("proxy:view", () =>
        allResourcePages((page) => api.listProxyHosts({ page, limit: 100 }))
      )
        .then(setProxyHostsList)
        .catch((error) => {
          setProxyHostsList([]);
          reportScopeLoadError("routes", error);
        }),
      loadScopeResourceList("databases:view", () =>
        allResourcePages((page) => api.listDatabases({ page, limit: 100 }))
      )
        .then(setDatabasesList)
        .catch((error) => {
          setDatabasesList([]);
          reportScopeLoadError("databases", error);
        }),
    ];
    if (
      scopeMatches(userScopes ?? [], "logs:schemas:view") ||
      (deriveAllowedResourceIdsByScope(userScopes ?? [])["logs:schemas:view"]?.length ?? 0) > 0
    ) {
      loads.push(
        loadScopeResourceList("logs:schemas:view", () => api.listLoggingSchemas())
          .then(setLoggingSchemasList)
          .catch((error) => {
            setLoggingSchemasList([]);
            reportScopeLoadError("logging schemas", error);
          })
      );
    }
    void Promise.allSettled(loads).then(() => {
      if (active) setResourceListsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [activeTab, userScopes]);

  const handleToggleSystemCertificates = (checked: boolean) => {
    setShowSystemCertificates(checked);
    api.invalidateCache("req:/api/cas");
    api.invalidateCache("req:/api/certificates");
    api.invalidateCache("req:/api/ssl-certificates");
    api.invalidateCache("req:/api/monitoring/dashboard");
    api.invalidateCache("cas:list:");
    api.invalidateCache("certificates:list:");
    api.invalidateCache("ssl:list:");
    api.invalidateCache("dashboard:stats:");
  };

  const handleAIApprovalModeChange = async (mode: AIApprovalMode) => {
    if (mode === aiApprovalMode) return;
    if (
      mode === "bypass-everything" &&
      aiApprovalMode !== "bypass-everything" &&
      !(await confirmBypassEverythingMode())
    ) {
      return;
    }

    try {
      await updateAIApprovalModeOptimistically(mode, aiApprovalMode);
    } catch (error) {
      toastApiError(error, "Failed to update AI mode");
    }
  };

  const updateAvatar = async (avatar: Blob | null) => {
    setAvatarUploading(true);
    try {
      const updatedUser = await api.updateCurrentUserAvatar(avatar);
      setUser(updatedUser);
      toast.success(avatar ? "Avatar updated" : "Avatar removed");
      return true;
    } catch (error) {
      toastApiError(error, "Failed to update avatar");
      return false;
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    if (!SUPPORTED_AVATAR_TYPES.has(file.type)) {
      toast.error("Choose a PNG, JPEG, or WebP image");
      return;
    }
    if (file.size > MAX_AVATAR_SOURCE_BYTES) {
      toast.error("Choose an image no larger than 25 MiB");
      return;
    }
    setAvatarFile(file);
  };

  const handleTabChange = (value: string) => {
    navigate(value === "preferences" ? "/profile" : "/profile/authorizations");
  };

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <PageHeader
          title="Profile"
          description="Personal settings and authorizations"
          leading={<LiteModeBackButton />}
        />

        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="preferences" className="gap-1.5">
              Preferences
            </TabsTrigger>
            <TabsTrigger value="authorizations" className="gap-1.5">
              Authorizations
            </TabsTrigger>
          </TabsList>

          <TabsContent value="preferences" className="pb-0">
            <div className="space-y-4">
              <PanelShell title="Profile" icon={<UserRound className="h-4 w-4" />}>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  aria-label="Choose avatar image"
                  onChange={(event) => {
                    void handleAvatarFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                {user && (
                  <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                    {/* The avatar itself is the control; its overlay shows the action. */}
                    <button
                      type="button"
                      aria-label={user.avatarUrl ? "Remove avatar" : "Change avatar"}
                      className="group relative h-10 w-10 shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      disabled={avatarUploading}
                      onClick={() => {
                        if (user.avatarUrl) {
                          void updateAvatar(null);
                          return;
                        }
                        avatarInputRef.current?.click();
                      }}
                    >
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={user.avatarUrl ?? undefined} />
                        <AvatarFallback className="text-sm">
                          {getInitials(user.name || user.email)}
                        </AvatarFallback>
                      </Avatar>
                      <span
                        className={cn(
                          "absolute inset-0 flex items-center justify-center bg-scrim/60 text-on-scrim opacity-0 transition-opacity",
                          "group-hover:opacity-100 group-focus-visible:opacity-100",
                          avatarUploading && "opacity-100"
                        )}
                      >
                        {avatarUploading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : user.avatarUrl ? (
                          <Trash2 className="h-4 w-4" />
                        ) : (
                          <Pencil className="h-4 w-4" />
                        )}
                      </span>
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{user.name || "Not set"}</p>
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
                      <Badge variant="secondary" size="inline">
                        {user.groupName}
                      </Badge>
                    </div>
                  </div>
                )}
              </PanelShell>

              <AvatarCropDialog
                file={shownAvatarFile}
                open={avatarFile !== null}
                uploading={avatarUploading}
                onOpenChange={(open) => {
                  if (!open) setAvatarFile(null);
                }}
                onUpload={updateAvatar}
              />

              {user?.authMethod !== "oidc" && <LocalAccountSecurityPanel />}

              {(canUseInference || inferenceProfileDevPreview) && (
                <InferenceUsage
                  previewUsage={inferenceProfileDevPreview ? DEV_INFERENCE_USAGE : undefined}
                  previewOverview={inferenceProfileDevPreview ? DEV_INFERENCE_OVERVIEW : undefined}
                />
              )}

              <PanelShell title="Preferences" icon={<SlidersHorizontal className="h-4 w-4" />}>
                <div className="divide-y divide-border">
                  <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div>
                      <p className="text-sm font-medium">Theme</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Choose how the interface looks
                      </p>
                    </div>
                    {/* Segmented theme switch, styled like the tab list. */}
                    <div className="flex w-fit shrink-0 gap-0 border border-border">
                      {(["light", "dark", "system"] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setTheme(value)}
                          className={`flex items-center gap-2 px-4 py-2 text-sm capitalize transition-colors ${
                            theme === value
                              ? "bg-primary text-primary-foreground"
                              : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          {value === "light" && <Sun className="h-3.5 w-3.5" />}
                          {value === "dark" && <Moon className="h-3.5 w-3.5" />}
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">Update notifications</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Show update banners in sidebar and dashboard
                      </p>
                    </div>
                    <Switch
                      checked={showUpdateNotifications}
                      onChange={setShowUpdateNotifications}
                    />
                  </div>
                  {canViewSystemCertificates && (
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">
                          <SettingsHelpTitle
                            label="Show system certificates"
                            help="Includes Opfield-managed internal PKI and SSL certificates in certificate lists and dashboard totals. Hiding them does not disable or delete any certificate."
                          />
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Include internal PKI and SSL certificates in lists and dashboard counts
                        </p>
                      </div>
                      <Switch
                        checked={showSystemCertificates}
                        onChange={handleToggleSystemCertificates}
                      />
                    </div>
                  )}
                  {canUseAI && (
                    <AIApprovalModeRow
                      value={aiApprovalMode}
                      onChange={handleAIApprovalModeChange}
                    />
                  )}
                </div>
              </PanelShell>
              <PoweredByFooter />
            </div>
          </TabsContent>

          <TabsContent value="authorizations" className="pb-0">
            <div className="space-y-4">
              <ApiTokensSection
                user={user}
                nodesList={nodesList}
                proxyHostsList={proxyHostsList}
                databasesList={databasesList}
                loggingSchemasList={loggingSchemasList}
                resourceListsLoading={resourceListsLoading}
              />
              <OAuthApplicationsSection
                nodesList={nodesList}
                proxyHostsList={proxyHostsList}
                databasesList={databasesList}
                loggingSchemasList={loggingSchemasList}
                resourceListsLoading={resourceListsLoading}
              />
              {canUseInference && <InferenceTokensSection canManage={canManageInferenceTokens} />}
              <BrowserSessionsPanel />
              <PoweredByFooter />
            </div>
          </TabsContent>
        </Tabs>
      </div>
      <InferenceHarnessDialog
        open={inferenceHarnessDevOpen}
        onOpenChange={setInferenceHarnessDevOpen}
      />
    </PageTransition>
  );
}

const MAX_AVATAR_SOURCE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function BrowserSessionsPanel() {
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const hasOtherSessions = sessions.some((session) => !session.isCurrent);
  useContentLoading(loading);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(await api.listCurrentUserSessions());
    } catch (error) {
      toastApiError(error, "Failed to load active sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setRevokingId(id);
    try {
      await api.revokeCurrentUserSession(id);
      setSessions((current) => current.filter((session) => session.id !== id));
      toast.success("Session revoked");
    } catch (error) {
      toastApiError(error, "Failed to revoke session");
    } finally {
      setRevokingId(null);
    }
  };

  const revokeOthers = async () => {
    setRevokingOthers(true);
    try {
      const count = await api.revokeOtherCurrentUserSessions();
      setSessions((current) => current.filter((session) => session.isCurrent));
      toast.success(count === 1 ? "One other session revoked" : `${count} other sessions revoked`);
    } catch (error) {
      toastApiError(error, "Failed to revoke sessions");
    } finally {
      setRevokingOthers(false);
    }
  };

  return (
    <PanelShell
      title="Active sessions"
      description="Browser sessions currently authorized for this account"
      icon={<MonitorSmartphone className="h-4 w-4" />}
      actions={
        hasOtherSessions ? (
          <Button
            variant="outline"
            onClick={revokeOthers}
            pending={revokingOthers}
            disabled={loading}
          >
            Sign out other sessions
          </Button>
        ) : null
      }
    >
      <div className="divide-y divide-border">
        {loading ? null : sessions.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No active browser sessions</p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
                session.isCurrent && hasOtherSessions && "bg-muted/60 dark:bg-muted"
              )}
            >
              <div className="flex min-w-0 items-center gap-4">
                <SessionDeviceIcon
                  userAgent={session.userAgent}
                  inverted={session.isCurrent && hasOtherSessions}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {session.isCurrent ? "This browser" : sessionBrowserLabel(session.userAgent)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {session.authMethod.replace("_", " ")} · {session.ipAddress || "Unknown IP"} ·
                    Last active <RelativeTime value={session.lastSeenAt} />
                  </p>
                </div>
              </div>
              {!session.isCurrent && (
                <Button
                  variant="outline"
                  size="icon"
                  pending={revokingId === session.id}
                  onClick={() => revoke(session.id)}
                  aria-label={`Revoke session from ${session.userAgent ? sessionBrowserLabel(session.userAgent) : session.ipAddress || "unknown browser"}`}
                  title="Revoke session"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </PanelShell>
  );
}

function SessionDeviceIcon({
  userAgent,
  inverted,
}: {
  userAgent: string | null;
  inverted: boolean;
}) {
  const { Icon, label } = sessionDeviceFromUserAgent(userAgent);
  return (
    <span
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center",
        inverted ? "bg-card" : "bg-muted"
      )}
      title={label}
    >
      <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}

function sessionDeviceFromUserAgent(userAgent: string | null): {
  Icon: LucideIcon;
  label: string;
} {
  if (!userAgent) return { Icon: Monitor, label: "Unknown device" };
  if (/iPad|Tablet|PlayBook|Silk\//i.test(userAgent)) return { Icon: Tablet, label: "Tablet" };
  if (/Mobi|Android.*Mobile|iPhone|iPod|Windows Phone/i.test(userAgent)) {
    return { Icon: Smartphone, label: "Phone" };
  }
  return { Icon: Monitor, label: "Desktop computer" };
}

function sessionBrowserLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";

  const browser = /Edg\//i.test(userAgent)
    ? "Microsoft Edge"
    : /OPR\//i.test(userAgent)
      ? "Opera"
      : /Chrome\//i.test(userAgent)
        ? "Chrome"
        : /Firefox\//i.test(userAgent)
          ? "Firefox"
          : /Version\/.*Safari\//i.test(userAgent)
            ? "Safari"
            : null;
  const platform = /iPhone|iPad/i.test(userAgent)
    ? "iOS"
    : /Android/i.test(userAgent)
      ? "Android"
      : /Macintosh/i.test(userAgent)
        ? "macOS"
        : /Windows/i.test(userAgent)
          ? "Windows"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : null;

  if (browser && platform) return `${browser} on ${platform}`;
  return browser || "Unknown browser";
}

function LocalAccountSecurityPanel() {
  const [status, setStatus] = useState<{
    totpConfigured: boolean;
    passkeyCount: number;
    recoveryCodeCount: number;
  } | null>(null);
  const [passkeys, setPasskeys] = useState<
    Array<{ id: string; name: string; lastUsedAt: string | null; createdAt: string }>
  >([]);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [passkeysSearch, setPasskeysSearch] = useState("");
  const passkeysPresent = useDialogPresence(passkeysOpen);
  // Reset once the close animation has played, so the closing dialog keeps its content.
  useEffect(() => {
    if (!passkeysPresent) setPasskeysSearch("");
  }, [passkeysPresent]);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [removingPasskeyId, setRemovingPasskeyId] = useState<string | null>(null);
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpSaving, setTotpSaving] = useState(false);
  const [totpResetOpen, setTotpResetOpen] = useState(false);
  const [totpResetting, setTotpResetting] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryCodesOpen, setRecoveryCodesOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpCode, setStepUpCode] = useState("");
  const [stepUpUseRecoveryCode, setStepUpUseRecoveryCode] = useState(false);
  // The step-up check in flight: an authenticator/recovery code or a passkey.
  const [stepUpBusy, setStepUpBusy] = useState<"code" | "passkey" | null>(null);
  const totpCloseTimer = useRef<number | null>(null);
  const recoveryCodesCloseTimer = useRef<number | null>(null);
  const pendingRecoveryCodes = useRef<string[] | null>(null);
  const pendingStepUpAction = useRef<(() => Promise<void>) | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextPasskeys] = await Promise.all([
        api.getCurrentUserMfaStatus(),
        api.listCurrentUserPasskeys(),
      ]);
      setStatus(nextStatus);
      setPasskeys(nextPasskeys);
    } catch (error) {
      toastApiError(error, "Failed to load account security settings");
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useContentLoading(!statusLoaded);

  useEffect(
    () => () => {
      if (totpCloseTimer.current !== null) window.clearTimeout(totpCloseTimer.current);
      if (recoveryCodesCloseTimer.current !== null) {
        window.clearTimeout(recoveryCodesCloseTimer.current);
      }
    },
    []
  );

  const filteredPasskeys = useMemo(() => {
    const query = passkeysSearch.trim().toLocaleLowerCase();
    if (!query) return passkeys;
    return passkeys.filter((passkey) => passkey.name.toLocaleLowerCase().includes(query));
  }, [passkeys, passkeysSearch]);

  const openRecoveryCodes = (codes: string[]) => {
    if (recoveryCodesCloseTimer.current !== null) {
      window.clearTimeout(recoveryCodesCloseTimer.current);
      recoveryCodesCloseTimer.current = null;
    }
    setRecoveryCodes(codes);
    setRecoveryCodesOpen(true);
  };

  const closeRecoveryCodes = () => {
    setRecoveryCodesOpen(false);
    if (recoveryCodesCloseTimer.current !== null) {
      window.clearTimeout(recoveryCodesCloseTimer.current);
    }
    recoveryCodesCloseTimer.current = window.setTimeout(() => {
      setRecoveryCodes(null);
      recoveryCodesCloseTimer.current = null;
    }, 250);
  };

  const finishTotpSetupClose = () => {
    if (totpCloseTimer.current !== null) window.clearTimeout(totpCloseTimer.current);
    totpCloseTimer.current = window.setTimeout(() => {
      setTotpSetup(null);
      setTotpCode("");
      if (pendingRecoveryCodes.current) {
        openRecoveryCodes(pendingRecoveryCodes.current);
        pendingRecoveryCodes.current = null;
      }
      totpCloseTimer.current = null;
    }, 250);
  };

  const closeTotpSetup = () => {
    setTotpSetupOpen(false);
    finishTotpSetupClose();
  };

  // Changing second factors requires a fresh proof of an existing one. The
  // server answers MFA_STEP_UP_REQUIRED; ask for it, then retry the action.
  const requestStepUp = (retry: () => Promise<void>) => {
    pendingStepUpAction.current = retry;
    setStepUpCode("");
    setStepUpUseRecoveryCode(false);
    setStepUpOpen(true);
  };

  const cancelStepUp = () => {
    pendingStepUpAction.current = null;
    setStepUpOpen(false);
  };

  const completeStepUp = async () => {
    const retry = pendingStepUpAction.current;
    pendingStepUpAction.current = null;
    setStepUpOpen(false);
    if (retry) await retry();
  };

  const verifyStepUpCode = async () => {
    setStepUpBusy("code");
    try {
      await api.verifyCurrentUserStepUp(
        stepUpUseRecoveryCode ? { recoveryCode: stepUpCode.trim() } : { totpCode: stepUpCode }
      );
    } catch (error) {
      toastApiError(error, "Invalid authentication code");
      setStepUpBusy(null);
      return;
    }
    setStepUpBusy(null);
    await completeStepUp();
  };

  const verifyStepUpPasskey = async () => {
    setStepUpBusy("passkey");
    try {
      const options = await api.beginCurrentUserStepUpPasskey();
      const response = await startAuthentication({ optionsJSON: options as never });
      await api.finishCurrentUserStepUpPasskey(options.challenge, response);
    } catch (error) {
      toastApiError(error, "Passkey verification failed");
      setStepUpBusy(null);
      return;
    }
    setStepUpBusy(null);
    await completeStepUp();
  };

  const registerPasskey = async () => {
    setAddingPasskey(true);
    try {
      const options = await api.beginCurrentUserPasskeyRegistration();
      const response = await startRegistration({ optionsJSON: options as never });
      await api.finishCurrentUserPasskeyRegistration(response, derivePasskeyName(response));
      await load();
      toast.success("Passkey added");
    } catch (error) {
      if (isStepUpRequired(error)) {
        requestStepUp(registerPasskey);
        return;
      }
      toastApiError(error, "Failed to add passkey");
    } finally {
      setAddingPasskey(false);
    }
  };

  const openTotpSetup = async () => {
    if (totpCloseTimer.current !== null) {
      window.clearTimeout(totpCloseTimer.current);
      totpCloseTimer.current = null;
    }
    pendingRecoveryCodes.current = null;
    setTotpSetupOpen(true);
    setTotpSetup(null);
    setTotpCode("");
    try {
      setTotpSetup(await api.beginCurrentUserTotpSetup());
    } catch (error) {
      closeTotpSetup();
      if (isStepUpRequired(error)) {
        requestStepUp(openTotpSetup);
        return;
      }
      toastApiError(error, "Failed to start TOTP setup");
    }
  };

  const confirmTotp = async () => {
    setTotpSaving(true);
    try {
      const nextRecoveryCodes = await api.confirmCurrentUserTotpSetup(totpCode);
      pendingRecoveryCodes.current = nextRecoveryCodes;
      closeTotpSetup();
      await load();
    } catch (error) {
      if (isStepUpRequired(error)) {
        closeTotpSetup();
        requestStepUp(openTotpSetup);
        return;
      }
      toastApiError(error, "Invalid authentication code");
    } finally {
      setTotpSaving(false);
    }
  };

  const resetAndReconfigureTotp = async () => {
    setTotpResetting(true);
    try {
      await api.resetCurrentUserTotp();
      setTotpResetOpen(false);
      await load();
      await openTotpSetup();
    } catch (error) {
      if (isStepUpRequired(error)) {
        setTotpResetOpen(false);
        requestStepUp(resetAndReconfigureTotp);
        return;
      }
      toastApiError(error, "Failed to reset TOTP");
    } finally {
      setTotpResetting(false);
    }
  };

  const removePasskey = async (id: string) => {
    setRemovingPasskeyId(id);
    try {
      await api.removeCurrentUserPasskey(id);
      await load();
      toast.success("Passkey removed");
    } catch (error) {
      if (isStepUpRequired(error)) {
        requestStepUp(() => removePasskey(id));
        return;
      }
      toastApiError(error, "Failed to remove passkey");
    } finally {
      setRemovingPasskeyId(null);
    }
  };

  return (
    <PanelShell
      title="Account security"
      description="Configure Opfield MFA and local sign-in credentials"
      icon={<ShieldCheck className="h-4 w-4" />}
    >
      <div className="divide-y divide-border">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Passkeys</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status?.passkeyCount ?? 0} configured. A passkey can be used for local sign-in and
              MFA.
            </p>
          </div>
          <Button variant="link" className="h-auto p-0" onClick={() => setPasskeysOpen(true)}>
            Manage Passkeys <ArrowRight />
          </Button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Authenticator app (TOTP)</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status?.totpConfigured
                ? `${status.recoveryCodeCount} recovery codes remain`
                : "Not configured"}
            </p>
          </div>
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() => (status?.totpConfigured ? setTotpResetOpen(true) : void openTotpSetup())}
          >
            Manage TOTP <ArrowRight />
          </Button>
        </div>
      </div>

      <Dialog
        open={passkeysOpen}
        onOpenChange={(open) => {
          setPasskeysOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Passkeys</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Passkeys can sign you in and satisfy Opfield multi-factor authentication.
          </DialogDescription>
          <div className="border border-border">
            <Input
              value={passkeysSearch}
              onChange={(event) => setPasskeysSearch(event.target.value)}
              placeholder="Search passkeys..."
              className="h-9 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
            />
            {filteredPasskeys.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {passkeysSearch ? "No passkeys found." : "No passkeys configured."}
              </p>
            ) : (
              <div className="max-h-[min(25rem,48dvh)] divide-y divide-border overflow-y-auto overscroll-contain">
                {filteredPasskeys.map((passkey) => (
                  <div key={passkey.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{passkey.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {passkey.lastUsedAt ? (
                          <>
                            Last used <RelativeTime value={passkey.lastUsedAt} />
                          </>
                        ) : (
                          <>
                            Added <RelativeTime value={passkey.createdAt} />
                          </>
                        )}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      pending={removingPasskeyId === passkey.id}
                      onClick={() => void removePasskey(passkey.id)}
                      aria-label={`Remove ${passkey.name}`}
                      title="Remove passkey"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => void registerPasskey()} pending={addingPasskey}>
              <Plus />
              Add passkey
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={totpSetupOpen}
        onOpenChange={(open) => {
          if (open) return;
          closeTotpSetup();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set Up Authenticator App</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Scan this QR code with your authenticator app, then enter the generated code to activate
            TOTP.
          </DialogDescription>
          {totpSetup ? (
            <>
              <div className="flex justify-center bg-qr p-4">
                <QRCodeSVG
                  value={totpSetup.uri}
                  size={176}
                  level="M"
                  marginSize={4}
                  title="TOTP setup QR code"
                />
              </div>
              <CopyValueField label="Manual setup key" value={totpSetup.secret} />
              <div className="flex gap-2">
                <Input
                  value={totpCode}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  onChange={(event) =>
                    setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                />
                <Button
                  className="shrink-0"
                  onClick={() => void confirmTotp()}
                  pending={totpSaving}
                  disabled={totpCode.length !== 6}
                >
                  <Check />
                  Activate TOTP
                </Button>
              </div>
            </>
          ) : (
            // The setup secret is requested as the dialog opens; it opens with it.
            <ReportLoading loading={totpSetupOpen} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={totpResetOpen} onOpenChange={setTotpResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>TOTP Is Already Configured</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Resetting it removes the current authenticator app and recovery codes. Your passkeys
            stay available.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTotpResetOpen(false)}
              disabled={totpResetting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void resetAndReconfigureTotp()}
              pending={totpResetting}
            >
              Reset &amp; reconfigure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={stepUpOpen}
        onOpenChange={(open) => {
          if (open) return;
          cancelStepUp();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm It&apos;s You</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Changing passkeys or your authenticator app requires a current second factor.
          </DialogDescription>
          {status?.totpConfigured && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void verifyStepUpCode();
              }}
            >
              <div className="flex gap-2">
                <Input
                  value={stepUpCode}
                  aria-label={stepUpUseRecoveryCode ? "Recovery code" : "Authentication code"}
                  inputMode={stepUpUseRecoveryCode ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  placeholder={stepUpUseRecoveryCode ? "Recovery code" : "6-digit code"}
                  onChange={(event) =>
                    setStepUpCode(
                      stepUpUseRecoveryCode
                        ? event.target.value.slice(0, 64)
                        : event.target.value.replace(/\D/g, "").slice(0, 6)
                    )
                  }
                />
                <Button
                  type="submit"
                  className="shrink-0"
                  pending={stepUpBusy === "code"}
                  disabled={
                    stepUpBusy !== null ||
                    (stepUpUseRecoveryCode ? stepUpCode.trim().length < 6 : stepUpCode.length !== 6)
                  }
                >
                  <Check />
                  Verify
                </Button>
              </div>
              <Button
                type="button"
                variant="link"
                size="inline"
                className="self-start text-xs"
                onClick={() => {
                  setStepUpUseRecoveryCode((current) => !current);
                  setStepUpCode("");
                }}
              >
                {stepUpUseRecoveryCode ? "Use authenticator app code" : "Use a recovery code"}
              </Button>
            </form>
          )}
          {(status?.passkeyCount ?? 0) > 0 && (
            <Button
              variant="outline"
              onClick={() => void verifyStepUpPasskey()}
              pending={stepUpBusy === "passkey"}
              disabled={stepUpBusy !== null}
            >
              <KeyRound />
              Use a passkey
            </Button>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={recoveryCodesOpen}
        onOpenChange={(open) => {
          if (open) return;
          closeRecoveryCodes();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save Recovery Codes</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Keep these ten codes somewhere safe. Each can be used once if you lose access to your
            authenticator app.
          </DialogDescription>
          {recoveryCodes && (
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((code, index) => (
                <Input
                  key={code}
                  value={code}
                  readOnly
                  aria-label={`Recovery code ${index + 1}`}
                  className="font-mono"
                />
              ))}
            </div>
          )}
          <DialogFooter>
            <CopyButton
              value={recoveryCodes?.join("\n") ?? ""}
              label="recovery codes"
              className="border border-border bg-background hover:bg-accent hover:text-accent-foreground"
            />
            <Button
              variant="outline"
              onClick={() => recoveryCodes && printRecoveryCodes(recoveryCodes)}
            >
              <Printer /> Print
            </Button>
            <Button
              onClick={() => {
                closeRecoveryCodes();
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelShell>
  );
}

/** Reports a load to the enclosing page, tab or dialog while rendered inside it. */
function ReportLoading({ loading }: { loading: boolean }) {
  useContentLoading(loading);
  return null;
}

function isStepUpRequired(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "MFA_STEP_UP_REQUIRED";
}

function derivePasskeyName(response: unknown): string {
  const attachment = (response as { authenticatorAttachment?: string }).authenticatorAttachment;
  if (attachment !== "platform") return "Security key";

  const userAgent = navigator.userAgent;
  if (/Macintosh|iPhone|iPad/i.test(userAgent)) return "iCloud Keychain";
  if (/Windows/i.test(userAgent)) return "Windows Hello";
  if (/Android/i.test(userAgent)) return "Android passkey";
  return "This device's passkey";
}

function printRecoveryCodes(recoveryCodes: string[]) {
  const printWindow = window.open("", "gateway-recovery-codes", "width=640,height=720");
  if (!printWindow) {
    toast.error("Allow pop-ups to print recovery codes");
    return;
  }

  const codes = recoveryCodes.map(escapeHtml).join("<br>");
  printWindow.document.write(
    `<!doctype html><html><head><title>Opfield recovery codes</title><style>body{font-family:ui-monospace,monospace;padding:32px}h1{font-family:system-ui,sans-serif;font-size:20px}.codes{columns:2;line-height:1.8}</style></head><body><h1>Opfield recovery codes</h1><p>Store these codes safely. Each code can be used once.</p><div class="codes">${codes}</div></body></html>`
  );
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function AIApprovalModeRow({
  value,
  onChange,
}: {
  value: AIApprovalMode;
  onChange: (mode: AIApprovalMode) => void | Promise<void>;
}) {
  const current = AI_APPROVAL_MODE_META[value];
  const CurrentIcon = current.icon;

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          <SettingsHelpTitle
            label="AI approval mode"
            help="Controls when AI Workspace asks for confirmation before running tools or making changes. It does not grant permissions beyond your account scopes or bypass server-side authorization."
          />
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{current.description}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between sm:w-[250px]">
            <span className="flex min-w-0 items-center gap-2">
              <CurrentIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{current.menuLabel}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
          {AI_APPROVAL_MODES.map((mode) => {
            const item = AI_APPROVAL_MODE_META[mode];
            const Icon = item.icon;
            return (
              <DropdownMenuItem
                key={mode}
                className="items-start gap-3"
                onSelect={() => void onChange(mode)}
              >
                <Icon className="mt-0.5 h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.menuLabel}</span>
                  <span className="block text-xs text-muted-foreground">{item.description}</span>
                </span>
                {value === mode && <Check className="mt-0.5 h-4 w-4" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
