import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AuthShell } from "@/components/auth/AuthShell";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ConfirmDialog, confirmAction } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { ConfigureAIWorkspaceWizard } from "./dashboard/finalize-setup/ConfigureAIWorkspaceWizard";
import { DEFAULT_SMTP_DRAFT, getSmtpPresetId, type SmtpPresetId } from "./settings/smtp-presets";
import {
  AdminDetailsStep,
  AIWorkspaceStep,
  FinishStep,
  LicenseStep,
  LoggingStep,
} from "./setup-wizard/SetupFinalSteps";
import { SetupNetworkStep } from "./setup-wizard/SetupNetworkStep";
import { SetupRestoreFlow, SetupStartChoice } from "./setup-wizard/SetupRestoreFlow";
import {
  AdminSecondFactorStep,
  CloudConnectStep,
  SignInStep,
} from "./setup-wizard/SetupSignInSteps";
import { SetupUnlockStep } from "./setup-wizard/SetupUnlockStep";
import { OidcConfigStep, PublicUrlStep, SmtpConfigStep } from "./setup-wizard/SetupWizardForms";
import { SetupRequestError, setupRequest } from "./setup-wizard/setup-request";
import {
  type AdminDraft,
  type CloudCallback,
  deriveGrpcPublicTarget,
  deriveSignInOption,
  getAvailableSignInOptions,
  getSetupSteps,
  getSignInMethods,
  type LoggingDraft,
  type NetworkDraft,
  type OidcDraft,
  oidcRedirectUri,
  readCloudCallback,
  type SetupAdministrator,
  type SetupCloudConnectState,
  type SetupConfig,
  type SetupSmtpDraft,
  type SetupStep,
  type SignInDraft,
} from "./setup-wizard/setup-wizard-model";

interface SetupStatus {
  state: "pending" | "complete";
  code?: { id: string } | null;
  setupInProgress: boolean;
  currentSession: boolean;
}

interface SetupUnlockResult {
  unlocked: true;
  codeId: string;
  csrfToken: string;
}

interface SetupApplyResult {
  status: "ready_for_ai";
}

interface SetupCompleteResult {
  status: "completed";
  restartRequired: boolean;
}

const TLS_RESTART_REDIRECT_DELAY_MS = 20_000;

const EMPTY_CLOUD: SetupCloudConnectState = {
  connected: false,
  accountEmail: null,
  administrator: null,
  signInClient: "none",
  requestedAt: null,
};

/** Where setup sends the browser at the end: the Opfield account sign-in itself, or the sign-in page. */
function signInTarget(signIn: SignInDraft): string {
  return signIn.option === "opfield_account" ? "/auth/login" : "/login";
}

function cloudCallbackError(error: string): string {
  return error === "access_denied"
    ? "The Opfield account connection was cancelled. Connect again or choose another sign-in option."
    : `The Opfield account did not connect this installation (${error}). Connect again or choose another sign-in option.`;
}

/** Before an administrator exists, setup can start a new installation or restore an export. */
type SetupStartMode = "choose" | "new" | "restore";

interface PersistedSetupDraft {
  step: SetupStep;
  publicUrl: string;
  network: NetworkDraft;
  signIn: SignInDraft;
  oidc: Omit<OidcDraft, "clientSecret">;
  smtpPreset: SmtpPresetId;
  smtp: Omit<SetupSmtpDraft, "password">;
  admin: Omit<AdminDraft, "password">;
  logging: Omit<LoggingDraft, "password">;
  autoOidcRedirect: string | null;
  autoGrpcTarget: string | null;
}

function draftStorageKey(codeId: string): string {
  return `opfield:setup-draft:${codeId}`;
}

function readDraft(codeId: string | null): Partial<PersistedSetupDraft> | null {
  if (!codeId) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(draftStorageKey(codeId)) ?? "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function restoreStepWithRequiredSecrets(
  next: SetupConfig,
  saved: Partial<PersistedSetupDraft> | null,
  signIn: SignInDraft,
  availableSteps: SetupStep[]
): SetupStep {
  if (next.phase === "ai_workspace") return next.license.completed ? "ai-workspace" : "license";
  // An administrator made outside this wizard (a managed installation, or an older wizard) goes on at logging.
  if (next.administratorCreated && !next.administrator) return "logging";

  const restoredStep =
    saved?.step && availableSteps.includes(saved.step) ? saved.step : "public-url";
  const restoredIndex = availableSteps.indexOf(restoredStep);
  const requiredSecretSteps: SetupStep[] = [];

  if (
    signIn.option === "opfield_account" &&
    !(next.cloud.connected && next.cloud.signInClient === "ready")
  ) {
    requiredSecretSteps.push("cloud-connect");
  }
  if (signIn.option === "oidc" && !(next.oidc.configured && !next.oidc.opfieldAccount)) {
    requiredSecretSteps.push("oidc-config");
  }
  if (signIn.option === "password_totp" && signIn.emailOtp && !next.smtp.configured) {
    requiredSecretSteps.push("smtp-config");
  }
  // The password is never kept in the draft: the administrator is created on its step.
  if (signIn.option === "password_totp") requiredSecretSteps.push("admin-details");
  if (signIn.option === "password_totp" && !next.administrator?.secondFactor) {
    requiredSecretSteps.push("admin-2fa");
  }
  if (saved?.logging?.mode === "external" && !next.logging.passwordLast4) {
    requiredSecretSteps.push("logging");
  }

  return (
    requiredSecretSteps.find((requiredStep) => {
      const requiredIndex = availableSteps.indexOf(requiredStep);
      return requiredIndex >= 0 && requiredIndex < restoredIndex;
    }) ?? restoredStep
  );
}

function isStructuredLoggingLicensed(config: SetupConfig): boolean {
  return config.license.status.entitlements.features.includes("structured-logging");
}

export function SetupWizardPage() {
  const reducedMotion = useReducedMotion();
  const [unlocked, setUnlocked] = useState(false);
  const [csrfToken, setCsrfToken] = useState("");
  const [draftCodeId, setDraftCodeId] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [setupInProgress, setSetupInProgress] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [aiWorkspaceWizardOpen, setAIWorkspaceWizardOpen] = useState(false);
  const [loadingSession, setLoadingSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<SetupStep>("public-url");
  const [startMode, setStartMode] = useState<SetupStartMode>("choose");
  const [config, setConfig] = useState<SetupConfig | null>(null);
  const [publicUrl, setPublicUrl] = useState("");
  const [network, setNetwork] = useState<NetworkDraft>({
    grpcPublicTarget: "",
    grpcLocalIp: "",
  });
  const [signIn, setSignIn] = useState<SignInDraft>({ option: null, emailOtp: false });
  const [administrator, setAdministrator] = useState<SetupAdministrator | null>(null);
  const [cloud, setCloud] = useState<SetupCloudConnectState>(EMPTY_CLOUD);
  const [cloudFinishing, setCloudFinishing] = useState(false);
  const [disconnectingCloud, setDisconnectingCloud] = useState(false);
  // The account portal's answer on /setup/cloud-callback, taken once the setup session is known.
  const cloudCallback = useRef<CloudCallback | null>(readCloudCallback(window.location));
  const [oidc, setOidc] = useState<OidcDraft>({
    issuer: "",
    clientId: "",
    clientSecret: "",
    redirectUri: "",
    scopes: "openid email profile",
  });
  const [smtpPreset, setSmtpPreset] = useState<SmtpPresetId>("resend");
  const [smtp, setSmtp] = useState<SetupSmtpDraft>(DEFAULT_SMTP_DRAFT);
  const [admin, setAdmin] = useState<AdminDraft>({ name: "", email: "", password: "" });
  const [logging, setLogging] = useState<LoggingDraft>({
    mode: "disabled",
    url: "",
    username: "",
    password: "",
    database: "opfield_logs",
    table: "logs",
  });
  const autoOidcRedirect = useRef<string | null>(null);
  const autoGrpcTarget = useRef<string | null>(null);

  const hydrate = useCallback((next: SetupConfig, codeId: string | null) => {
    const saved = readDraft(codeId);
    const defaultNetwork = {
      grpcPublicTarget: next.general.grpcPublicTarget ?? "",
      grpcLocalIp: next.general.grpcLocalIp ?? next.networkSuggestions.localIps[0] ?? "",
    };
    const availableOptions = getAvailableSignInOptions(next.administrator);
    const savedOption = saved?.signIn?.option;
    const nextSignIn: SignInDraft = {
      option:
        savedOption && availableOptions.includes(savedOption)
          ? savedOption
          : deriveSignInOption(next),
      emailOtp: saved?.signIn?.emailOtp ?? next.auth.methods.emailOtp,
    };
    // The Opfield account's client is not the customer's provider: the OIDC step starts empty.
    const ownOidc = next.oidc.opfieldAccount ? null : next.oidc;
    setConfig(next);
    setDraftCodeId(codeId);
    setPublicUrl(saved?.publicUrl ?? next.general.publicUrl ?? "");
    setNetwork({ ...defaultNetwork, ...(saved?.network ?? {}) });
    setSignIn(nextSignIn);
    setAdministrator(next.administrator);
    setCloud(next.cloud);
    setOidc({
      issuer: ownOidc?.issuer ?? "",
      clientId: ownOidc?.clientId ?? "",
      clientSecret: "",
      redirectUri: ownOidc?.redirectUri ?? "",
      scopes: ownOidc?.scopes ?? "openid email profile",
      ...(saved?.oidc ?? {}),
    });
    setSmtpPreset(
      saved?.smtpPreset ?? (next.smtp.host ? getSmtpPresetId(next.smtp.host) : "resend")
    );
    setSmtp({
      host: next.smtp.host ?? DEFAULT_SMTP_DRAFT.host,
      port: String(next.smtp.port ?? DEFAULT_SMTP_DRAFT.port),
      tlsMode: next.smtp.tlsMode ?? DEFAULT_SMTP_DRAFT.tlsMode,
      username: next.smtp.username ?? DEFAULT_SMTP_DRAFT.username,
      senderName: next.smtp.senderName ?? DEFAULT_SMTP_DRAFT.senderName,
      senderEmail: next.smtp.senderEmail ?? DEFAULT_SMTP_DRAFT.senderEmail,
      ...(saved?.smtp ?? {}),
      password: "",
    });
    setAdmin({
      name: saved?.admin?.name ?? "",
      email: saved?.admin?.email ?? "",
      password: "",
    });
    setLogging({
      mode: next.logging.mode,
      url: next.logging.url,
      username: next.logging.username,
      database: next.logging.database,
      table: next.logging.table,
      ...(saved?.logging ?? {}),
      ...(isStructuredLoggingLicensed(next) ? {} : { mode: "disabled" as const }),
      password: "",
    });
    autoOidcRedirect.current = saved?.autoOidcRedirect ?? null;
    autoGrpcTarget.current = saved?.autoGrpcTarget ?? null;
    const availableSteps = getSetupSteps(nextSignIn, next.administratorCreated);
    setStep(restoreStepWithRequiredSecrets(next, saved, nextSignIn, availableSteps));
    // A draft that went past the first step chose a new installation already.
    setStartMode(saved?.step && saved.step !== "public-url" ? "new" : "choose");
    setDraftReady(true);
  }, []);

  // Back from the account portal: enrol with its code (or say why there is none) on the Opfield account step.
  const takeCloudCallback = useCallback((csrf: string) => {
    const callback = cloudCallback.current;
    if (!callback) return;
    cloudCallback.current = null;
    window.history.replaceState(null, "", "/");
    setStartMode("new");
    setSignIn((value) => ({ ...value, option: "opfield_account" }));
    setStep("cloud-connect");
    if (callback.error || !callback.code || !callback.state) {
      toast.error(cloudCallbackError(callback.error ?? "no code"));
      return;
    }
    setCloudFinishing(true);
    void setupRequest<SetupCloudConnectState>(
      "/wizard/cloud-connect/finish",
      "POST",
      { code: callback.code, state: callback.state },
      csrf
    )
      .then(setCloud)
      .catch((error) => toastApiError(error, "Could not connect to the Opfield account"))
      .finally(() => setCloudFinishing(false));
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const status = await setupRequest<SetupStatus>("/status");
        if (!active) return;
        const codeId = status.code?.id ?? null;
        setDraftCodeId(codeId);
        if (status.currentSession) {
          const [next, csrf] = await Promise.all([
            setupRequest<SetupConfig>("/wizard/config"),
            setupRequest<{ csrfToken: string }>("/wizard/csrf"),
          ]);
          if (!active) return;
          setCsrfToken(csrf.csrfToken);
          hydrate(next, codeId);
          setUnlocked(true);
          takeCloudCallback(csrf.csrfToken);
        } else {
          setSetupInProgress(status.setupInProgress);
        }
      } catch {
        // The normal setup-code screen remains available if status cannot be loaded.
      } finally {
        if (active) setLoadingSession(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [hydrate, takeCloudCallback]);

  useEffect(() => {
    if (!restartPending) return;
    const timer = window.setTimeout(
      () => window.location.assign(signInTarget(signIn)),
      TLS_RESTART_REDIRECT_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [restartPending, signIn]);

  useEffect(() => {
    if (!draftReady || !draftCodeId || !unlocked) return;
    const draft: PersistedSetupDraft = {
      step,
      publicUrl,
      network,
      signIn,
      oidc: {
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        redirectUri: oidc.redirectUri,
        scopes: oidc.scopes,
      },
      smtpPreset,
      smtp: {
        host: smtp.host,
        port: smtp.port,
        tlsMode: smtp.tlsMode,
        username: smtp.username,
        senderName: smtp.senderName,
        senderEmail: smtp.senderEmail,
      },
      admin: { name: admin.name, email: admin.email },
      logging: {
        mode: logging.mode,
        url: logging.url,
        username: logging.username,
        database: logging.database,
        table: logging.table,
      },
      autoOidcRedirect: autoOidcRedirect.current,
      autoGrpcTarget: autoGrpcTarget.current,
    };
    sessionStorage.setItem(draftStorageKey(draftCodeId), JSON.stringify(draft));
  }, [
    admin,
    draftCodeId,
    draftReady,
    logging,
    network,
    oidc,
    publicUrl,
    signIn,
    smtp,
    smtpPreset,
    step,
    unlocked,
  ]);

  const canRestore = Boolean(
    unlocked && config && !config.administratorCreated && config.phase === "configuration"
  );
  const mode: SetupStartMode = canRestore ? startMode : "new";

  // An upload or restore already under way goes straight back to the restore, once per visit.
  const restoreChecked = useRef(false);
  useEffect(() => {
    if (!canRestore || startMode !== "choose" || restoreChecked.current) return;
    restoreChecked.current = true;
    void setupRequest<{ state: string; restore: { state: string } | null }>("/wizard/restore")
      .then((view) => {
        if (view.state !== "empty" || view.restore) {
          setStartMode((current) => (current === "choose" ? "restore" : current));
        }
      })
      .catch(() => {});
  }, [canRestore, startMode]);

  const administratorCreated = Boolean(config?.administratorCreated || administrator);
  const availableSignInOptions = useMemo(
    () => getAvailableSignInOptions(administrator),
    [administrator]
  );
  const steps = useMemo(
    () => getSetupSteps(signIn, administratorCreated),
    [administratorCreated, signIn]
  );
  const oidcAlreadyConfigured = Boolean(config?.oidc.configured && !config.oidc.opfieldAccount);
  const stepIndex = Math.max(0, steps.indexOf(step));
  const nextStep = () => setStep(steps[Math.min(stepIndex + 1, steps.length - 1)]!);
  const previousStep = () => setStep(steps[Math.max(stepIndex - 1, 0)]!);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      toastApiError(error, "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  // Another option after connecting the Opfield account: confirm, then the cloud link and its admin go.
  const continueFromSignIn = async () => {
    if (!cloud.connected || signIn.option === "opfield_account") {
      nextStep();
      return;
    }
    const disconnected = await confirmAction(
      {
        title: "Disconnect the Opfield account",
        description: `This installation is connected to ${cloud.accountEmail ?? "an Opfield account"}. Choosing another sign-in option disconnects it, removes the Opfield account sign-in it set up, and ${cloud.administrator?.email ?? "the person who connected it"} no longer becomes the first administrator.`,
        confirmLabel: "Disconnect",
      },
      async () => {
        setDisconnectingCloud(true);
        try {
          setCloud(
            await setupRequest<SetupCloudConnectState>(
              "/wizard/cloud-connect/disconnect",
              "POST",
              undefined,
              csrfToken
            )
          );
          setConfig(await setupRequest<SetupConfig>("/wizard/config"));
          return true;
        } catch (error) {
          toastApiError(error, "Could not disconnect the Opfield account");
          return false;
        } finally {
          setDisconnectingCloud(false);
        }
      }
    );
    if (disconnected) nextStep();
  };

  const getAuthPayload = () => ({
    option: signIn.option,
    methods: getSignInMethods(signIn),
    ...(signIn.option === "oidc"
      ? {
          oidc: {
            ...oidc,
            ...(oidc.clientSecret ? {} : { clientSecret: undefined }),
          },
        }
      : {}),
    ...(signIn.option === "password_totp" && signIn.emailOtp
      ? {
          smtp: {
            ...smtp,
            port: Number(smtp.port),
            ...(smtp.password ? {} : { password: undefined }),
          },
        }
      : {}),
  });

  const finishSetup = async (outcome: {
    status: "configured" | "skipped";
    configuredVia?: "direct" | "opfield_inference";
  }) => {
    const result = await setupRequest<SetupCompleteResult>(
      "/wizard/complete",
      "POST",
      outcome,
      csrfToken
    );
    if (draftCodeId) sessionStorage.removeItem(draftStorageKey(draftCodeId));
    setAIWorkspaceWizardOpen(false);
    if (result.restartRequired) setRestartPending(true);
    else window.location.assign(signInTarget(signIn));
  };

  const openAIWorkspaceSetup = () =>
    void run(async () => {
      await setupRequest("/wizard/session", "POST", undefined, csrfToken);
      api.resetSessionState();
      setAIWorkspaceWizardOpen(true);
    });

  // The session decides which screen shows, so nothing appears before it is known.
  if (loadingSession) return <AuthShell loading />;

  if (setupInProgress && !unlocked) {
    return (
      <AuthShell>
        <AnimatedHeight>
          <div className="space-y-2 text-center">
            <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
              <Loader2 className="h-5 w-5 animate-spin" /> Opfield setup is in progress
            </h2>
            <p className="text-sm text-muted-foreground">
              Another administrator is configuring this Opfield installation. Setup access will
              become available again if their session expires.
            </p>
          </div>
        </AnimatedHeight>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      wide={unlocked}
      contentClassName={unlocked && mode === "new" && step === "network" ? "max-w-lg" : undefined}
    >
      {unlocked && mode === "new" && (
        <div className="flex justify-center gap-2">
          <Badge variant="secondary">
            Step {stepIndex + 1} of {steps.length}
          </Badge>
          <Badge variant="outline">
            Internal {config?.transport.tlsEnabled ? "HTTPS" : "HTTP"}
          </Badge>
        </div>
      )}
      <AnimatedHeight>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={unlocked ? (mode === "new" ? step : `start-${mode}`) : "unlock"}
            initial={reducedMotion ? false : { opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0, x: -10 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }}
            className="text-left"
          >
            {!unlocked && (
              <SetupUnlockStep
                busy={busy}
                code={code}
                setCode={setCode}
                onSubmit={() =>
                  void run(async () => {
                    let unlockedCodeId = draftCodeId;
                    let unlockedCsrfToken = "";
                    try {
                      const result = await setupRequest<SetupUnlockResult>("/unlock", "POST", {
                        code: code.trim(),
                      });
                      setCsrfToken(result.csrfToken);
                      setDraftCodeId(result.codeId);
                      unlockedCodeId = result.codeId;
                      unlockedCsrfToken = result.csrfToken;
                    } catch (error) {
                      if (
                        error instanceof SetupRequestError &&
                        error.code === "SETUP_IN_PROGRESS"
                      ) {
                        setSetupInProgress(true);
                        return;
                      }
                      throw error;
                    }
                    const next = await setupRequest<SetupConfig>("/wizard/config");
                    hydrate(next, unlockedCodeId);
                    setUnlocked(true);
                    takeCloudCallback(unlockedCsrfToken);
                  })
                }
              />
            )}
            {unlocked && mode === "choose" && (
              <SetupStartChoice
                onNew={() => setStartMode("new")}
                onRestore={() => setStartMode("restore")}
              />
            )}
            {unlocked && mode === "restore" && (
              <SetupRestoreFlow
                csrfToken={csrfToken}
                suggestions={config?.networkSuggestions ?? { publicIps: [], localIps: [] }}
                onBack={() => setStartMode("choose")}
              />
            )}
            {unlocked && mode === "new" && step === "public-url" && (
              <PublicUrlStep
                busy={busy}
                publicUrl={publicUrl}
                setPublicUrl={setPublicUrl}
                onContinue={() => {
                  const nextRedirectUri = oidcRedirectUri(publicUrl);
                  if (!oidc.redirectUri || oidc.redirectUri === autoOidcRedirect.current) {
                    setOidc((value) => ({
                      ...value,
                      redirectUri: nextRedirectUri,
                    }));
                    autoOidcRedirect.current = nextRedirectUri;
                  }
                  const nextGrpcTarget = deriveGrpcPublicTarget(publicUrl);
                  setNetwork((value) => {
                    if (value.grpcPublicTarget && value.grpcPublicTarget !== autoGrpcTarget.current)
                      return value;
                    autoGrpcTarget.current = nextGrpcTarget;
                    return { ...value, grpcPublicTarget: nextGrpcTarget };
                  });
                  nextStep();
                }}
              />
            )}
            {unlocked && mode === "new" && step === "network" && (
              <SetupNetworkStep
                busy={busy}
                network={network}
                publicUrl={publicUrl}
                suggestions={config?.networkSuggestions ?? { publicIps: [], localIps: [] }}
                setNetwork={setNetwork}
                onBack={previousStep}
                onContinue={nextStep}
              />
            )}
            {unlocked && mode === "new" && step === "auth-methods" && (
              <SignInStep
                available={availableSignInOptions}
                busy={busy}
                pending={disconnectingCloud}
                signIn={signIn}
                setSignIn={setSignIn}
                onBack={previousStep}
                onContinue={() => void continueFromSignIn()}
              />
            )}
            {unlocked && mode === "new" && step === "cloud-connect" && (
              <CloudConnectStep
                busy={busy}
                cloud={cloud}
                csrfToken={csrfToken}
                finishing={cloudFinishing}
                publicUrl={publicUrl}
                setCloud={setCloud}
                onBack={previousStep}
                onContinue={nextStep}
              />
            )}
            {unlocked && mode === "new" && step === "oidc-config" && (
              <OidcConfigStep
                alreadyConfigured={oidcAlreadyConfigured}
                busy={busy}
                oidc={oidc}
                setOidc={setOidc}
                onBack={previousStep}
                onContinue={nextStep}
              />
            )}
            {unlocked && mode === "new" && step === "smtp-config" && (
              <SmtpConfigStep
                alreadyConfigured={Boolean(config?.smtp.configured)}
                busy={busy}
                preset={smtpPreset}
                setPreset={setSmtpPreset}
                smtp={smtp}
                setSmtp={setSmtp}
                onBack={previousStep}
                onContinue={nextStep}
              />
            )}
            {unlocked && mode === "new" && step === "admin-details" && (
              <AdminDetailsStep
                admin={admin}
                busy={busy}
                withPassword={signIn.option === "password_totp"}
                setAdmin={setAdmin}
                onBack={previousStep}
                onContinue={() => {
                  if (signIn.option !== "password_totp") {
                    nextStep();
                    return;
                  }
                  void run(async () => {
                    const created = await setupRequest<SetupAdministrator>(
                      "/wizard/administrator",
                      "POST",
                      {
                        auth: getAuthPayload(),
                        administrator: {
                          name: admin.name,
                          email: admin.email,
                          password: admin.password,
                        },
                      },
                      csrfToken
                    );
                    setAdministrator(created);
                    setAdmin((value) => ({ ...value, password: "" }));
                    setStep("admin-2fa");
                  });
                }}
              />
            )}
            {unlocked && mode === "new" && step === "admin-2fa" && (
              <AdminSecondFactorStep
                administrator={administrator}
                busy={busy}
                csrfToken={csrfToken}
                onConfigured={() =>
                  setAdministrator((value) => (value ? { ...value, secondFactor: true } : value))
                }
                onBack={previousStep}
                onContinue={() => setStep("logging")}
              />
            )}
            {unlocked && mode === "new" && step === "logging" && (
              <LoggingStep
                busy={busy}
                hasSavedPassword={Boolean(config?.logging.passwordLast4)}
                logging={logging}
                storageLicensed={Boolean(config && isStructuredLoggingLicensed(config))}
                setLogging={setLogging}
                onBack={previousStep}
                onContinue={nextStep}
              />
            )}
            {unlocked && mode === "new" && step === "finish" && (
              <FinishStep
                administratorEmail={
                  signIn.option === "opfield_account" && !administratorCreated
                    ? (cloud.administrator?.email ?? "")
                    : (administrator?.email ??
                      (administratorCreated ? "Already created" : admin.email))
                }
                busy={busy || restartPending}
                logging={logging}
                network={network}
                oidc={oidc}
                publicUrl={publicUrl}
                signIn={signIn}
                smtp={smtp}
                onBack={previousStep}
                onContinue={() =>
                  void run(async () => {
                    const result = await setupRequest<SetupApplyResult>(
                      "/wizard/apply",
                      "POST",
                      {
                        publicUrl,
                        network: {
                          grpcPublicTarget: network.grpcPublicTarget,
                          grpcLocalIp: network.grpcLocalIp,
                        },
                        auth: getAuthPayload(),
                        ...(signIn.option === "oidc" && !administratorCreated
                          ? {
                              administrator: {
                                name: admin.name,
                                email: admin.email,
                                authMethod: "oidc",
                              },
                            }
                          : {}),
                        logging:
                          logging.mode === "external"
                            ? {
                                ...logging,
                                ...(logging.password ? {} : { password: undefined }),
                              }
                            : { mode: logging.mode },
                      },
                      csrfToken
                    );
                    if (result.status === "ready_for_ai") setStep("license");
                  })
                }
              />
            )}
            {unlocked && mode === "new" && step === "license" && (
              <LicenseStep
                busy={busy || restartPending}
                onActivate={(licenseKey) =>
                  void run(async () => {
                    await setupRequest(
                      "/wizard/license/activate",
                      "POST",
                      { licenseKey },
                      csrfToken
                    );
                    toast.success("License activated");
                    setStep("ai-workspace");
                  })
                }
                onCommunity={() =>
                  void run(async () => {
                    const status = await setupRequest<SetupConfig["license"]["status"]>(
                      "/wizard/license/community",
                      "POST",
                      undefined,
                      csrfToken
                    );
                    if (status.registrationStatus === "pending") {
                      toast.info(
                        "Community edition is ready. Registration will retry automatically when the license server is available."
                      );
                    }
                    setStep("ai-workspace");
                  })
                }
              />
            )}
            {unlocked && mode === "new" && step === "ai-workspace" && (
              <AIWorkspaceStep
                busy={busy || restartPending}
                onConfigure={openAIWorkspaceSetup}
                onSkip={() => void run(() => finishSetup({ status: "skipped" }))}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </AnimatedHeight>
      <ConfigureAIWorkspaceWizard
        open={aiWorkspaceWizardOpen}
        canManageInferenceCore
        completionActionLabel={
          signIn.option === "opfield_account"
            ? "Sign in with Opfield account"
            : "Continue to sign in"
        }
        onBack={() => setAIWorkspaceWizardOpen(false)}
        onConfigured={(configuredVia) =>
          run(() => finishSetup({ status: "configured", configuredVia }))
        }
        onSkipped={() => run(() => finishSetup({ status: "skipped" }))}
      />
      <ConfirmDialog />
    </AuthShell>
  );
}
