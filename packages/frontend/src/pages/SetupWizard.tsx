import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AuthShell } from "@/components/auth/AuthShell";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { ConfigureAIWorkspaceWizard } from "./dashboard/finalize-setup/ConfigureAIWorkspaceWizard";
import { DEFAULT_SMTP_DRAFT, getSmtpPresetId, type SmtpPresetId } from "./settings/smtp-presets";
import {
  AdminAuthMethodStep,
  AdminDetailsStep,
  AIWorkspaceStep,
  FinishStep,
  LicenseStep,
  LoggingStep,
} from "./setup-wizard/SetupFinalSteps";
import { SetupNetworkStep } from "./setup-wizard/SetupNetworkStep";
import { SetupRestoreFlow, SetupStartChoice } from "./setup-wizard/SetupRestoreFlow";
import { SetupUnlockStep } from "./setup-wizard/SetupUnlockStep";
import {
  AuthMethodsStep,
  OidcConfigStep,
  PublicUrlStep,
  SmtpConfigStep,
} from "./setup-wizard/SetupWizardForms";
import { SetupRequestError, setupRequest } from "./setup-wizard/setup-request";
import {
  type AdminDraft,
  type AuthMethodsDraft,
  deriveGrpcPublicTarget,
  getEnabledPrimaryMethods,
  getSetupSteps,
  type LoggingDraft,
  type NetworkDraft,
  type OidcDraft,
  type SetupConfig,
  type SetupSmtpDraft,
  type SetupStep,
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

/** Before an administrator exists, setup can start a new installation or restore an export. */
type SetupStartMode = "choose" | "new" | "restore";

interface PersistedSetupDraft {
  step: SetupStep;
  publicUrl: string;
  network: NetworkDraft;
  methods: AuthMethodsDraft;
  oidc: Omit<OidcDraft, "clientSecret">;
  smtpPreset: SmtpPresetId;
  smtp: Omit<SetupSmtpDraft, "password">;
  admin: Omit<AdminDraft, "password">;
  logging: Omit<LoggingDraft, "password">;
  autoOidcRedirect: string | null;
  autoGrpcTarget: string | null;
}

function draftStorageKey(codeId: string): string {
  return `gateway:setup-draft:${codeId}`;
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
  methods: AuthMethodsDraft,
  availableSteps: SetupStep[]
): SetupStep {
  if (next.phase === "ai_workspace") return next.license.completed ? "ai-workspace" : "license";
  if (next.administratorCreated) return "logging";

  const restoredStep =
    saved?.step && availableSteps.includes(saved.step) ? saved.step : "public-url";
  const restoredIndex = availableSteps.indexOf(restoredStep);
  const requiredSecretSteps: SetupStep[] = [];

  if (methods.oidc && !next.oidc.configured) requiredSecretSteps.push("oidc-config");
  if ((methods.password || methods.emailOtp) && !next.smtp.configured) {
    requiredSecretSteps.push("smtp-config");
  }
  if (saved?.admin?.authMethod === "password") requiredSecretSteps.push("admin-details");
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
  const [methods, setMethods] = useState<AuthMethodsDraft>({
    oidc: true,
    password: false,
    emailOtp: false,
  });
  const [oidc, setOidc] = useState<OidcDraft>({
    issuer: "",
    clientId: "",
    clientSecret: "",
    redirectUri: "",
    scopes: "openid email profile",
  });
  const [smtpPreset, setSmtpPreset] = useState<SmtpPresetId>("resend");
  const [smtp, setSmtp] = useState<SetupSmtpDraft>(DEFAULT_SMTP_DRAFT);
  const [admin, setAdmin] = useState<AdminDraft>({
    name: "",
    email: "",
    authMethod: null,
    password: "",
  });
  const [logging, setLogging] = useState<LoggingDraft>({
    mode: "disabled",
    url: "",
    username: "",
    password: "",
    database: "gateway_logs",
    table: "logs",
  });
  const autoOidcRedirect = useRef<string | null>(null);
  const autoGrpcTarget = useRef<string | null>(null);

  const hydrate = useCallback((next: SetupConfig, codeId: string | null) => {
    const saved = readDraft(codeId);
    const defaultNetwork = {
      grpcPublicTarget: next.general.gatewayGrpcPublicTarget ?? "",
      grpcLocalIp: next.general.gatewayGrpcLocalIp ?? next.networkSuggestions.localIps[0] ?? "",
    };
    const nextMethods = { ...next.auth.methods, ...(saved?.methods ?? {}) };
    setConfig(next);
    setDraftCodeId(codeId);
    setPublicUrl(saved?.publicUrl ?? next.general.publicUrl ?? "");
    setNetwork({ ...defaultNetwork, ...(saved?.network ?? {}) });
    setMethods(nextMethods);
    setOidc({
      issuer: next.oidc.issuer ?? "",
      clientId: next.oidc.clientId ?? "",
      clientSecret: "",
      redirectUri: next.oidc.redirectUri ?? "",
      scopes: next.oidc.scopes,
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
      name: "",
      email: "",
      authMethod: null,
      password: "",
      ...(saved?.admin ?? {}),
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
    const availableSteps = getSetupSteps(nextMethods, next.administratorCreated);
    setStep(restoreStepWithRequiredSecrets(next, saved, nextMethods, availableSteps));
    // A draft that went past the first step chose a new installation already.
    setStartMode(saved?.step && saved.step !== "public-url" ? "new" : "choose");
    setDraftReady(true);
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
  }, [hydrate]);

  useEffect(() => {
    if (!restartPending) return;
    const timer = window.setTimeout(
      () => window.location.assign("/login"),
      TLS_RESTART_REDIRECT_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [restartPending]);

  useEffect(() => {
    if (!draftReady || !draftCodeId || !unlocked) return;
    const draft: PersistedSetupDraft = {
      step,
      publicUrl,
      network,
      methods,
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
      admin: { name: admin.name, email: admin.email, authMethod: admin.authMethod },
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
    methods,
    network,
    oidc,
    publicUrl,
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

  const enabledPrimaryMethods = useMemo(() => getEnabledPrimaryMethods(methods), [methods]);
  const steps = useMemo(
    () => getSetupSteps(methods, Boolean(config?.administratorCreated)),
    [config?.administratorCreated, methods]
  );
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

  const getAuthPayload = () => ({
    methods,
    ...(methods.oidc
      ? {
          oidc: {
            ...oidc,
            ...(oidc.clientSecret ? {} : { clientSecret: undefined }),
          },
        }
      : {}),
    ...(methods.password || methods.emailOtp
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
    configuredVia?: "direct" | "gateway_inference";
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
    else window.location.assign("/login");
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
                    try {
                      const result = await setupRequest<SetupUnlockResult>("/unlock", "POST", {
                        code: code.trim(),
                      });
                      setCsrfToken(result.csrfToken);
                      setDraftCodeId(result.codeId);
                      unlockedCodeId = result.codeId;
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
                  const nextRedirectUri = `${publicUrl.replace(/\/$/, "")}/auth/callback`;
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
              <AuthMethodsStep
                busy={busy}
                methods={methods}
                setMethods={setMethods}
                onBack={previousStep}
                onContinue={() => {
                  setAdmin((value) => ({
                    ...value,
                    authMethod:
                      enabledPrimaryMethods.length === 1
                        ? enabledPrimaryMethods[0]!
                        : value.authMethod !== null &&
                            enabledPrimaryMethods.includes(value.authMethod)
                          ? value.authMethod
                          : null,
                  }));
                  nextStep();
                }}
              />
            )}
            {unlocked && mode === "new" && step === "oidc-config" && (
              <OidcConfigStep
                alreadyConfigured={Boolean(config?.oidc.configured)}
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
            {unlocked && mode === "new" && step === "admin-auth" && (
              <AdminAuthMethodStep
                admin={admin}
                busy={busy}
                enabledMethods={enabledPrimaryMethods}
                setAdmin={setAdmin}
                onBack={previousStep}
                onContinue={nextStep}
              />
            )}
            {unlocked && mode === "new" && step === "admin-details" && (
              <AdminDetailsStep
                admin={admin}
                busy={busy}
                setAdmin={setAdmin}
                onBack={previousStep}
                onContinue={nextStep}
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
                administrator={admin}
                administratorCreated={Boolean(config?.administratorCreated)}
                busy={busy || restartPending}
                enabledMethods={enabledPrimaryMethods}
                logging={logging}
                network={network}
                oidc={oidc}
                publicUrl={publicUrl}
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
                        ...(config?.administratorCreated
                          ? {}
                          : {
                              administrator: {
                                ...admin,
                                ...(admin.authMethod === "password" ? {} : { password: undefined }),
                              },
                            }),
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
        completionActionLabel="Continue to sign in"
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
