import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import { handleLicenseApiError } from "@/stores/license-paywall";
import {
  DEFAULT_OPFIELD_FEATURES,
  useSystemConfigStore,
  withDefaultSystemConfig,
} from "@/stores/system-config";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { AuthProvisioningSettings } from "@/types";
import {
  applySmtpPreset,
  DEFAULT_SMTP_DRAFT,
  getSmtpPresetId,
  SMTP_PRESETS,
  type SmtpDraft,
  type SmtpPresetId,
} from "./smtp-presets";

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_FILE_UPLOAD_MAX_BYTES = 100 * BYTES_PER_MEGABYTE;
const DEFAULT_FILE_OPEN_MAX_BYTES = 10 * BYTES_PER_MEGABYTE;
const DEFAULT_GENERAL_FEATURES = {
  pkiEnabled: DEFAULT_OPFIELD_FEATURES.pkiEnabled,
  domainsEnabled: DEFAULT_OPFIELD_FEATURES.domainsEnabled,
  siemEnabled: DEFAULT_OPFIELD_FEATURES.siemEnabled,
  inferenceEnabled: DEFAULT_OPFIELD_FEATURES.inferenceEnabled,
};
const DEFAULT_SHUTDOWN_SETTINGS = {
  userRequestDrainSeconds: 30,
  structuredLogDrainSeconds: 5,
  finalizationTimeoutSeconds: 10,
};
const DEFAULT_GENERAL_SETTINGS = {
  publicUrl: null as string | null,
  updateChannel: "stable" as const,
  hideExternalBranding: false,
  autoAssignCreatedResourcePermissions: true,
  sendInvitationOnUserCreate: false,
  fileUploadMaxBytes: DEFAULT_FILE_UPLOAD_MAX_BYTES,
  fileOpenMaxBytes: DEFAULT_FILE_OPEN_MAX_BYTES,
  grpcPublicTarget: null as string | null,
  grpcLocalIp: null as string | null,
  relayAutoRecovery: true,
  relayGrantTtlHours: 4,
  relayPolicyLeaseHours: 72,
  shutdown: DEFAULT_SHUTDOWN_SETTINGS,
  features: DEFAULT_GENERAL_FEATURES,
};
export const DEFAULT_AUTH_METHODS = {
  oidc: true,
  password: false,
  emailOtp: false,
  passkeyLogin: false,
};
const DEFAULT_PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 72,
  requireUppercase: false,
  requireLowercase: false,
  requireDigit: false,
  requireSymbol: false,
};
const DEFAULT_MFA_EXISTING_SESSION_GRACE_PERIOD_DAYS = 3;

export type SmtpTestEmailKind =
  | "smtp_configuration"
  | "password_setup"
  | "password_reset"
  | "email_otp";

export const SMTP_TEST_EMAIL_OPTIONS: Array<{
  value: SmtpTestEmailKind;
  label: string;
  description: string;
}> = [
  {
    value: "smtp_configuration",
    label: "SMTP configuration",
    description: "Basic delivery check.",
  },
  {
    value: "password_setup",
    label: "Set password link",
    description: "Invitation email for a new password account.",
  },
  {
    value: "password_reset",
    label: "Reset password link",
    description: "Recovery email for an existing password account.",
  },
  {
    value: "email_otp",
    label: "Email sign-in code",
    description: "One-time code used by email OTP sign-in.",
  },
];

const DEFAULT_OIDC_DRAFT = {
  issuer: "",
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  scopes: "openid email profile",
  displayName: "",
};
const DEFAULT_LOGGING_DRAFT = {
  mode: "disabled" as "disabled" | "local" | "external",
  url: "",
  username: "",
  password: "",
  database: "opfield_logs",
  table: "logs",
  requestTimeoutMs: "5000",
};

function bytesToMegabytes(bytes: number) {
  return Math.round(bytes / BYTES_PER_MEGABYTE);
}

function withDefaultGeneralSettings(settings: AuthProvisioningSettings | null) {
  if (!settings) return null;
  return {
    ...settings,
    methods: { ...DEFAULT_AUTH_METHODS, ...settings.methods },
    passwordPolicy: { ...DEFAULT_PASSWORD_POLICY, ...settings.passwordPolicy },
    mfaExistingSessionGracePeriodDays:
      settings.mfaExistingSessionGracePeriodDays ?? DEFAULT_MFA_EXISTING_SESSION_GRACE_PERIOD_DAYS,
    mcpExtendedCompatibility: settings.mcpExtendedCompatibility ?? true,
    webTransport: settings.webTransport ?? {
      tlsEnabled: false,
      restartRequired: false,
      directAccess: false,
      targetUrl: null,
    },
    generalSettings: {
      ...DEFAULT_GENERAL_SETTINGS,
      ...settings.generalSettings,
      features: {
        ...DEFAULT_GENERAL_FEATURES,
        ...settings.generalSettings?.features,
      },
      shutdown: {
        ...DEFAULT_SHUTDOWN_SETTINGS,
        ...settings.generalSettings?.shutdown,
      },
    },
  };
}

function getMfaExistingSessionGracePeriodDays(
  settings: AuthProvisioningSettings | null | undefined
) {
  return (
    settings?.mfaExistingSessionGracePeriodDays ?? DEFAULT_MFA_EXISTING_SESSION_GRACE_PERIOD_DAYS
  );
}

// Drafts start from cached settings as well, so a cached page does not show
// empty provider fields that fill in (and a dirty marker that clears) a moment later.
function oidcDraftFrom(settings: AuthProvisioningSettings | null | undefined) {
  if (!settings) return DEFAULT_OIDC_DRAFT;
  return {
    issuer: settings.oidc?.issuer ?? "",
    clientId: settings.oidc?.clientId ?? "",
    clientSecret: "",
    redirectUri: settings.oidc?.redirectUri ?? "",
    scopes: settings.oidc?.scopes ?? "openid email profile",
    displayName: settings.oidc?.displayName ?? "",
  };
}

function loggingDraftFrom(settings: AuthProvisioningSettings | null | undefined) {
  if (!settings) return DEFAULT_LOGGING_DRAFT;
  return {
    mode: settings.logging?.mode ?? "disabled",
    url: settings.logging?.url ?? "",
    username: settings.logging?.username ?? "",
    password: "",
    database: settings.logging?.database ?? "opfield_logs",
    table: settings.logging?.table ?? "logs",
    requestTimeoutMs: String(settings.logging?.requestTimeoutMs ?? 5000),
  };
}

function smtpDraftFrom(settings: AuthProvisioningSettings, current: SmtpDraft): SmtpDraft {
  return {
    ...current,
    host: settings.smtp?.host ?? DEFAULT_SMTP_DRAFT.host,
    port: String(settings.smtp?.port ?? DEFAULT_SMTP_DRAFT.port),
    tlsMode: settings.smtp?.tlsMode ?? DEFAULT_SMTP_DRAFT.tlsMode,
    username: settings.smtp?.username ?? DEFAULT_SMTP_DRAFT.username,
    senderName: settings.smtp?.senderName ?? "Opfield",
    senderEmail: settings.smtp?.senderEmail ?? "",
  };
}

function smtpPresetFrom(settings: AuthProvisioningSettings | null | undefined): SmtpPresetId {
  return settings?.smtp?.host ? getSmtpPresetId(settings.smtp.host) : "resend";
}

export function useAuthProvisioningSettings(canEdit: boolean) {
  const licenseFeatures = useUIBootstrapStore(
    (state) => state.snapshot?.license.entitlements.features
  );
  const pkiEntitled = licenseFeatures?.includes("internal-pki") === true;
  const siemEntitled = licenseFeatures?.includes("siem-export") === true;
  const [settings, setSettings] = useState<AuthProvisioningSettings | null>(() =>
    withDefaultGeneralSettings(
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning") ?? null
    )
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(settings !== null);
  const [isSavingAutoCreate, setIsSavingAutoCreate] = useState(false);
  const [isSavingVerifiedEmail, setIsSavingVerifiedEmail] = useState(false);
  const [isSavingGroup, setIsSavingGroup] = useState(false);
  const [isSavingGeneral, setIsSavingGeneral] = useState(false);
  const [isSavingWebTls, setIsSavingWebTls] = useState(false);
  const [isSavingMcp, setIsSavingMcp] = useState(false);
  const [isSavingMcpCompatibility, setIsSavingMcpCompatibility] = useState(false);
  const [isSavingOAuthCompatibility, setIsSavingOAuthCompatibility] = useState(false);
  const [isSavingNetwork, setIsSavingNetwork] = useState(false);
  const [isSavingWebhookPolicy, setIsSavingWebhookPolicy] = useState(false);
  const [isSavingLocalAuth, setIsSavingLocalAuth] = useState(false);
  const [isSavingMfaGracePeriod, setIsSavingMfaGracePeriod] = useState(false);
  const [isSavingOidc, setIsSavingOidc] = useState(false);
  const [oidcDraft, setOidcDraft] = useState(() =>
    oidcDraftFrom(api.getCached<AuthProvisioningSettings>("settings:auth-provisioning"))
  );
  const [isSavingLogging, setIsSavingLogging] = useState(false);
  const [loggingDraft, setLoggingDraft] = useState(() =>
    loggingDraftFrom(api.getCached<AuthProvisioningSettings>("settings:auth-provisioning"))
  );
  const [mfaGracePeriodDays, setMfaGracePeriodDays] = useState(() =>
    getMfaExistingSessionGracePeriodDays(
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")
    )
  );
  const [mfaGracePeriodRaw, setMfaGracePeriodRaw] = useState(() =>
    String(
      getMfaExistingSessionGracePeriodDays(
        api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")
      )
    )
  );
  const [mfaGracePeriodInputKey, setMfaGracePeriodInputKey] = useState(0);
  const [publicUrl, setPublicUrl] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.publicUrl ?? ""
  );
  const [hideExternalBranding, setHideExternalBranding] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.hideExternalBranding ?? false
  );
  const [updateChannel, setUpdateChannel] = useState<"stable" | "preview">(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.updateChannel ?? "stable"
  );
  const [smtpDraft, setSmtpDraft] = useState<SmtpDraft>(() => {
    const cached = api.getCached<AuthProvisioningSettings>("settings:auth-provisioning");
    return cached ? smtpDraftFrom(cached, DEFAULT_SMTP_DRAFT) : DEFAULT_SMTP_DRAFT;
  });
  const [smtpPreset, setSmtpPreset] = useState<SmtpPresetId>(() =>
    smtpPresetFrom(api.getCached<AuthProvisioningSettings>("settings:auth-provisioning"))
  );
  const [smtpTestOpen, setSmtpTestOpen] = useState(false);
  const [smtpTestRecipient, setSmtpTestRecipient] = useState("");
  const [smtpTestEmailKind, setSmtpTestEmailKind] =
    useState<SmtpTestEmailKind>("smtp_configuration");
  const [isSendingSmtpTest, setIsSendingSmtpTest] = useState(false);
  // Managed installations with Opfield Cloud email: "Use my own SMTP" shows the form; the first save switches.
  const [ownSmtpDraft, setOwnSmtpDraft] = useState(false);
  const [trustedProxyCidrs, setTrustedProxyCidrs] = useState(
    () =>
      api
        .getCached<AuthProvisioningSettings>("settings:auth-provisioning")
        ?.networkSecurity.trustedProxyCidrs.join(", ") ?? ""
  );
  const [webhookPrivateCidrs, setWebhookPrivateCidrs] = useState(
    () =>
      api
        .getCached<AuthProvisioningSettings>("settings:auth-provisioning")
        ?.outboundWebhookPolicy.allowedPrivateCidrs.join(", ") ?? ""
  );
  const [fileUploadLimitMb, setFileUploadLimitMb] = useState(() =>
    String(
      bytesToMegabytes(
        api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
          ?.fileUploadMaxBytes ?? DEFAULT_FILE_UPLOAD_MAX_BYTES
      )
    )
  );
  const [fileOpenLimitMb, setFileOpenLimitMb] = useState(() =>
    String(
      bytesToMegabytes(
        api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
          ?.fileOpenMaxBytes ?? DEFAULT_FILE_OPEN_MAX_BYTES
      )
    )
  );
  const [grpcPublicTarget, setGrpcPublicTarget] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.grpcPublicTarget ?? ""
  );
  const [grpcLocalIp, setGrpcLocalIp] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.grpcLocalIp ?? ""
  );
  const [relayGrantTtlHours, setRelayGrantTtlHours] = useState(() =>
    String(
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.relayGrantTtlHours ?? 4
    )
  );
  const [pkiEnabled, setPkiEnabled] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.features?.pkiEnabled ?? DEFAULT_OPFIELD_FEATURES.pkiEnabled
  );
  const [siemEnabled, setSiemEnabled] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.features?.siemEnabled ?? DEFAULT_OPFIELD_FEATURES.siemEnabled
  );
  const [inferenceEnabled, setInferenceEnabled] = useState(
    () =>
      api.getCached<AuthProvisioningSettings>("settings:auth-provisioning")?.generalSettings
        ?.features?.inferenceEnabled ?? DEFAULT_OPFIELD_FEATURES.inferenceEnabled
  );
  const skipNextCidrsBlur = useRef(false);
  const skipNextWebhookCidrsBlur = useRef(false);
  const hasUnsavedDraftRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const settingsData = await api.getAuthProvisioningSettings();
      const normalizedSettings = withDefaultGeneralSettings(settingsData)!;
      api.setCache("settings:auth-provisioning", normalizedSettings);
      setSettings(normalizedSettings);
      const mfaGracePeriodDays = getMfaExistingSessionGracePeriodDays(normalizedSettings);
      setMfaGracePeriodDays(mfaGracePeriodDays);
      setMfaGracePeriodRaw(String(mfaGracePeriodDays));
      setMfaGracePeriodInputKey((key) => key + 1);
      setSmtpDraft((current) => smtpDraftFrom(settingsData, current));
      setSmtpPreset(smtpPresetFrom(settingsData));
      setOidcDraft(oidcDraftFrom(settingsData));
      setLoggingDraft(loggingDraftFrom(settingsData));
      setPublicUrl(settingsData.generalSettings.publicUrl ?? "");
      setHideExternalBranding(settingsData.generalSettings.hideExternalBranding ?? false);
      setUpdateChannel(settingsData.generalSettings.updateChannel ?? "stable");
      setTrustedProxyCidrs(settingsData.networkSecurity.trustedProxyCidrs.join(", "));
      setWebhookPrivateCidrs(settingsData.outboundWebhookPolicy.allowedPrivateCidrs.join(", "));
      setFileUploadLimitMb(
        String(bytesToMegabytes(settingsData.generalSettings.fileUploadMaxBytes))
      );
      setFileOpenLimitMb(String(bytesToMegabytes(settingsData.generalSettings.fileOpenMaxBytes)));
      setGrpcPublicTarget(settingsData.generalSettings.grpcPublicTarget ?? "");
      setGrpcLocalIp(settingsData.generalSettings.grpcLocalIp ?? "");
      setRelayGrantTtlHours(String(settingsData.generalSettings.relayGrantTtlHours));
      setPkiEnabled(settingsData.generalSettings.features?.pkiEnabled ?? true);
      setSiemEnabled(settingsData.generalSettings.features?.siemEnabled ?? true);
      setInferenceEnabled(settingsData.generalSettings.features?.inferenceEnabled ?? false);
    } catch (err) {
      toastApiError(err, "Failed to load Opfield settings");
    } finally {
      setInitialLoadComplete(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  const reloadIfDraftClean = useCallback(() => {
    if (!hasUnsavedDraftRef.current) void load();
  }, [load]);
  useRealtime("system.config.changed", reloadIfDraftClean, { onReconnect: reloadIfDraftClean });

  const selectedGroup = useMemo(
    () =>
      settings?.availableGroups.find((group) => group.id === settings.oidcDefaultGroupId) ?? null,
    [settings]
  );

  const applySettings = (updated: AuthProvisioningSettings) => {
    const normalizedSettings = withDefaultGeneralSettings(updated)!;
    api.setCache("settings:auth-provisioning", normalizedSettings);
    setSettings(normalizedSettings);
  };

  const handleToggleAutoCreate = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingAutoCreate(true);
    const previous = settings;
    setSettings({ ...settings, oidcAutoCreateUsers: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({ oidcAutoCreateUsers: checked });
      applySettings(updated);
      toast.success("Opfield settings updated");
      if (updated.webTransport?.restartRequired) {
        toast.success("Opfield is restarting with the refreshed web certificate");
        useAppStatusStore
          .getState()
          .setOpfieldRestartingActive(
            true,
            updated.webTransport.directAccess ? updated.webTransport.targetUrl : null
          );
      }
    } catch (err) {
      setSettings(previous);
      toastApiError(err, "Failed to update Opfield settings");
    } finally {
      setIsSavingAutoCreate(false);
    }
  };

  const handleChangeGroup = async (groupId: string) => {
    if (!settings || !canEdit) return;
    setIsSavingGroup(true);
    const previous = settings;
    setSettings({ ...settings, oidcDefaultGroupId: groupId });
    try {
      const updated = await api.updateAuthProvisioningSettings({ oidcDefaultGroupId: groupId });
      applySettings(updated);
      toast.success("Default OIDC group updated");
    } catch (err) {
      setSettings(previous);
      toastApiError(err, "Failed to update default OIDC group");
    } finally {
      setIsSavingGroup(false);
    }
  };

  const handleToggleRequireVerifiedEmail = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingVerifiedEmail(true);
    const previous = settings;
    setSettings({ ...settings, oidcRequireVerifiedEmail: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        oidcRequireVerifiedEmail: checked,
      });
      applySettings(updated);
      toast.success("OIDC email verification setting updated");
    } catch (err) {
      setSettings(previous);
      toastApiError(err, "Failed to update OIDC email verification setting");
    } finally {
      setIsSavingVerifiedEmail(false);
    }
  };

  const handleToggleWebTls = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingWebTls(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({ webTlsEnabled: checked });
      applySettings(withDefaultGeneralSettings(updated)!);
      if (updated.webTransport?.restartRequired) {
        toast.success("Opfield is restarting with the new internal protocol");
        useAppStatusStore
          .getState()
          .setOpfieldRestartingActive(
            true,
            updated.webTransport.directAccess ? updated.webTransport.targetUrl : null
          );
      }
    } catch (err) {
      toastApiError(err, "Failed to update internal HTTPS");
    } finally {
      setIsSavingWebTls(false);
    }
  };

  const saveOidc = async () => {
    if (!settings || !canEdit || !oidcHasChanges) return;
    setIsSavingOidc(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({
        oidc: {
          issuer: oidcDraft.issuer.trim(),
          clientId: oidcDraft.clientId.trim(),
          ...(oidcDraft.clientSecret ? { clientSecret: oidcDraft.clientSecret } : {}),
          redirectUri: oidcDraft.redirectUri.trim(),
          scopes: oidcDraft.scopes.trim(),
          displayName: oidcDraft.displayName.trim() || null,
        },
      });
      applySettings(withDefaultGeneralSettings(updated)!);
      setOidcDraft((current) => ({ ...current, clientSecret: "" }));
      toast.success("OIDC provider updated");
    } catch (err) {
      toastApiError(err, "Failed to update OIDC provider");
    } finally {
      setIsSavingOidc(false);
    }
  };

  // Remove the provider (OIDC sign-in turns off); bring back the Opfield account provider (OIDC sign-in turns on), or
  // ask the Opfield account for a client when the cloud gave none yet; or withdraw that request.
  const runOidcProviderAction = async (
    action: "remove" | "opfield_account" | "cancel_opfield_account"
  ) => {
    if (!settings || !canEdit) return;
    if (action === "remove") {
      const ok = await confirm({
        title: "Remove OIDC provider",
        description:
          "Remove the OIDC provider and turn OIDC sign-in off? Users who sign in only with it need another sign-in method.",
        confirmLabel: "Remove",
        variant: "destructive",
      });
      if (!ok) return;
    }
    setIsSavingOidc(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({ oidcProviderAction: action });
      applySettings(withDefaultGeneralSettings(updated)!);
      setOidcDraft(oidcDraftFrom(updated));
      toast.success(
        action === "remove"
          ? "OIDC provider removed"
          : action === "cancel_opfield_account"
            ? "Request to your Opfield account cancelled"
            : updated.opfieldAccountSignIn?.pendingRequest
              ? "Waiting for your Opfield account"
              : "Sign-in with the Opfield account is on"
      );
    } catch (err) {
      toastApiError(
        err,
        action === "remove"
          ? "Failed to remove OIDC provider"
          : action === "cancel_opfield_account"
            ? "Failed to cancel the request"
            : "Failed to use the Opfield account for sign-in"
      );
    } finally {
      setIsSavingOidc(false);
    }
  };

  // While the Opfield account has not answered, look again every few seconds besides the realtime update.
  const waitingForOpfieldAccount = Boolean(settings?.opfieldAccountSignIn?.pendingRequest);
  useEffect(() => {
    if (!waitingForOpfieldAccount) return;
    const timer = setInterval(reloadIfDraftClean, 5000);
    return () => clearInterval(timer);
  }, [waitingForOpfieldAccount, reloadIfDraftClean]);

  const saveLogging = async () => {
    if (!settings || !canEdit || !loggingHasChanges) return;
    setIsSavingLogging(true);
    try {
      const external = loggingDraft.mode === "external";
      const updated = await api.updateAuthProvisioningSettings({
        logging: {
          mode: loggingDraft.mode,
          ...(external
            ? {
                url: loggingDraft.url.trim(),
                username: loggingDraft.username.trim(),
                ...(loggingDraft.password ? { password: loggingDraft.password } : {}),
                database: loggingDraft.database.trim(),
                table: loggingDraft.table.trim(),
                requestTimeoutMs: Number(loggingDraft.requestTimeoutMs),
              }
            : {}),
        },
      });
      applySettings(withDefaultGeneralSettings(updated)!);
      setLoggingDraft((current) => ({ ...current, password: "" }));
      toast.success(
        loggingDraft.mode === "disabled"
          ? "Structured logging disabled; local data was preserved"
          : "Structured logging updated"
      );
    } catch (err) {
      if (!handleLicenseApiError(err, "Structured logging")) {
        toastApiError(err, "Failed to update structured logging");
      }
    } finally {
      setIsSavingLogging(false);
    }
  };

  const updateGeneralSettings = async (
    patch: Partial<AuthProvisioningSettings["generalSettings"]>
  ) => {
    if (!settings || !canEdit) return;
    setIsSavingGeneral(true);
    const previous = settings;
    const nextGeneralSettings = {
      ...settings.generalSettings,
      ...patch,
      features: {
        ...settings.generalSettings.features,
        ...patch.features,
      },
    };
    setSettings({ ...settings, generalSettings: nextGeneralSettings });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        generalSettings: nextGeneralSettings,
      });
      const nextSettings = withDefaultGeneralSettings(updated)!;
      applySettings(nextSettings);
      setFileUploadLimitMb(String(bytesToMegabytes(updated.generalSettings.fileUploadMaxBytes)));
      setFileOpenLimitMb(String(bytesToMegabytes(updated.generalSettings.fileOpenMaxBytes)));
      setGrpcPublicTarget(updated.generalSettings.grpcPublicTarget ?? "");
      setGrpcLocalIp(updated.generalSettings.grpcLocalIp ?? "");
      setRelayGrantTtlHours(String(updated.generalSettings.relayGrantTtlHours));
      setPublicUrl(updated.generalSettings.publicUrl ?? "");
      setHideExternalBranding(updated.generalSettings.hideExternalBranding ?? false);
      setUpdateChannel(nextSettings.generalSettings.updateChannel);
      setPkiEnabled(nextSettings.generalSettings.features.pkiEnabled);
      setSiemEnabled(nextSettings.generalSettings.features.siemEnabled);
      setInferenceEnabled(nextSettings.generalSettings.features.inferenceEnabled);
      const currentFeatures = useSystemConfigStore.getState().config.features;
      useSystemConfigStore.getState().setConfig(
        withDefaultSystemConfig({
          fileUploadMaxBytes: nextSettings.generalSettings.fileUploadMaxBytes,
          fileOpenMaxBytes: nextSettings.generalSettings.fileOpenMaxBytes,
          relayAutoRecovery: nextSettings.generalSettings.relayAutoRecovery,
          features: {
            ...currentFeatures,
            ...nextSettings.generalSettings.features,
          },
        })
      );
      toast.success("Opfield settings updated");
    } catch (err) {
      setSettings(previous);
      setFileUploadLimitMb(String(bytesToMegabytes(previous.generalSettings.fileUploadMaxBytes)));
      setFileOpenLimitMb(String(bytesToMegabytes(previous.generalSettings.fileOpenMaxBytes)));
      setGrpcPublicTarget(previous.generalSettings.grpcPublicTarget ?? "");
      setGrpcLocalIp(previous.generalSettings.grpcLocalIp ?? "");
      setRelayGrantTtlHours(String(previous.generalSettings.relayGrantTtlHours));
      setPublicUrl(previous.generalSettings.publicUrl ?? "");
      setHideExternalBranding(previous.generalSettings.hideExternalBranding ?? false);
      setUpdateChannel(previous.generalSettings.updateChannel);
      setPkiEnabled(previous.generalSettings.features.pkiEnabled);
      setSiemEnabled(previous.generalSettings.features.siemEnabled);
      setInferenceEnabled(previous.generalSettings.features.inferenceEnabled);
      const capability = patch.features?.pkiEnabled
        ? "Internal PKI"
        : patch.features?.siemEnabled
          ? "SIEM audit export"
          : "Opfield settings";
      if (!handleLicenseApiError(err, capability)) {
        toastApiError(err, "Failed to update Opfield settings");
      }
    } finally {
      setIsSavingGeneral(false);
    }
  };

  const getDraftFileUploadLimitBytes = () => {
    if (!settings) return;
    const value = Number(fileUploadLimitMb);
    if (!Number.isFinite(value)) return null;
    return Math.round(value) * BYTES_PER_MEGABYTE;
  };

  const getDraftFileOpenLimitBytes = () => {
    if (!settings) return;
    const value = Number(fileOpenLimitMb);
    if (!Number.isFinite(value)) return null;
    return Math.round(value) * BYTES_PER_MEGABYTE;
  };

  const draftFileUploadLimitBytes = getDraftFileUploadLimitBytes();
  const draftFileOpenLimitBytes = getDraftFileOpenLimitBytes();
  const draftGrpcPublicTarget = grpcPublicTarget.trim() || null;
  const draftGrpcLocalIp = grpcLocalIp.trim() || null;
  const draftPublicUrl = publicUrl.trim().replace(/\/$/, "");
  const draftRelayGrantTtlHours = Number(relayGrantTtlHours);
  const accessSettingsHaveChanges =
    draftPublicUrl !== (settings?.generalSettings.publicUrl ?? "") ||
    (draftFileUploadLimitBytes != null &&
      draftFileUploadLimitBytes !== settings?.generalSettings.fileUploadMaxBytes) ||
    (draftFileOpenLimitBytes != null &&
      draftFileOpenLimitBytes !== settings?.generalSettings.fileOpenMaxBytes) ||
    draftGrpcPublicTarget !== settings?.generalSettings.grpcPublicTarget ||
    draftGrpcLocalIp !== settings?.generalSettings.grpcLocalIp ||
    (Number.isInteger(draftRelayGrantTtlHours) &&
      draftRelayGrantTtlHours !== settings?.generalSettings.relayGrantTtlHours);
  const featureSettingsHaveChanges =
    hideExternalBranding !== (settings?.generalSettings.hideExternalBranding ?? false) ||
    updateChannel !== (settings?.generalSettings.updateChannel ?? "stable") ||
    pkiEnabled !== settings?.generalSettings.features.pkiEnabled ||
    siemEnabled !== settings?.generalSettings.features.siemEnabled ||
    inferenceEnabled !== settings?.generalSettings.features.inferenceEnabled;

  const saveAccessSettings = async () => {
    if (!settings) return;
    const nextBytes = getDraftFileUploadLimitBytes();
    const nextOpenBytes = getDraftFileOpenLimitBytes();
    if (nextBytes == null) {
      toast.error("File upload limit must be a number");
      return;
    }
    if (nextOpenBytes == null) {
      toast.error("File open limit must be a number");
      return;
    }
    if (nextBytes < BYTES_PER_MEGABYTE || nextBytes > 500 * BYTES_PER_MEGABYTE) {
      toast.error("File upload limit must be between 1 MB and 500 MB");
      return;
    }
    if (nextOpenBytes < BYTES_PER_MEGABYTE || nextOpenBytes > 100 * BYTES_PER_MEGABYTE) {
      toast.error("File open limit must be between 1 MB and 100 MB");
      return;
    }
    if (
      !Number.isInteger(draftRelayGrantTtlHours) ||
      draftRelayGrantTtlHours < 1 ||
      draftRelayGrantTtlHours > 224
    ) {
      toast.error("Relay grant lifetime must be between 1 and 224 hours");
      return;
    }
    if (!/^https?:\/\/[^/]+$/i.test(draftPublicUrl)) {
      toast.error("Public URL must be an HTTP(S) origin without a path");
      return;
    }
    if (
      draftPublicUrl === settings.generalSettings.publicUrl &&
      nextBytes === settings.generalSettings.fileUploadMaxBytes &&
      nextOpenBytes === settings.generalSettings.fileOpenMaxBytes &&
      draftGrpcPublicTarget === settings.generalSettings.grpcPublicTarget &&
      draftGrpcLocalIp === settings.generalSettings.grpcLocalIp &&
      draftRelayGrantTtlHours === settings.generalSettings.relayGrantTtlHours
    ) {
      return;
    }
    if (
      draftRelayGrantTtlHours > 24 &&
      draftRelayGrantTtlHours !== settings.generalSettings.relayGrantTtlHours
    ) {
      const ok = await confirm({
        title: "Use a long relay grant lifetime?",
        description:
          "If Opfield is unavailable, new relay connections may remain authorized for this many hours. Existing tunnels are still controlled by explicit policy revocation.",
        confirmLabel: "Save",
        variant: "default",
      });
      if (!ok) return;
    }
    await updateGeneralSettings({
      publicUrl: draftPublicUrl,
      fileUploadMaxBytes: nextBytes,
      fileOpenMaxBytes: nextOpenBytes,
      grpcPublicTarget: draftGrpcPublicTarget,
      grpcLocalIp: draftGrpcLocalIp,
      relayGrantTtlHours: draftRelayGrantTtlHours,
    });
  };

  const saveFeatureSettings = async () => {
    if (!settings || !featureSettingsHaveChanges) return;
    await updateGeneralSettings({
      hideExternalBranding,
      updateChannel,
      features: { ...settings.generalSettings.features, pkiEnabled, siemEnabled, inferenceEnabled },
    });
  };
  const handleToggleAutoAssignCreatedResourcePermissions = (checked: boolean) =>
    updateGeneralSettings({ autoAssignCreatedResourcePermissions: checked });

  const handleToggleInvitationOnCreate = (checked: boolean) =>
    updateGeneralSettings({ sendInvitationOnUserCreate: checked });

  const saveShutdownSettings = async (
    shutdown: AuthProvisioningSettings["generalSettings"]["shutdown"]
  ) => {
    const updated = await api.updateAuthProvisioningSettings({
      generalSettings: { shutdown },
    });
    const normalized = withDefaultGeneralSettings(updated)!;
    applySettings(normalized);
    return normalized.generalSettings.shutdown;
  };

  const handleToggleMcpServer = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingMcp(true);
    const previous = settings;
    setSettings({ ...settings, mcpServerEnabled: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({ mcpServerEnabled: checked });
      applySettings(updated);
      toast.success("MCP server setting updated");
    } catch (err) {
      setSettings(previous);
      toastApiError(err, "Failed to update MCP server setting");
    } finally {
      setIsSavingMcp(false);
    }
  };

  const handleToggleMcpCompatibility = async (checked: boolean) => {
    if (!settings || !canEdit) return;
    setIsSavingMcpCompatibility(true);
    const previous = settings;
    setSettings({ ...settings, mcpExtendedCompatibility: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        mcpExtendedCompatibility: checked,
      });
      applySettings(updated);
      toast.success("MCP compatibility setting updated");
    } catch (err) {
      setSettings(previous);
      toastApiError(err, "Failed to update MCP compatibility");
    } finally {
      setIsSavingMcpCompatibility(false);
    }
  };

  const handleToggleOAuthCompatibility = async (checked: boolean) => {
    if (!settings || !canEdit) return;

    if (checked) {
      const ok = await confirm({
        title: "Enable OAuth extended callback compatibility?",
        description:
          "Unverified OAuth clients will be allowed to register external HTTPS callback URLs, and authorization results may be sent to external origins.",
        confirmLabel: "Enable",
        variant: "destructive",
      });
      if (!ok) return;
    }

    setIsSavingOAuthCompatibility(true);
    const previous = settings;
    setSettings({ ...settings, oauthExtendedCallbackCompatibility: checked });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        oauthExtendedCallbackCompatibility: checked,
      });
      applySettings(updated);
      toast.success("OAuth compatibility setting updated");
    } catch (err) {
      setSettings(previous);
      toastApiError(err, "Failed to update OAuth compatibility setting");
    } finally {
      setIsSavingOAuthCompatibility(false);
    }
  };

  const handleToggleInference = (checked: boolean) => setInferenceEnabled(checked);

  const updateNetworkSecurity = async (
    patch: Partial<AuthProvisioningSettings["networkSecurity"]>
  ) => {
    if (!settings || !canEdit) return;
    setIsSavingNetwork(true);
    const previous = settings;
    const nextNetworkSecurity = { ...settings.networkSecurity, ...patch };
    setSettings({ ...settings, networkSecurity: nextNetworkSecurity });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        networkSecurity: nextNetworkSecurity,
      });
      applySettings(updated);
      setTrustedProxyCidrs(updated.networkSecurity.trustedProxyCidrs.join(", "));
      toast.success("Network settings updated");
    } catch (err) {
      setSettings(previous);
      setTrustedProxyCidrs(previous.networkSecurity.trustedProxyCidrs.join(", "));
      toastApiError(err, "Failed to update network settings");
    } finally {
      setIsSavingNetwork(false);
    }
  };

  const saveTrustedProxyCidrs = () => {
    if (!settings) return;
    const cidrs = trustedProxyCidrs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (cidrs.join(",") === settings.networkSecurity.trustedProxyCidrs.join(",")) return;
    updateNetworkSecurity({ trustedProxyCidrs: cidrs });
  };

  const updateOutboundWebhookPolicy = async (
    patch: Partial<AuthProvisioningSettings["outboundWebhookPolicy"]>
  ) => {
    if (!settings || !canEdit) return;
    setIsSavingWebhookPolicy(true);
    const previous = settings;
    const nextPolicy = { ...settings.outboundWebhookPolicy, ...patch };
    setSettings({ ...settings, outboundWebhookPolicy: nextPolicy });
    try {
      const updated = await api.updateAuthProvisioningSettings({
        outboundWebhookPolicy: nextPolicy,
      });
      applySettings(updated);
      setWebhookPrivateCidrs(updated.outboundWebhookPolicy.allowedPrivateCidrs.join(", "));
      toast.success("Outbound webhook policy updated");
    } catch (err) {
      setSettings(previous);
      setWebhookPrivateCidrs(previous.outboundWebhookPolicy.allowedPrivateCidrs.join(", "));
      toastApiError(err, "Failed to update outbound webhook policy");
    } finally {
      setIsSavingWebhookPolicy(false);
    }
  };

  const saveWebhookPrivateCidrs = () => {
    if (!settings) return;
    const cidrs = webhookPrivateCidrs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (cidrs.join(",") === settings.outboundWebhookPolicy.allowedPrivateCidrs.join(",")) return;
    updateOutboundWebhookPolicy({ allowedPrivateCidrs: cidrs });
  };

  const updateLocalAuth = async (
    patch: Parameters<typeof api.updateAuthProvisioningSettings>[0],
    successMessage = "Authentication settings updated"
  ): Promise<boolean> => {
    if (!settings || !canEdit) return false;
    setIsSavingLocalAuth(true);
    try {
      const updated = await api.updateAuthProvisioningSettings(patch);
      applySettings(withDefaultGeneralSettings(updated)!);
      toast.success(successMessage);
      return true;
    } catch (err) {
      toastApiError(err, "Failed to update authentication settings");
      return false;
    } finally {
      setIsSavingLocalAuth(false);
    }
  };

  const saveMfaGracePeriod = async () => {
    if (!settings || !canEdit || !mfaHasChanges) return;
    const gracePeriodDays = Number(mfaGracePeriodRaw);
    if (
      mfaGracePeriodRaw.trim() === "" ||
      !Number.isInteger(gracePeriodDays) ||
      gracePeriodDays < 0 ||
      gracePeriodDays > 7
    ) {
      toast.error("MFA grace period must be a whole number between 0 and 7 days");
      return;
    }

    setIsSavingMfaGracePeriod(true);
    try {
      const updated = await api.updateAuthProvisioningSettings({
        mfaExistingSessionGracePeriodDays: gracePeriodDays,
      });
      const normalizedSettings = withDefaultGeneralSettings(updated)!;
      applySettings(normalizedSettings);
      setMfaGracePeriodDays(normalizedSettings.mfaExistingSessionGracePeriodDays);
      setMfaGracePeriodRaw(String(normalizedSettings.mfaExistingSessionGracePeriodDays));
      setMfaGracePeriodInputKey((key) => key + 1);
      toast.success("MFA grace period updated");
    } catch (err) {
      toastApiError(err, "Failed to update MFA grace period");
    } finally {
      setIsSavingMfaGracePeriod(false);
    }
  };

  /** "Use my own SMTP": on shows the form (the first save switches); off goes back to the cloud email at once. */
  const setOwnSmtp = async (own: boolean) => {
    const cloud = settings?.smtp?.cloud;
    if (!cloud?.available) return;
    setOwnSmtpDraft(own);
    if (!own && cloud.ownSmtp) {
      await updateLocalAuth({ smtpTransport: "cloud" }, "Sign-in emails use Opfield Cloud email");
    }
  };

  const saveSmtp = async (testRecipient?: string) => {
    const cloud = settings?.smtp?.cloud;
    const cloudMailInUse = Boolean(cloud?.active) && !ownSmtpDraft;
    const switchesToOwnSmtp = Boolean(cloud?.available && !cloud.ownSmtp && ownSmtpDraft);
    if (testRecipient && cloudMailInUse) {
      // The cloud email sends the test; there is no SMTP form to save.
      setIsSendingSmtpTest(true);
      try {
        const sent = await updateLocalAuth(
          { mailTest: { recipient: testRecipient, kind: smtpTestEmailKind } },
          "Test email sent"
        );
        if (sent) {
          setSmtpTestRecipient("");
          setSmtpTestOpen(false);
        }
      } finally {
        setIsSendingSmtpTest(false);
      }
      return;
    }
    if (!testRecipient && !smtpHasChanges) {
      // The saved SMTP stays as it is (saving it again would drop its verification); only the transport switches.
      if (switchesToOwnSmtp)
        await updateLocalAuth({ smtpTransport: "smtp" }, "Sign-in emails use your SMTP");
      return;
    }
    const port = Number(smtpDraft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error("SMTP port must be between 1 and 65535");
      return;
    }
    if (testRecipient) setIsSendingSmtpTest(true);
    try {
      const saved = await updateLocalAuth(
        {
          smtp: {
            host: smtpDraft.host,
            port,
            tlsMode: smtpDraft.tlsMode,
            username: smtpDraft.username,
            ...(smtpDraft.password ? { password: smtpDraft.password } : {}),
            senderName: smtpDraft.senderName,
            senderEmail: smtpDraft.senderEmail,
            ...(testRecipient ? { testRecipient, testEmailKind: smtpTestEmailKind } : {}),
          },
          ...(switchesToOwnSmtp ? { smtpTransport: "smtp" as const } : {}),
        },
        testRecipient ? "Test email sent" : "SMTP settings saved"
      );
      if (!saved) return;
      setSmtpDraft((current) => ({ ...current, password: "" }));
      if (testRecipient) {
        setSmtpTestRecipient("");
        setSmtpTestOpen(false);
      }
    } finally {
      if (testRecipient) setIsSendingSmtpTest(false);
    }
  };

  const handleSmtpPresetChange = (presetId: SmtpPresetId) => {
    setSmtpPreset(presetId);
    setSmtpDraft((current) => applySmtpPreset(current, presetId));
  };

  const selectedSmtpPreset = SMTP_PRESETS[smtpPreset];
  const usesProviderPreset = smtpPreset !== "generic";
  const showsSmtpUsername = !usesProviderPreset || smtpPreset === "postmark";
  const smtpUsernameDescription =
    smtpPreset === "resend"
      ? "Resend uses the fixed username resend."
      : smtpPreset === "postmark"
        ? "Use the SMTP access key or Server API token from Postmark."
        : smtpPreset === "sendgrid"
          ? "Twilio SendGrid uses the fixed username apikey."
          : "Username used by your SMTP relay for authentication.";
  const smtpPasswordDescription =
    smtpPreset === "resend"
      ? "Paste a Resend API key."
      : smtpPreset === "postmark"
        ? "Paste the SMTP secret key or Server API token."
        : smtpPreset === "sendgrid"
          ? "Paste a Twilio SendGrid API key."
          : "Password or API key used by your SMTP relay.";

  const oidcHasChanges = Boolean(
    settings &&
      (oidcDraft.issuer.trim() !== (settings.oidc?.issuer ?? "") ||
        oidcDraft.clientId.trim() !== (settings.oidc?.clientId ?? "") ||
        oidcDraft.clientSecret.length > 0 ||
        oidcDraft.redirectUri.trim() !== (settings.oidc?.redirectUri ?? "") ||
        oidcDraft.scopes.trim() !== (settings.oidc?.scopes ?? "openid email profile") ||
        oidcDraft.displayName.trim() !== (settings.oidc?.displayName ?? ""))
  );
  const loggingHasChanges = Boolean(
    settings &&
      (loggingDraft.mode !== (settings.logging?.mode ?? "disabled") ||
        (loggingDraft.mode === "external" &&
          (loggingDraft.url.trim() !== (settings.logging?.url ?? "") ||
            loggingDraft.username.trim() !== (settings.logging?.username ?? "") ||
            loggingDraft.password.length > 0 ||
            loggingDraft.database.trim() !== (settings.logging?.database ?? "opfield_logs") ||
            loggingDraft.table.trim() !== (settings.logging?.table ?? "logs") ||
            Number(loggingDraft.requestTimeoutMs) !==
              (settings.logging?.requestTimeoutMs ?? 5000))))
  );
  const mfaGracePeriodIsValid =
    mfaGracePeriodRaw.trim() !== "" &&
    Number.isInteger(Number(mfaGracePeriodRaw)) &&
    Number(mfaGracePeriodRaw) >= 0 &&
    Number(mfaGracePeriodRaw) <= 7;
  const mfaHasChanges = Boolean(
    settings && mfaGracePeriodRaw.trim() !== String(settings.mfaExistingSessionGracePeriodDays)
  );
  const smtpHasChanges = Boolean(
    settings &&
      (smtpDraft.host !== (settings.smtp?.host ?? DEFAULT_SMTP_DRAFT.host) ||
        smtpDraft.port !== String(settings.smtp?.port ?? DEFAULT_SMTP_DRAFT.port) ||
        smtpDraft.tlsMode !== (settings.smtp?.tlsMode ?? DEFAULT_SMTP_DRAFT.tlsMode) ||
        smtpDraft.username !== (settings.smtp?.username ?? DEFAULT_SMTP_DRAFT.username) ||
        smtpDraft.password.length > 0 ||
        smtpDraft.senderName !== (settings.smtp?.senderName ?? DEFAULT_SMTP_DRAFT.senderName) ||
        smtpDraft.senderEmail !== (settings.smtp?.senderEmail ?? DEFAULT_SMTP_DRAFT.senderEmail))
  );
  const cloudMail = settings?.smtp?.cloud?.available ? settings.smtp.cloud : null;
  /** The SMTP form is shown: no cloud email, or the owner uses (or is switching to) their own SMTP. */
  const showsOwnSmtpForm = !cloudMail || cloudMail.ownSmtp || ownSmtpDraft;
  hasUnsavedDraftRef.current = Boolean(
    accessSettingsHaveChanges ||
      featureSettingsHaveChanges ||
      oidcHasChanges ||
      loggingHasChanges ||
      mfaHasChanges ||
      smtpHasChanges ||
      (settings &&
        trustedProxyCidrs.trim() !== settings.networkSecurity.trustedProxyCidrs.join(", ")) ||
      (settings &&
        webhookPrivateCidrs.trim() !==
          settings.outboundWebhookPolicy.allowedPrivateCidrs.join(", "))
  );

  return {
    pkiEntitled,
    siemEntitled,
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
    grpcPublicTarget,
    setGrpcPublicTarget,
    grpcLocalIp,
    setGrpcLocalIp,
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
    runOidcProviderAction,
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
    cloudMail,
    showsOwnSmtpForm,
    /** Use my own SMTP is on but not saved yet: Save switches. */
    ownSmtpPending: Boolean(cloudMail && !cloudMail.ownSmtp && ownSmtpDraft),
    setOwnSmtp,
  };
}
