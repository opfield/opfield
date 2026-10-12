import {
  Database,
  KeyRound,
  Mail,
  Network,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  Webhook,
} from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow, SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature } from "@/stores/license-paywall";
import type { AuthProvisioningSettings } from "@/types";
import { GracefulShutdownSettingsPanel } from "./GracefulShutdownSettingsPanel";
import { SMTP_PRESETS, type SmtpPresetId } from "./smtp-presets";

import {
  type DEFAULT_AUTH_METHODS,
  SMTP_TEST_EMAIL_OPTIONS,
  type SmtpTestEmailKind,
  useAuthProvisioningSettings,
} from "./useAuthProvisioningSettings";

interface AuthProvisioningSectionProps {
  canEdit: boolean;
  section?: "all" | "general" | "authentication" | "advanced" | "features";
}

export function AuthProvisioningSection({
  canEdit,
  section = "all",
}: AuthProvisioningSectionProps) {
  const {
    settings,
    initialLoadComplete,
    isSavingAutoCreate,
    isSavingVerifiedEmail,
    isSavingGroup,
    isSavingGeneral,
    isSavingWebTls,
    isSavingMcp,
    isSavingMcpCompatibility,
    isSavingOAuthCompatibility,
    isSavingNetwork,
    isSavingWebhookPolicy,
    isSavingLocalAuth,
    isSavingMfaGracePeriod,
    isSavingOidc,
    oidcDraft,
    setOidcDraft,
    isSavingLogging,
    loggingDraft,
    setLoggingDraft,
    mfaGracePeriodDays,
    setMfaGracePeriodDays,
    setMfaGracePeriodRaw,
    mfaGracePeriodInputKey,
    publicUrl,
    setPublicUrl,
    hideExternalBranding,
    setHideExternalBranding,
    handleToggleAutoAssignCreatedResourcePermissions,
    updateChannel,
    setUpdateChannel,
    smtpDraft,
    setSmtpDraft,
    smtpPreset,
    smtpTestOpen,
    setSmtpTestOpen,
    smtpTestRecipient,
    setSmtpTestRecipient,
    smtpTestEmailKind,
    setSmtpTestEmailKind,
    isSendingSmtpTest,
    trustedProxyCidrs,
    setTrustedProxyCidrs,
    webhookPrivateCidrs,
    setWebhookPrivateCidrs,
    fileUploadLimitMb,
    setFileUploadLimitMb,
    fileOpenLimitMb,
    setFileOpenLimitMb,
    gatewayGrpcPublicTarget,
    setGatewayGrpcPublicTarget,
    gatewayGrpcLocalIp,
    setGatewayGrpcLocalIp,
    relayGrantTtlHours,
    setRelayGrantTtlHours,
    pkiEnabled,
    setPkiEnabled,
    siemEnabled,
    setSiemEnabled,
    inferenceEnabled,
    skipNextCidrsBlur,
    skipNextWebhookCidrsBlur,
    selectedGroup,
    handleToggleAutoCreate,
    handleToggleInvitationOnCreate,
    handleChangeGroup,
    handleToggleRequireVerifiedEmail,
    handleToggleWebTls,
    saveOidc,
    saveLogging,
    accessSettingsHaveChanges,
    featureSettingsHaveChanges,
    saveAccessSettings,
    saveFeatureSettings,
    saveShutdownSettings,
    handleToggleMcpServer,
    handleToggleMcpCompatibility,
    handleToggleOAuthCompatibility,
    handleToggleInference,
    updateNetworkSecurity,
    saveTrustedProxyCidrs,
    updateOutboundWebhookPolicy,
    saveWebhookPrivateCidrs,
    updateLocalAuth,
    saveMfaGracePeriod,
    saveSmtp,
    handleSmtpPresetChange,
    selectedSmtpPreset,
    usesProviderPreset,
    showsSmtpUsername,
    smtpUsernameDescription,
    smtpPasswordDescription,
    oidcHasChanges,
    loggingHasChanges,
    mfaGracePeriodIsValid,
    mfaHasChanges,
    smtpHasChanges,
  } = useAuthProvisioningSettings(canEdit);
  const hasScope = useAuthStore((state) => state.hasScope);
  // SMTP, the OIDC provider, the public URL and verified-email enforcement decide who can prove
  // an identity to Gateway, so the backend only lets admin:system change them.
  const canEditIdentityTrust = canEdit && hasScope("admin:system");
  const identityTrustLocked = canEdit && !canEditIdentityTrust;

  useContentLoading(!initialLoadComplete);
  if (!initialLoadComplete || !settings) return null;
  // A managed cloud installation keeps the public URL and gRPC addresses the cloud set up.
  const cloudManaged = settings.cloudManaged === true;
  // Its Opfield account provider keeps the client the cloud set up; only the display name is the admin's.
  const opfieldProviderLocked = cloudManaged && settings.oidc?.opfieldAccount === true;

  return (
    <div className="space-y-4">
      <div
        className="grid gap-4 xl:grid-cols-2"
        hidden={section !== "all" && section !== "general"}
      >
        <PanelShell
          icon={<Network className="h-4 w-4" />}
          title="Access and limits"
          description="Public access, relay grants, files, and node enrollment"
          actions={
            <Button
              onClick={saveAccessSettings}
              disabled={!canEdit || isSavingGeneral || !accessSettingsHaveChanges}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
          }
          dirty={accessSettingsHaveChanges}
        >
          <div className="divide-y divide-border">
            <SettingsControlRow
              title="Public URL"
              description={
                cloudManaged ? (
                  <>
                    Browser-facing URL for redirects and links. <CloudManagedHint />
                  </>
                ) : identityTrustLocked ? (
                  <>
                    Browser-facing URL for redirects and links. <IdentityTrustHint />
                  </>
                ) : (
                  "Browser-facing URL for redirects and links."
                )
              }
              help="This is the address users and external clients use to reach Opfield. A wrong value can break sign-in redirects, callback URLs, and links generated in emails."
            >
              <Input
                type="url"
                value={publicUrl}
                placeholder="https://opfield.example.com"
                disabled={!canEditIdentityTrust || isSavingGeneral || cloudManaged}
                onChange={(event) => setPublicUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveAccessSettings();
                }}
              />
            </SettingsControlRow>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">
                  <SettingsHelpTitle
                    label="Relay grant lifetime"
                    help="A relay grant authorizes an endpoint or connection for a limited time. New grants use this lifetime; existing grants keep their current expiry."
                  />
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Lifetime of newly issued relay grants, in hours (1–224)
                </p>
              </div>
              <Input
                className="w-28 shrink-0"
                type="number"
                min={1}
                max={224}
                step={1}
                value={relayGrantTtlHours}
                disabled={!canEdit || isSavingGeneral}
                aria-label="Relay grant lifetime hours"
                onChange={(event) => setRelayGrantTtlHours(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveAccessSettings();
                }}
              />
            </div>
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div>
                <p className="text-sm font-medium">
                  <SettingsHelpTitle
                    label="File upload limit"
                    help="Maximum size of one file accepted by Opfield file managers. This is separate from the HTTP and inference request limits on the Environment tab."
                  />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Maximum file size accepted by Opfield, in MB
                </p>
              </div>
              <Input
                className="w-full shrink-0 sm:max-w-40"
                type="number"
                min={1}
                max={500}
                step={1}
                value={fileUploadLimitMb}
                disabled={!canEdit || isSavingGeneral}
                onChange={(event) => setFileUploadLimitMb(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    saveAccessSettings();
                  }
                }}
              />
            </div>
            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div>
                <p className="text-sm font-medium">
                  <SettingsHelpTitle
                    label="File open limit"
                    help="Maximum file size Opfield will load or copy through the browser interface. Larger files may still exist on the node but cannot be opened in-browser."
                  />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Maximum file size opened in the browser, in MB
                </p>
              </div>
              <Input
                className="w-full shrink-0 sm:max-w-40"
                type="number"
                min={1}
                max={100}
                step={1}
                value={fileOpenLimitMb}
                disabled={!canEdit || isSavingGeneral}
                onChange={(event) => setFileOpenLimitMb(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    saveAccessSettings();
                  }
                }}
              />
            </div>
            <SettingsControlRow
              title="gRPC public target"
              description={
                cloudManaged ? (
                  <>
                    Public address used to enroll nodes. <CloudManagedHint />
                  </>
                ) : (
                  "Public address used to enroll nodes"
                )
              }
              help="Host and port written into public node-enrollment commands. Nodes must be able to reach this address to establish their control connection."
            >
              <Input
                value={gatewayGrpcPublicTarget}
                placeholder="opfield.example.com:9443"
                disabled={!canEdit || isSavingGeneral || cloudManaged}
                onChange={(event) => setGatewayGrpcPublicTarget(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    saveAccessSettings();
                  }
                }}
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="gRPC local IP"
              description={
                cloudManaged ? (
                  <>
                    Optional private address for local node enrollment. <CloudManagedHint />
                  </>
                ) : (
                  "Optional private address for local node enrollment"
                )
              }
              help="Optional private address used in enrollment commands for nodes on the local network. When empty, Opfield uses the public target above."
            >
              <Input
                value={gatewayGrpcLocalIp}
                placeholder="Uses public target when empty"
                disabled={!canEdit || isSavingGeneral || cloudManaged}
                onChange={(event) => setGatewayGrpcLocalIp(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    saveAccessSettings();
                  }
                }}
              />
            </SettingsControlRow>
          </div>
        </PanelShell>

        <PanelShell
          icon={<SlidersHorizontal className="h-4 w-4" />}
          title="Features and updates"
          description="Opfield capabilities, branding, transport, and releases"
          actions={
            <Button
              onClick={saveFeatureSettings}
              disabled={!canEdit || isSavingGeneral || !featureSettingsHaveChanges}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
          }
          dirty={featureSettingsHaveChanges}
        >
          <div className="divide-y divide-border">
            <SettingsControlRow
              title="Hide external branding"
              description="Hide Opfield branding on public system pages"
            >
              <Switch
                checked={hideExternalBranding}
                disabled={!canEdit || isSavingGeneral}
                ariaLabel="Hide external branding"
                onChange={setHideExternalBranding}
              />
            </SettingsControlRow>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">
                  <SettingsHelpTitle
                    label="Internal HTTPS on port 3000"
                    help="Encrypts direct traffic to Opfield's internal web port with a certificate from the System CA. Changing it restarts the Opfield container."
                  />
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Enable System CA HTTPS for Opfield port 3000
                  {cloudManaged ? (
                    <>
                      . <CloudManagedHint />
                    </>
                  ) : null}
                </p>
              </div>
              <Switch
                checked={settings.webTransport?.tlsEnabled ?? false}
                disabled={!canEdit || isSavingWebTls || cloudManaged}
                ariaLabel="Enable internal HTTPS"
                onChange={handleToggleWebTls}
              />
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <SettingsHelpTitle
                    label="PKI"
                    help="PKI enables Opfield-managed certificate authorities, certificates, revocation, and reusable issuance templates."
                  />
                  <LicensePlanBadge feature="internal-pki" />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Show PKI navigation and certificate management
                </p>
              </div>
              <Switch
                checked={pkiEnabled}
                disabled={!canEdit || isSavingGeneral}
                onChange={(enabled) => {
                  if (enabled && !requireLicenseFeature("internal-pki", "Internal PKI")) return;
                  setPkiEnabled(enabled);
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <SettingsHelpTitle
                    label="SIEM audit export"
                    help="Sends privacy-reduced Opfield audit events to configured security monitoring collectors for centralized investigation and retention."
                  />
                  <LicensePlanBadge feature="siem-export" />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Show SIEM screens and audit event delivery
                </p>
              </div>
              <Switch
                checked={siemEnabled}
                disabled={!canEdit || isSavingGeneral}
                ariaLabel="Enable SIEM audit export"
                onChange={(enabled) => {
                  if (enabled && !requireLicenseFeature("siem-export", "SIEM audit export")) return;
                  setSiemEnabled(enabled);
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">
                  <SettingsHelpTitle
                    label="Inference"
                    help="Enables Opfield's model proxy, provider connections, API tokens, model catalog, usage accounting, and per-user limits."
                  />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Enable inference proxy, tokens, and providers
                </p>
              </div>
              <Switch
                checked={inferenceEnabled}
                disabled={!canEdit || isSavingGeneral}
                ariaLabel="Enable inference"
                onChange={handleToggleInference}
              />
            </div>
            <SettingsControlRow
              title="Update channel"
              description="Allow preview versions for managed updates"
              help="Stable installs production-ready releases only. Preview also allows release candidates for Opfield, Relay, and managed node daemons; it does not change Inference Core updates."
            >
              <Select
                value={updateChannel}
                disabled={!canEdit || isSavingGeneral}
                onValueChange={(value) => setUpdateChannel(value as "stable" | "preview")}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Update channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="w-80 max-w-[calc(100vw-2rem)]">
                  <SelectItem
                    value="stable"
                    description="Production-ready releases only. Recommended for production environments."
                  >
                    Stable
                  </SelectItem>
                  <SelectItem
                    value="preview"
                    description="Upcoming versions before general availability. Preview versions may contain unresolved issues."
                  >
                    Preview
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
          </div>
        </PanelShell>
      </div>

      <GracefulShutdownSettingsPanel
        hidden={section !== "all" && section !== "features"}
        value={settings.generalSettings.shutdown}
        canEdit={canEdit}
        onSave={saveShutdownSettings}
      />

      <PanelShell
        icon={<Database className="h-4 w-4" />}
        hidden={section !== "all" && section !== "features"}
        title="Structured logging storage"
        description="Keep logging disabled, let Opfield manage a local ClickHouse, or use an external ClickHouse"
        actions={
          <Button
            aria-label="Save structured logging storage"
            onClick={saveLogging}
            pending={isSavingLogging}
            disabled={!canEdit || !loggingHasChanges}
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={loggingHasChanges}
      >
        <div className="divide-y divide-border">
          <SettingsControlRow
            title="Storage mode"
            description="Disabling managed local storage stops its container but preserves the Docker volume."
            help="Disabled stores no structured logs. Managed local runs Opfield's ClickHouse container. External sends logs to a ClickHouse instance you operate."
          >
            <Select
              value={loggingDraft.mode}
              disabled={!canEdit || isSavingLogging}
              onValueChange={(mode: "disabled" | "local" | "external") => {
                if (
                  mode !== "disabled" &&
                  !requireLicenseFeature("structured-logging", "Structured logging")
                )
                  return;
                setLoggingDraft((current) => ({ ...current, mode }));
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">Disabled</SelectItem>
                <SelectItem value="local">Managed local</SelectItem>
                <SelectItem value="external">External</SelectItem>
              </SelectContent>
            </Select>
          </SettingsControlRow>
          {loggingDraft.mode === "local" && (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              Opfield uses the mounted Docker socket to run a pinned ClickHouse image on the current
              network.
            </div>
          )}
          {loggingDraft.mode === "external" && (
            <>
              <SettingsControlRow
                title="ClickHouse URL"
                description="HTTP(S) endpoint for the external ClickHouse instance."
                help="Opfield uses ClickHouse's HTTP interface at this address to insert and query structured logs. Include the correct scheme and port."
              >
                <Input
                  type="url"
                  value={loggingDraft.url}
                  placeholder="https://clickhouse.example.com:8443"
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, url: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Username"
                description="ClickHouse account used by Opfield."
              >
                <Input
                  value={loggingDraft.username}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, username: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Password"
                description={
                  settings.logging?.passwordLast4
                    ? `Stored password ends in ${settings.logging.passwordLast4}`
                    : "Required for the initial external connection."
                }
              >
                <Input
                  type="password"
                  value={loggingDraft.password}
                  placeholder={
                    settings.logging?.passwordLast4
                      ? "Leave blank to keep current password"
                      : "Password"
                  }
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, password: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Database"
                description="Database that stores structured Opfield logs."
              >
                <Input
                  value={loggingDraft.database}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, database: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Table"
                description="MergeTree table used for structured logs."
              >
                <Input
                  value={loggingDraft.table}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({ ...current, table: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Request timeout"
                description="ClickHouse request timeout in milliseconds."
                help="Maximum time Opfield waits for one ClickHouse operation before treating it as failed. Increasing it tolerates slow storage but delays failure recovery."
              >
                <Input
                  type="number"
                  min={1}
                  max={120000}
                  value={loggingDraft.requestTimeoutMs}
                  disabled={!canEdit || isSavingLogging}
                  onChange={(event) =>
                    setLoggingDraft((current) => ({
                      ...current,
                      requestTimeoutMs: event.target.value,
                    }))
                  }
                />
              </SettingsControlRow>
            </>
          )}
        </div>
      </PanelShell>

      <PanelShell
        icon={<KeyRound className="h-4 w-4" />}
        hidden={section !== "all" && section !== "authentication"}
        title="Sign-in methods"
        description="Enable the primary methods available to Opfield accounts"
      >
        <div className="divide-y divide-border">
          {[
            [
              "oidc",
              "OIDC",
              cloudManaged
                ? "Redirect users to the configured identity provider · Managed by Opfield Cloud"
                : "Redirect users to the configured identity provider",
            ],
            [
              "password",
              "Email and password",
              "Password setup and recovery links are sent over verified SMTP",
            ],
            ["emailOtp", "Email sign-in code", "A one-time code is sent over verified SMTP"],
            [
              "passkeyLogin",
              "Passkey",
              "Optional local-account passkeys can sign users in directly",
            ],
          ].map(([key, title, description]) => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
              </div>
              <Switch
                checked={settings.methods?.[key as keyof typeof DEFAULT_AUTH_METHODS] ?? false}
                disabled={!canEdit || isSavingLocalAuth || (cloudManaged && key === "oidc")}
                onChange={(checked) =>
                  updateLocalAuth({
                    methods: { [key]: checked } as Partial<
                      NonNullable<AuthProvisioningSettings["methods"]>
                    >,
                  })
                }
              />
            </div>
          ))}
        </div>
      </PanelShell>

      <PanelShell
        icon={<ShieldCheck className="h-4 w-4" />}
        hidden={section !== "all" && section !== "authentication"}
        title="Multi-factor authentication"
        description="Controls how Opfield enforces MFA for local browser sessions"
        actions={
          <Button
            aria-label="Save MFA grace period"
            onClick={saveMfaGracePeriod}
            pending={isSavingMfaGracePeriod}
            disabled={!canEdit || !mfaHasChanges || !mfaGracePeriodIsValid}
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={mfaHasChanges}
      >
        <SettingsControlRow
          title="Existing-session MFA grace period"
          description="Days existing local browser sessions may continue after group MFA is enabled. New sign-ins require MFA immediately. 0 applies immediately."
          help="This affects sessions that were already signed in when MFA became required. It does not delay MFA for new sign-ins, and zero revokes the grace period immediately."
        >
          <div className="flex w-full items-center gap-2 sm:w-40">
            <NumericInput
              key={mfaGracePeriodInputKey}
              aria-label="Existing-session MFA grace period in days"
              value={mfaGracePeriodDays}
              min={0}
              max={7}
              step={1}
              disabled={!canEdit || isSavingMfaGracePeriod}
              onChange={(value, raw) => {
                setMfaGracePeriodDays(value);
                setMfaGracePeriodRaw(raw);
              }}
            />
            <span className="text-sm text-muted-foreground">days</span>
          </div>
        </SettingsControlRow>
      </PanelShell>

      <PanelShell
        icon={<ShieldCheck className="h-4 w-4" />}
        hidden={section !== "all" && section !== "authentication"}
        title="OIDC provider"
        description={
          identityTrustLocked ? (
            <IdentityTrustHint />
          ) : opfieldProviderLocked ? (
            "Sign-in with the Opfield account this installation was provisioned with · Managed by Opfield Cloud"
          ) : settings.oidc?.opfieldAccount ? (
            "Sign-in with the Opfield account this installation was provisioned with. Client secret is stored encrypted"
          ) : settings.oidc?.configured ? (
            "Client secret is stored encrypted"
          ) : (
            "Configure the identity provider used for OIDC sign-in"
          )
        }
        actions={
          <Button
            aria-label="Save OIDC provider"
            onClick={saveOidc}
            pending={isSavingOidc}
            disabled={!canEditIdentityTrust || !oidcHasChanges}
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={oidcHasChanges}
      >
        <div className="divide-y divide-border">
          <SettingsControlRow
            title="Display name"
            description="Shown on the sign-in button as Sign in with this name."
            help="Leave empty to show Sign in with SSO. The provider a managed installation was provisioned with is named Opfield account."
          >
            <Input
              value={oidcDraft.displayName}
              placeholder="SSO"
              maxLength={64}
              disabled={!canEditIdentityTrust || isSavingOidc}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, displayName: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Issuer URL"
            description="OpenID Connect issuer used for discovery."
            help="The issuer is the identity provider's canonical URL. Opfield reads its discovery document from this address to find authorization, token, and key endpoints."
          >
            <Input
              type="url"
              value={oidcDraft.issuer}
              placeholder="https://id.example.com/application/o/opfield/"
              disabled={!canEditIdentityTrust || isSavingOidc || opfieldProviderLocked}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, issuer: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Client ID"
            description="OAuth client identifier registered at the provider."
            help="Public identifier assigned to the Opfield application by the identity provider. It is not a secret."
          >
            <Input
              value={oidcDraft.clientId}
              placeholder="opfield"
              disabled={!canEditIdentityTrust || isSavingOidc || opfieldProviderLocked}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, clientId: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Client secret"
            description={
              settings.oidc?.clientSecretLast4
                ? `Stored secret ends in ${settings.oidc.clientSecretLast4}`
                : "Required for the initial configuration."
            }
            help="Secret assigned to the Opfield application by the identity provider. Leave the field empty when editing to keep the encrypted value already stored."
          >
            <Input
              type="password"
              value={oidcDraft.clientSecret}
              placeholder={
                settings.oidc?.configured ? "Leave blank to keep current secret" : "Client secret"
              }
              disabled={!canEditIdentityTrust || isSavingOidc || opfieldProviderLocked}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, clientSecret: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Redirect URI"
            description="Must exactly match the callback registered at the provider."
            help="After sign-in, the identity provider sends the browser back to this URL. Scheme, hostname, port, and path must exactly match the provider configuration."
          >
            <Input
              type="url"
              value={oidcDraft.redirectUri}
              placeholder="https://opfield.example.com/auth/callback"
              disabled={!canEditIdentityTrust || isSavingOidc || opfieldProviderLocked}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, redirectUri: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Scopes"
            description="Space-separated scopes; openid is required."
            help="Scopes request identity claims from the provider. openid enables OIDC; profile and email commonly provide the user's name and email address."
          >
            <Input
              value={oidcDraft.scopes}
              disabled={!canEditIdentityTrust || isSavingOidc || opfieldProviderLocked}
              onChange={(event) =>
                setOidcDraft((current) => ({ ...current, scopes: event.target.value }))
              }
            />
          </SettingsControlRow>
        </div>
      </PanelShell>

      <PanelShell
        icon={<UserCog className="h-4 w-4" />}
        hidden={section !== "all" && section !== "authentication"}
        title="Identity provisioning"
        description="Account creation, OIDC sign-in, and permissions for what users create"
      >
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Auto-create users on OIDC sign-in"
                  help="Creates an Opfield account the first time a valid identity-provider user signs in. Disable it when every allowed user must be provisioned manually first."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                If disabled, only pre-created users can sign in through OIDC
              </p>
            </div>
            <Switch
              checked={settings.oidcAutoCreateUsers}
              disabled={!canEdit || isSavingAutoCreate}
              onChange={handleToggleAutoCreate}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Require verified OIDC email"
                  help="Accepts the provider's email claim only when it explicitly marks the address as verified. This prevents unverified addresses from being trusted as account identity."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Require email_verified=true for future auto-created users and pre-created user
                claims
                {identityTrustLocked && settings.oidcRequireVerifiedEmail && (
                  <>
                    . <IdentityTrustHint action="turn this off" />
                  </>
                )}
              </p>
            </div>
            <Switch
              checked={settings.oidcRequireVerifiedEmail}
              disabled={
                !canEdit ||
                isSavingVerifiedEmail ||
                (settings.oidcRequireVerifiedEmail && !canEditIdentityTrust)
              }
              onChange={handleToggleRequireVerifiedEmail}
            />
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Default group for new OIDC users"
                  help="Newly auto-created users receive this group's permissions. Changing it does not move users who were already created."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Applied to newly auto-created users after the first real administrator signs in
              </p>
            </div>
            <div className="w-full shrink-0 sm:w-64">
              <Select
                value={settings.oidcDefaultGroupId}
                disabled={!canEdit || isSavingGroup}
                onValueChange={handleChangeGroup}
              >
                <SelectTrigger>
                  <SelectValue placeholder={selectedGroup?.name ?? "Select group"} />
                </SelectTrigger>
                <SelectContent>
                  {settings.availableGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <SettingsControlRow
            title="Send an invitation email when an account is created"
            help="Emails every account created in Users, the API or MCP that an administrator created it, with a sign-in link. If sending fails the account is still created, and the invitation can be sent later from the user's settings."
            description={
              settings.smtp?.verifiedAt
                ? "Off by default. Sent over verified SMTP right after creation"
                : "Requires verified SMTP"
            }
          >
            <Switch
              ariaLabel="Send an invitation email when an account is created"
              checked={settings.generalSettings.sendInvitationOnUserCreate ?? false}
              disabled={!canEdit || isSavingGeneral}
              onChange={(checked) => void handleToggleInvitationOnCreate(checked)}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Auto-assign permissions for created resources"
            help="Automatically adds resource-specific permissions to the creator's additional permissions. They can be edited or reset in Assign permissions. Turning this off affects new resources only; existing grants are retained."
            description="The creator of a container, route, database or other resource gets permissions on it"
          >
            <Switch
              ariaLabel="Auto-assign permissions for created resources"
              checked={settings.generalSettings.autoAssignCreatedResourcePermissions ?? true}
              disabled={!canEdit || isSavingGeneral}
              onChange={(checked) => void handleToggleAutoAssignCreatedResourcePermissions(checked)}
            />
          </SettingsControlRow>
        </div>
      </PanelShell>

      <PanelShell
        icon={<Mail className="h-4 w-4" />}
        hidden={section !== "all" && section !== "advanced"}
        title="SMTP configuration"
        description={
          identityTrustLocked ? (
            <IdentityTrustHint />
          ) : settings.smtp?.verifiedAt ? (
            <>
              Verified <RelativeTime value={settings.smtp.verifiedAt} />
            </>
          ) : (
            "Configure and send a test before enabling email-based sign-in"
          )
        }
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setSmtpTestOpen(true)}
              disabled={
                !canEdit ||
                isSavingLocalAuth ||
                (!canEditIdentityTrust && (!settings.smtp?.configured || smtpHasChanges))
              }
            >
              Send test
            </Button>
            <Button
              aria-label="Save SMTP settings"
              onClick={() => saveSmtp()}
              pending={isSavingLocalAuth}
              disabled={!canEditIdentityTrust || !smtpHasChanges}
            >
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        }
        dirty={smtpHasChanges}
      >
        <div className="divide-y divide-border">
          <SettingsControlRow title="Email provider" description={selectedSmtpPreset.description}>
            <Select
              value={smtpPreset}
              disabled={!canEditIdentityTrust || isSavingLocalAuth}
              onValueChange={(value) => handleSmtpPresetChange(value as SmtpPresetId)}
            >
              <SelectTrigger aria-label="SMTP provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SMTP_PRESETS).map(([id, preset]) => (
                  <SelectItem key={id} value={id}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
          {!usesProviderPreset && (
            <>
              <SettingsControlRow
                title="SMTP host"
                description="Hostname of the outgoing mail relay."
              >
                <Input
                  aria-label="SMTP host"
                  value={smtpDraft.host}
                  placeholder="smtp.example.com"
                  disabled={!canEditIdentityTrust || isSavingLocalAuth}
                  onChange={(event) =>
                    setSmtpDraft((current) => ({ ...current, host: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow title="Port" description="TCP port used to connect to the relay.">
                <Input
                  aria-label="SMTP port"
                  value={smtpDraft.port}
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="587"
                  disabled={!canEditIdentityTrust || isSavingLocalAuth}
                  onChange={(event) =>
                    setSmtpDraft((current) => ({ ...current, port: event.target.value }))
                  }
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Transport security"
                description="Use STARTTLS for explicit TLS or TLS for implicit TLS."
                help="STARTTLS begins as a normal SMTP connection and upgrades to encryption, commonly on port 587. TLS is encrypted from the first byte, commonly on port 465."
              >
                <Select
                  value={smtpDraft.tlsMode}
                  disabled={!canEditIdentityTrust || isSavingLocalAuth}
                  onValueChange={(tlsMode: "starttls" | "tls") =>
                    setSmtpDraft((current) => ({ ...current, tlsMode }))
                  }
                >
                  <SelectTrigger aria-label="SMTP transport security" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="starttls">STARTTLS</SelectItem>
                    <SelectItem value="tls">TLS</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsControlRow>
            </>
          )}
          {showsSmtpUsername && (
            <SettingsControlRow title="SMTP username" description={smtpUsernameDescription}>
              <Input
                aria-label="SMTP username"
                value={smtpDraft.username}
                placeholder="SMTP username"
                disabled={!canEditIdentityTrust || isSavingLocalAuth}
                onChange={(event) =>
                  setSmtpDraft((current) => ({ ...current, username: event.target.value }))
                }
              />
            </SettingsControlRow>
          )}
          <SettingsControlRow
            title="SMTP password"
            description={`${smtpPasswordDescription} ${settings.smtp?.configured ? "Leave blank to keep the saved password." : ""}`}
          >
            <Input
              aria-label="SMTP password"
              value={smtpDraft.password}
              type="password"
              placeholder={
                settings.smtp?.configured
                  ? settings.smtp.passwordLast4
                    ? `****${settings.smtp.passwordLast4}`
                    : "Configured — enter new to replace"
                  : "SMTP password or API key"
              }
              disabled={!canEditIdentityTrust || isSavingLocalAuth}
              onChange={(event) =>
                setSmtpDraft((current) => ({ ...current, password: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Sender name"
            description="Display name recipients see in their inbox."
          >
            <Input
              aria-label="Sender name"
              value={smtpDraft.senderName}
              placeholder="Opfield"
              disabled={!canEditIdentityTrust || isSavingLocalAuth}
              onChange={(event) =>
                setSmtpDraft((current) => ({ ...current, senderName: event.target.value }))
              }
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Sender email"
            description="Use an address verified by your email provider."
          >
            <Input
              aria-label="Sender email"
              value={smtpDraft.senderEmail}
              type="email"
              placeholder="security@example.com"
              disabled={!canEditIdentityTrust || isSavingLocalAuth}
              onChange={(event) =>
                setSmtpDraft((current) => ({ ...current, senderEmail: event.target.value }))
              }
            />
          </SettingsControlRow>
        </div>
      </PanelShell>

      <Dialog open={smtpTestOpen} onOpenChange={setSmtpTestOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send SMTP Test</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Save the current SMTP configuration and send a test message to this address.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="smtp-test-email-kind">
                Email type
              </label>
              <Select
                value={smtpTestEmailKind}
                disabled={isSavingLocalAuth}
                onValueChange={(value) => setSmtpTestEmailKind(value as SmtpTestEmailKind)}
              >
                <SelectTrigger
                  id="smtp-test-email-kind"
                  aria-label="SMTP test email type"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SMTP_TEST_EMAIL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {
                  SMTP_TEST_EMAIL_OPTIONS.find((option) => option.value === smtpTestEmailKind)
                    ?.description
                }
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="smtp-test-recipient">
                Recipient
              </label>
              <Input
                id="smtp-test-recipient"
                aria-label="Test recipient"
                value={smtpTestRecipient}
                type="email"
                placeholder="you@example.com"
                disabled={isSavingLocalAuth}
                onChange={(event) => setSmtpTestRecipient(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSmtpTestOpen(false)}
              disabled={isSavingLocalAuth}
            >
              Cancel
            </Button>
            <Button
              onClick={() => saveSmtp(smtpTestRecipient)}
              pending={isSendingSmtpTest}
              disabled={isSavingLocalAuth || !smtpTestRecipient}
            >
              Send test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PanelShell
        hidden={section !== "all" && section !== "features"}
        title="OAuth and MCP access"
        description="Remote client compatibility and tool access"
        icon={<ShieldCheck className="h-4 w-4" />}
      >
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Enable MCP server"
                  help="Exposes Opfield tools through the remote Model Context Protocol endpoint. MCP clients complete OAuth authorization and connect through /api/mcp; users still need the required account scopes."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Allow MCP-enabled user accounts to access the remote MCP endpoint with OAuth
              </p>
            </div>
            <Switch
              checked={settings.mcpServerEnabled}
              disabled={!canEdit || isSavingMcp}
              onChange={handleToggleMcpServer}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Extended MCP compatibility"
                  help="Uses Opfield's broader compatibility behavior for clients that discover tools incrementally. Disable only for a client that cannot handle the expanded tool catalog."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Keep this enabled unless your harness loads every tool into its context at once and
                exhausts it. Turning it off can prevent that harness from using some Opfield tools.
              </p>
            </div>
            <Switch
              ariaLabel="Enable extended MCP compatibility"
              checked={settings.mcpExtendedCompatibility}
              disabled={!canEdit || isSavingMcpCompatibility}
              onChange={handleToggleMcpCompatibility}
            />
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="OAuth extended callback compatibility"
                  help="Allows unverified OAuth clients to use external HTTPS callback addresses instead of loopback-only callbacks. This broadens compatibility and the callback trust boundary."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Allow unverified OAuth clients to register external HTTPS callback URLs. Leave
                disabled for loopback-only CLI and MCP clients.
              </p>
            </div>
            <Switch
              checked={settings.oauthExtendedCallbackCompatibility}
              disabled={!canEdit || isSavingOAuthCompatibility}
              onChange={handleToggleOAuthCompatibility}
            />
          </div>
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Network trust"
        description={
          cloudManaged
            ? "Client address detection for rate limits and audit records · Managed by Opfield Cloud"
            : "Client address detection for rate limits and audit records"
        }
        icon={<Network className="h-4 w-4" />}
      >
        <div className="divide-y divide-border">
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Client IP source"
                  help="Selects which network address Opfield treats as the real client. This affects rate limiting and audit records, so it must match your reverse-proxy topology."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Controls which address Opfield uses for rate limits and audit records
              </p>
            </div>
            <div className="w-full shrink-0 sm:w-64">
              <Select
                value={settings.networkSecurity.clientIpSource}
                disabled={!canEdit || isSavingNetwork || cloudManaged}
                onValueChange={(clientIpSource) =>
                  updateNetworkSecurity({
                    clientIpSource:
                      clientIpSource as AuthProvisioningSettings["networkSecurity"]["clientIpSource"],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="direct">Direct connection</SelectItem>
                  <SelectItem value="reverse_proxy">Reverse proxy</SelectItem>
                  <SelectItem value="cloudflare">Cloudflare</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            <div className="px-4 py-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Resolved IP</p>
              <p className="mt-1 font-mono text-sm">
                {settings.currentRequestIp.ipAddress ?? "unknown"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Remote peer</p>
              <p className="mt-1 font-mono text-sm">
                {settings.currentRequestIp.remoteAddress ?? "unknown"}
              </p>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Source</p>
              <p className="mt-1 font-mono text-sm">{settings.currentRequestIp.source}</p>
            </div>
          </div>

          {settings.currentRequestIp.warning && (
            <p className="bg-muted/60 px-4 py-3 text-xs text-muted-foreground dark:bg-muted">
              {settings.currentRequestIp.warning}
            </p>
          )}

          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Trusted proxy CIDRs"
                  help="Only connections from these network ranges may supply forwarded client-IP headers. CIDR is a network range notation such as 10.0.0.0/8."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Comma-separated proxy ranges allowed to provide forwarded client headers. Empty
                trusts all peers in reverse proxy mode.
              </p>
            </div>
            <Input
              className="w-full shrink-0 sm:max-w-80"
              value={trustedProxyCidrs}
              disabled={!canEdit || isSavingNetwork || cloudManaged}
              placeholder="10.0.0.0/8, 172.16.0.0/12"
              onChange={(event) => {
                skipNextCidrsBlur.current = false;
                setTrustedProxyCidrs(event.target.value);
              }}
              onBlur={() => {
                if (skipNextCidrsBlur.current) {
                  skipNextCidrsBlur.current = false;
                  return;
                }
                saveTrustedProxyCidrs();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  skipNextCidrsBlur.current = true;
                  saveTrustedProxyCidrs();
                }
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Trust Cloudflare headers without edge IP check"
                  help="Accepts Cloudflare client-IP headers without verifying that the direct peer is a known Cloudflare edge. Enable only when the origin cannot be reached outside Cloudflare."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enable only when direct origin access is blocked outside Cloudflare
              </p>
            </div>
            <Switch
              checked={settings.networkSecurity.trustCloudflareHeaders}
              disabled={!canEdit || isSavingNetwork || cloudManaged}
              onChange={(trustCloudflareHeaders) =>
                updateNetworkSecurity({ trustCloudflareHeaders })
              }
            />
          </div>
        </div>
      </PanelShell>

      <PanelShell
        hidden={section !== "all" && section !== "advanced"}
        title="Outbound webhook policy"
        description="Private-network delivery rules for notification webhooks"
        icon={<Webhook className="h-4 w-4" />}
      >
        <div className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Allow private network webhooks"
                  help="Permits notification delivery to selected private network ranges. Localhost, link-local, multicast, metadata, and Opfield-local destinations remain blocked."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Notification webhooks may call the private CIDRs below. Local Opfield addresses,
                localhost, link-local, multicast, and metadata endpoints stay blocked.
              </p>
            </div>
            <Switch
              checked={settings.outboundWebhookPolicy.allowPrivateNetworks}
              disabled={!canEdit || isSavingWebhookPolicy}
              onChange={(allowPrivateNetworks) =>
                updateOutboundWebhookPolicy({ allowPrivateNetworks })
              }
            />
          </div>

          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="text-sm font-medium">
                <SettingsHelpTitle
                  label="Allowed private webhook CIDRs"
                  help="Private network ranges that notification webhooks may call. Keep the list as narrow as possible because these destinations are not publicly reachable."
                />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Comma-separated private ranges for notification webhook delivery. Defaults allow
                common enterprise networks.
              </p>
            </div>
            <Input
              className="w-full shrink-0 sm:max-w-80"
              value={webhookPrivateCidrs}
              disabled={
                !canEdit ||
                isSavingWebhookPolicy ||
                !settings.outboundWebhookPolicy.allowPrivateNetworks
              }
              placeholder="10.0.0.0/8, 172.16.0.0/12"
              onChange={(event) => {
                skipNextWebhookCidrsBlur.current = false;
                setWebhookPrivateCidrs(event.target.value);
              }}
              onBlur={() => {
                if (skipNextWebhookCidrsBlur.current) {
                  skipNextWebhookCidrsBlur.current = false;
                  return;
                }
                saveWebhookPrivateCidrs();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  skipNextWebhookCidrsBlur.current = true;
                  saveWebhookPrivateCidrs();
                }
              }}
            />
          </div>
        </div>
      </PanelShell>
    </div>
  );
}

function CloudManagedHint() {
  return <span className="text-muted-foreground">Managed by Opfield Cloud.</span>;
}

function IdentityTrustHint({ action = "change this" }: { action?: string }) {
  return (
    <span className="text-muted-foreground">Requires the admin:system permission to {action}.</span>
  );
}
