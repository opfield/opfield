import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LogIn,
  Mail,
  Save,
  ShieldCheck,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AuthShell } from "@/components/auth/AuthShell";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { CopyValueField } from "@/components/common/CopyValueField";
import { OpfieldMark } from "@/components/common/OpfieldMark";
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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { resolveAuthReturnTo } from "@/lib/auth-return-to";
import { getInitials } from "@/lib/utils";

export type AuthMethods = {
  oidc: boolean;
  password: boolean;
  emailOtp: boolean;
  passkeyLogin: boolean;
  demoEmailOtp?: boolean;
  /** Name on the OIDC button ("Sign in with <name>"); absent or null shows "Sign in with SSO". */
  oidcDisplayName?: string | null;
  /** The OIDC provider is the Opfield account a managed installation was provisioned with. */
  oidcOpfieldAccount?: boolean;
};
type PendingMfa = { challengeId: string; passkeyAvailable: boolean };
type PendingEnrollment = {
  enrollmentToken: string;
  method?: "totp";
  secret?: string;
  uri?: string;
  recoveryCodes?: string[];
};
type LoginStep = "methods" | "email" | "password" | "otp" | "reset_sent";
type MethodsState = "loading" | "ready" | "error";
type MfaVerificationMethod = "totp" | "recovery";
type EmailSignInContinuation =
  | { method: "password" }
  | { method: "email_otp"; challengeId: string };
type PasswordResetProfile = {
  name: string;
  email: string;
  avatarUrl: string | null;
  groupName: string;
};

const EMPTY_METHODS: AuthMethods = {
  oidc: false,
  password: false,
  emailOtp: false,
  passkeyLogin: false,
  demoEmailOtp: false,
};
const redirectToGateway = (path: string) => window.location.assign(path);

function isPasskeyPromptDismissed(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (candidate.code === "ERROR_CEREMONY_ABORTED" || candidate.name === "NotAllowedError")
    return true;
  return (
    candidate.code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" &&
    typeof candidate.cause === "object" &&
    candidate.cause !== null &&
    (candidate.cause as { name?: unknown }).name === "NotAllowedError"
  );
}

async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as { message?: string; code?: string } & T;
  if (!response.ok) throw new Error(data.message ?? "Sign-in failed");
  return data;
}

/** "Sign in with Opfield account" on a managed installation, the provider's name, or "Sign in with SSO". */
export function oidcButtonLabel(methods: Pick<AuthMethods, "oidcDisplayName">): string {
  const name = methods.oidcDisplayName?.trim();
  return name ? `Sign in with ${name}` : "Sign in with SSO";
}

export function loadAuthMethods(): Promise<AuthMethods> {
  return authRequest<AuthMethods>("/auth/methods");
}

export function LoginPage({
  initialMethods,
  initialMethodsFailed = false,
  onComplete = redirectToGateway,
}: {
  initialMethods?: AuthMethods;
  initialMethodsFailed?: boolean;
  onComplete?: (path: string) => void;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [methods, setMethods] = useState<AuthMethods>(initialMethods ?? EMPTY_METHODS);
  const [methodsState, setMethodsState] = useState<MethodsState>(
    initialMethods ? "ready" : initialMethodsFailed ? "error" : "loading"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginStep, setLoginStep] = useState<LoginStep>("methods");
  const [otpChallengeId, setOtpChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [pendingMfa, setPendingMfa] = useState<PendingMfa | null>(null);
  const [mfaVerificationMethod, setMfaVerificationMethod] = useState<MfaVerificationMethod>("totp");
  const [pendingEnrollment, setPendingEnrollment] = useState<PendingEnrollment | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetProfile, setResetProfile] = useState<PasswordResetProfile | null>(null);
  const [passwordResetConfirmOpen, setPasswordResetConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparingTotp, setPreparingTotp] = useState(false);
  const gatewayNavigationPending = useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const resetToken = new URLSearchParams(location.search).get("token");
  const returnTo = resolveAuthReturnTo(location.search);
  const emailEnabled = methods.password || methods.emailOtp || methods.demoEmailOtp;
  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());
  const activeLoginStep = pendingEnrollment?.recoveryCodes
    ? "recovery_codes"
    : pendingEnrollment
      ? pendingEnrollment.method === "totp"
        ? "enrollment_totp"
        : "enrollment_choice"
      : pendingMfa
        ? "mfa"
        : loginStep;

  const [retryingMethods, setRetryingMethods] = useState(false);

  const loadMethods = useCallback(async () => {
    try {
      setMethods(await loadAuthMethods());
      setMethodsState("ready");
    } catch {
      setMethodsState("error");
    }
  }, []);

  // A retry keeps the error view until the methods arrive, then replaces it once.
  const retryMethods = async () => {
    setRetryingMethods(true);
    await loadMethods();
    setRetryingMethods(false);
  };

  useEffect(() => {
    if (initialMethods || initialMethodsFailed) return;
    void loadMethods();
  }, [initialMethods, initialMethodsFailed, loadMethods]);

  useEffect(() => {
    if (!resetToken) {
      setResetProfile(null);
      return;
    }
    let active = true;
    authRequest<PasswordResetProfile>("/auth/password/reset/profile", { token: resetToken })
      .then((profile) => {
        if (active) setResetProfile(profile);
      })
      .catch((error) => {
        if (!active) return;
        toast.error(error instanceof Error ? error.message : "Invalid or expired password link");
        navigate("/login", { replace: true });
      });
    return () => {
      active = false;
    };
  }, [navigate, resetToken]);

  const complete = () => {
    gatewayNavigationPending.current = true;
    onComplete(returnTo);
  };

  const handlePrimaryResult = (result: {
    mfaRequired?: boolean;
    mfaPasskeyAvailable?: boolean;
    challengeId?: string;
    mfaEnrollmentRequired?: boolean;
    enrollmentToken?: string;
  }) => {
    if (result.mfaRequired && result.challengeId) {
      setCode("");
      setMfaVerificationMethod("totp");
      setPendingMfa({
        challengeId: result.challengeId,
        passkeyAvailable: Boolean(result.mfaPasskeyAvailable),
      });
      return;
    }
    if (result.mfaEnrollmentRequired && result.enrollmentToken) {
      setCode("");
      setPendingEnrollment({ enrollmentToken: result.enrollmentToken });
      return;
    }
    complete();
  };

  const run = async (task: () => Promise<void>, handleError?: (error: unknown) => boolean) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      if (handleError?.(error)) return;
      toast.error(error instanceof Error ? error.message : "Sign-in failed");
    } finally {
      if (!gatewayNavigationPending.current) setBusy(false);
    }
  };

  const continueWithEmail = () =>
    run(async () => {
      if (methods.demoEmailOtp) {
        const result = await authRequest<{ challengeId: string }>("/auth/demo/request", {
          email,
        });
        setOtpChallengeId(result.challengeId);
        setCode("");
        setLoginStep("otp");
        return;
      }
      const result = await authRequest<EmailSignInContinuation>("/auth/email/continue", {
        email,
      });
      if (result.method === "email_otp") {
        setOtpChallengeId(result.challengeId);
        setCode("");
        setLoginStep("otp");
        return;
      }
      setPassword("");
      setLoginStep("password");
    });

  const verifyOtp = () =>
    run(async () => {
      if (methods.demoEmailOtp) {
        const result = await authRequest<{
          mfaRequired?: boolean;
          mfaPasskeyAvailable?: boolean;
          challengeId?: string;
          mfaEnrollmentRequired?: boolean;
          enrollmentToken?: string;
        }>("/auth/demo/verify", { challengeId: otpChallengeId, code });
        handlePrimaryResult(result);
        return;
      }
      const result = await authRequest<{
        mfaRequired?: boolean;
        mfaPasskeyAvailable?: boolean;
        challengeId?: string;
        mfaEnrollmentRequired?: boolean;
        enrollmentToken?: string;
      }>("/auth/email-otp/verify", { challengeId: otpChallengeId, code });
      handlePrimaryResult(result);
    });

  const loginPassword = () =>
    run(async () => {
      const result = await authRequest<{
        mfaRequired?: boolean;
        mfaPasskeyAvailable?: boolean;
        challengeId?: string;
        mfaEnrollmentRequired?: boolean;
        enrollmentToken?: string;
      }>("/auth/password/login", { email, password });
      handlePrimaryResult(result);
    });

  const requestPasswordReset = () =>
    run(async () => {
      await authRequest("/auth/password/reset/request", { email });
      setPasswordResetConfirmOpen(false);
      setLoginStep("reset_sent");
    });

  const handlePasskeyError = (error: unknown) => {
    if (!isPasskeyPromptDismissed(error)) return false;
    toast.message("Passkey sign-in was cancelled. Try again or choose another sign-in method.");
    return true;
  };

  const verifyMfa = (method: MfaVerificationMethod) =>
    run(async () => {
      if (!pendingMfa) return;
      await authRequest("/auth/mfa/verify", {
        challengeId: pendingMfa.challengeId,
        ...(method === "totp" ? { totpCode: code } : { recoveryCode: code }),
      });
      complete();
    });

  const verifyMfaPasskey = () =>
    run(async () => {
      if (!pendingMfa) return;
      const options = await authRequest<{ challenge: string }>("/auth/mfa/passkey/options", {
        challengeId: pendingMfa.challengeId,
      });
      const response = await startAuthentication({ optionsJSON: options });
      await authRequest("/auth/mfa/passkey/verify", {
        challengeId: pendingMfa.challengeId,
        passkeyChallenge: options.challenge,
        response,
      });
      complete();
    }, handlePasskeyError);

  const signInWithPasskey = () =>
    run(async () => {
      const options = await authRequest<{ challenge: string }>("/auth/passkeys/options", {});
      const response = await startAuthentication({ optionsJSON: options });
      await authRequest("/auth/passkeys/verify", { challenge: options.challenge, response });
      complete();
    }, handlePasskeyError);

  const startEnrollment = () =>
    run(
      async () => {
        if (!pendingEnrollment) return;
        const result = await authRequest<{ secret: string; uri: string }>(
          "/auth/mfa/enrollment/totp/setup",
          {
            token: pendingEnrollment.enrollmentToken,
          }
        );
        setPendingEnrollment({
          ...pendingEnrollment,
          method: "totp",
          secret: result.secret,
          uri: result.uri,
        });
      },
      () => {
        setPendingEnrollment((current) =>
          current ? { enrollmentToken: current.enrollmentToken } : current
        );
        return false;
      }
    );

  // The QR step opens once its secret is ready; the choice stays until then.
  const chooseTotpEnrollment = async () => {
    if (!pendingEnrollment) return;
    setCode("");
    setPreparingTotp(true);
    await startEnrollment();
    setPreparingTotp(false);
  };

  const startPasskeyEnrollment = () =>
    run(async () => {
      if (!pendingEnrollment) return;
      const options = await authRequest<Record<string, unknown>>(
        "/auth/mfa/enrollment/passkey/options",
        { token: pendingEnrollment.enrollmentToken }
      );
      const response = await startRegistration({ optionsJSON: options as never });
      await authRequest("/auth/mfa/enrollment/passkey/confirm", {
        token: pendingEnrollment.enrollmentToken,
        response,
        name: derivePasskeyName(response),
      });
      complete();
    }, handlePasskeyError);

  const confirmEnrollment = () =>
    run(async () => {
      if (!pendingEnrollment) return;
      const result = await authRequest<{ recoveryCodes: string[] }>(
        "/auth/mfa/enrollment/totp/confirm",
        {
          token: pendingEnrollment.enrollmentToken,
          code,
        }
      );
      setPendingEnrollment({ ...pendingEnrollment, recoveryCodes: result.recoveryCodes });
    });

  const completePasswordReset = () =>
    run(async () => {
      if (!resetToken) return;
      await authRequest("/auth/password/reset/complete", {
        token: resetToken,
        password: resetPassword,
      });
      toast.success("Password saved. You can now sign in.");
      navigate("/login", { replace: true });
    });

  if (resetToken) {
    return (
      <AuthShell loading={!resetProfile} loadingLabel="Checking password link…">
        <AnimatedHeight>
          <section className="space-y-3">
            <h2 className="text-center text-lg font-semibold">Set a new password</h2>
            {resetProfile && (
              <div className="flex items-center gap-4 border border-border p-4 text-left">
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarImage src={resetProfile.avatarUrl ?? undefined} />
                  <AvatarFallback className="text-sm">
                    {getInitials(resetProfile.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{resetProfile.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{resetProfile.email}</p>
                </div>
                <Badge variant="secondary" size="inline">
                  {resetProfile.groupName}
                </Badge>
              </div>
            )}
            {resetProfile && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (resetPassword.length >= 8 && !busy) void completePasswordReset();
                }}
              >
                <div className="flex border border-input bg-background">
                  <Input
                    type={showResetPassword ? "text" : "password"}
                    value={resetPassword}
                    minLength={8}
                    maxLength={72}
                    autoComplete="new-password"
                    placeholder="New password"
                    className="border-0 bg-transparent focus-visible:ring-0"
                    onChange={(event) => setResetPassword(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="relative shrink-0 rounded-none border-l border-border bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => setShowResetPassword((current) => !current)}
                    aria-label={showResetPassword ? "Hide password" : "Show password"}
                    title={showResetPassword ? "Hide password" : "Show password"}
                  >
                    <Eye
                      className={`absolute h-4 w-4 transition-all duration-200 ${showResetPassword ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
                    />
                    <EyeOff
                      className={`absolute h-4 w-4 transition-all duration-200 ${showResetPassword ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
                    />
                  </Button>
                </div>
                <div className="flex justify-center">
                  <Button
                    type="submit"
                    className="w-max flex-none"
                    pending={busy}
                    disabled={resetPassword.length < 8}
                  >
                    <Save className="h-4 w-4" />
                    Save new password
                  </Button>
                </div>
              </form>
            )}
          </section>
        </AnimatedHeight>
      </AuthShell>
    );
  }

  return (
    <AuthShell loading={methodsState === "loading"}>
      <AnimatedHeight>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={
              activeLoginStep === "mfa"
                ? `${activeLoginStep}-${mfaVerificationMethod}`
                : activeLoginStep
            }
            initial={prefersReducedMotion ? false : { opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, x: -10 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.18, ease: "easeOut" }}
            className={
              activeLoginStep === "mfa" ||
              activeLoginStep === "enrollment_choice" ||
              activeLoginStep === "enrollment_totp" ||
              activeLoginStep === "recovery_codes"
                ? "text-center"
                : "text-left"
            }
          >
            {activeLoginStep === "mfa" && pendingMfa && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (code && !busy) void verifyMfa(mfaVerificationMethod);
                }}
              >
                <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
                  <ShieldCheck className="h-5 w-5" />
                  {mfaVerificationMethod === "totp"
                    ? "Two-factor authentication"
                    : "Use a recovery code"}
                </h2>
                {mfaVerificationMethod === "recovery" && (
                  <p className="text-sm text-muted-foreground">
                    Recovery codes work once and let you sign in without your authenticator app.
                  </p>
                )}
                <div className="flex gap-2">
                  <Input
                    value={code}
                    inputMode={mfaVerificationMethod === "totp" ? "numeric" : "text"}
                    autoComplete={mfaVerificationMethod === "totp" ? "one-time-code" : "off"}
                    autoFocus
                    autoCapitalize={mfaVerificationMethod === "recovery" ? "characters" : "none"}
                    spellCheck={false}
                    placeholder={
                      mfaVerificationMethod === "totp" ? "Authenticator code" : "Recovery code"
                    }
                    onChange={(event) =>
                      setCode(
                        mfaVerificationMethod === "totp"
                          ? event.target.value.replace(/\D/g, "").slice(0, 6)
                          : event.target.value
                      )
                    }
                  />
                  <Button
                    type="submit"
                    className="shrink-0"
                    disabled={
                      busy || !code || (mfaVerificationMethod === "totp" && code.length !== 6)
                    }
                  >
                    {mfaVerificationMethod === "totp" ? "Verify" : "Sign in"}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
                {mfaVerificationMethod === "totp" && pendingMfa.passkeyAvailable && (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      className="w-max flex-none"
                      onClick={verifyMfaPasskey}
                      disabled={busy}
                    >
                      <Fingerprint className="h-4 w-4" />
                      Authenticate with passkey
                    </Button>
                  </div>
                )}
                <div className="flex justify-center">
                  {mfaVerificationMethod === "totp" ? (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => {
                        setCode("");
                        setMfaVerificationMethod("recovery");
                      }}
                      disabled={busy}
                    >
                      Use a recovery code <ArrowRight className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-max flex-none"
                      onClick={() => {
                        setCode("");
                        setMfaVerificationMethod("totp");
                      }}
                      disabled={busy}
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Back to authenticator code
                    </Button>
                  )}
                </div>
              </form>
            )}

            {activeLoginStep === "enrollment_choice" && pendingEnrollment && (
              <section className="space-y-3">
                <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
                  <ShieldCheck className="h-5 w-5" />
                  Set up multi-factor authentication
                </h2>
                <p className="text-sm text-muted-foreground">
                  Choose how you want to secure this account.
                </p>
                <div className="flex flex-col items-center gap-2">
                  <Button
                    className="w-max flex-none"
                    onClick={() => void chooseTotpEnrollment()}
                    pending={preparingTotp}
                    disabled={busy}
                  >
                    <ShieldCheck className="h-4 w-4" />
                    Set up authenticator app
                  </Button>
                  <Button
                    variant="outline"
                    className="w-max flex-none"
                    onClick={startPasskeyEnrollment}
                    disabled={busy}
                  >
                    <Fingerprint className="h-4 w-4" />
                    Set up passkey
                  </Button>
                </div>
              </section>
            )}

            {activeLoginStep === "enrollment_totp" && pendingEnrollment && (
              <section className="space-y-3">
                <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
                  <ShieldCheck className="h-5 w-5" />
                  Set up authenticator app
                </h2>
                {pendingEnrollment.secret && pendingEnrollment.uri && (
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (code.length === 6 && !busy) void confirmEnrollment();
                    }}
                  >
                    <p className="text-sm text-muted-foreground">
                      Scan this QR code with your authenticator app, then enter the generated code.
                    </p>
                    <div className="flex justify-center bg-qr p-4">
                      <QRCodeSVG
                        value={pendingEnrollment.uri}
                        size={176}
                        level="M"
                        marginSize={4}
                        title="TOTP setup QR code"
                      />
                    </div>
                    <CopyValueField label="Manual setup key" value={pendingEnrollment.secret} />
                    <div className="flex gap-2">
                      <Input
                        value={code}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoFocus
                        placeholder="6-digit code"
                        onChange={(event) =>
                          setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                        }
                      />
                      <Button
                        type="submit"
                        className="shrink-0"
                        pending={busy}
                        disabled={code.length !== 6}
                      >
                        <Check />
                        Activate TOTP
                      </Button>
                    </div>
                  </form>
                )}
              </section>
            )}

            {activeLoginStep === "recovery_codes" && pendingEnrollment?.recoveryCodes && (
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">Save your recovery codes</h2>
                <p className="text-sm text-muted-foreground">
                  Each code works once. They will not be shown again.
                </p>
                <pre className="grid grid-cols-2 gap-1 bg-muted p-3 text-left text-xs">
                  {pendingEnrollment.recoveryCodes.join("\n")}
                </pre>
                <div className="flex justify-center">
                  <Button className="w-max flex-none" onClick={complete}>
                    Continue to Opfield
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </section>
            )}

            {activeLoginStep === "methods" && methodsState === "error" && (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <p className="text-sm text-muted-foreground">Unable to load sign-in methods.</p>
                <Button
                  variant="outline"
                  onClick={() => void retryMethods()}
                  pending={retryingMethods}
                  disabled={busy}
                >
                  Retry
                </Button>
              </div>
            )}

            {activeLoginStep === "methods" && methodsState === "ready" && (
              <div className="flex flex-col gap-3">
                {methods.oidc && (
                  <Button
                    className="w-full"
                    onClick={() => {
                      const absoluteReturnTo = new URL(returnTo, window.location.origin).href;
                      window.location.href = `/auth/login?return_to=${encodeURIComponent(absoluteReturnTo)}`;
                    }}
                    disabled={busy}
                  >
                    {methods.oidcOpfieldAccount ? (
                      <OpfieldMark className="h-4 w-4 text-current" title="" />
                    ) : (
                      <LogIn className="h-4 w-4" />
                    )}
                    {oidcButtonLabel(methods)}
                  </Button>
                )}
                {emailEnabled && (
                  <Button
                    className="w-full"
                    variant={methods.oidc ? "outline" : "default"}
                    onClick={() => setLoginStep("email")}
                    disabled={busy}
                  >
                    <Mail className="h-4 w-4" />
                    {methods.demoEmailOtp ? "Explore the demo" : "Sign in with Email"}
                  </Button>
                )}
                {methods.passkeyLogin && (
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={signInWithPasskey}
                    disabled={busy}
                  >
                    <Fingerprint className="h-4 w-4" />
                    Sign in with Passkey
                  </Button>
                )}
              </div>
            )}

            {activeLoginStep === "email" && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (validEmail && !busy) void continueWithEmail();
                }}
              >
                <div className="text-center">
                  <h2 className="text-lg font-semibold">
                    {methods.demoEmailOtp ? "Explore the demo" : "Sign in with Email"}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {methods.demoEmailOtp
                      ? "Enter your email to receive a one-time demo access code."
                      : "Enter your work email to continue."}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={email}
                    type="email"
                    placeholder="Email"
                    autoComplete="email"
                    autoFocus
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <Button type="submit" className="shrink-0" pending={busy} disabled={!validEmail}>
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-max flex-none"
                    onClick={() => setLoginStep("methods")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back to sign-in options
                  </Button>
                </div>
              </form>
            )}

            {activeLoginStep === "password" && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (password && !busy) void loginPassword();
                }}
              >
                <div className="text-center">
                  <h2 className="text-lg font-semibold">Enter your password</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{email}</p>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={password}
                    type="password"
                    placeholder="Password"
                    autoComplete="current-password"
                    autoFocus
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <Button type="submit" className="shrink-0" pending={busy} disabled={!password}>
                    <KeyRound className="h-4 w-4" />
                    Sign in
                  </Button>
                </div>
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-max flex-none"
                    onClick={() => setLoginStep("email")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    {methods.demoEmailOtp ? "Back to demo access" : "Back to email sign-in"}
                  </Button>
                </div>
              </form>
            )}

            {activeLoginStep === "otp" && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (code.length === 6 && !busy) void verifyOtp();
                }}
              >
                <div className="text-center">
                  <h2 className="text-lg font-semibold">Check your email</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Enter the six-digit code sent to {email}.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={code}
                    inputMode="numeric"
                    placeholder="6-digit code"
                    autoComplete="one-time-code"
                    autoFocus
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  />
                  <Button
                    type="submit"
                    className="shrink-0"
                    pending={busy}
                    disabled={code.length !== 6}
                  >
                    Verify email code
                  </Button>
                </div>
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-max flex-none"
                    onClick={() => {
                      setCode("");
                      setOtpChallengeId("");
                      setLoginStep("email");
                    }}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    {methods.demoEmailOtp ? "Back to demo access" : "Back to email sign-in"}
                  </Button>
                </div>
              </form>
            )}

            {activeLoginStep === "reset_sent" && (
              <section className="space-y-3 text-center">
                <h2 className="text-lg font-semibold">Check your email</h2>
                <p className="text-sm text-muted-foreground">
                  We sent a password-reset link to {email}. Continue from that link to sign in. You
                  can close this window.
                </p>
              </section>
            )}
            {activeLoginStep === "password" && (
              <div className="flex justify-center pt-3">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => setPasswordResetConfirmOpen(true)}
                  disabled={busy}
                >
                  Forgot password?
                </Button>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </AnimatedHeight>
      <Dialog open={passwordResetConfirmOpen} onOpenChange={setPasswordResetConfirmOpen}>
        <DialogContent className="!max-w-md sm:!max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Password?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            We&apos;ll email a password-reset link to {email}. Continue securely from that link.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPasswordResetConfirmOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={requestPasswordReset} pending={busy}>
              Send reset link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthShell>
  );
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
