import { motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  type Dispatch,
  type ElementType,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { AnimatedSwitch, CONTENT_SWITCH_ANIMATION } from "@/components/common/AnimatedSwitch";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { CopyButton } from "@/components/common/CopyButton";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Notice } from "@/components/common/Notice";
import { OpfieldMark } from "@/components/common/OpfieldMark";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { setupRequest } from "./setup-request";
import {
  isCloudCodeValid,
  type SetupAdministrator,
  type SetupCloudConnectState,
  type SignInDraft,
  type SignInOption,
} from "./setup-wizard-model";

interface NavigationProps {
  busy: boolean;
  onBack?: () => void;
  onContinue: () => void;
}

/** How long the step waits for the Opfield account's sign-in client before it offers a retry. */
const CLOUD_CLIENT_WAIT_MS = 60_000;
const CLOUD_CLIENT_POLL_MS = 2_000;

const SIGN_IN_OPTIONS: Array<{
  option: SignInOption;
  title: string;
  description: string;
  icon: ElementType;
}> = [
  {
    option: "opfield_account",
    title: "Opfield account",
    description:
      "Sign in with your account at account.opfield.dev. You become the first administrator.",
    icon: OpfieldMark,
  },
  {
    option: "oidc",
    title: "Your OIDC provider",
    description: "Authentik, Keycloak, Okta or any other OpenID Connect provider.",
    icon: ShieldCheck,
  },
  {
    option: "password_totp",
    title: "Password + authenticator app",
    description: "A password and a 6-digit code from an authenticator app. No SMTP needed.",
    icon: KeyRound,
  },
];

export function SignInStep({
  available,
  busy,
  pending = false,
  signIn,
  setSignIn,
  onBack,
  onContinue,
}: NavigationProps & {
  available: SignInOption[];
  /** Continue is disconnecting the Opfield account (another option was chosen after connecting). */
  pending?: boolean;
  signIn: SignInDraft;
  setSignIn: Dispatch<SetStateAction<SignInDraft>>;
}) {
  const canContinue = signIn.option !== null && available.includes(signIn.option);
  return (
    <section className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Sign-in</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how people sign in to this Opfield. Passkeys can be added after setup.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canContinue) onContinue();
        }}
      >
        <div className="space-y-2">
          {SIGN_IN_OPTIONS.map((item) => {
            const selected = signIn.option === item.option;
            return (
              <ChoiceCard
                key={item.option}
                icon={item.icon}
                title={item.title}
                description={item.description}
                aria-pressed={selected}
                className={selected ? "border-primary" : undefined}
                trailing={selected ? <Check className="h-4 w-4 text-foreground" /> : undefined}
                disabled={busy || !available.includes(item.option)}
                onClick={() => setSignIn((value) => ({ ...value, option: item.option }))}
              />
            );
          })}
        </div>
        <AnimatedSwitch>
          {signIn.option === "password_totp" ? (
            <motion.div key="email-code" {...CONTENT_SWITCH_ANIMATION}>
              <SwitchCard
                checked={signIn.emailOtp}
                onCheckedChange={(checked) =>
                  setSignIn((value) => ({ ...value, emailOtp: checked }))
                }
                label="Also allow an email code"
                description="People can sign in with a one-time code sent by email instead of the password. Needs SMTP."
                disabled={busy}
              />
            </motion.div>
          ) : (
            <motion.div key="no-email-code" {...CONTENT_SWITCH_ANIMATION} />
          )}
        </AnimatedSwitch>
        <div className="flex justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-max flex-none"
            onClick={onBack}
            disabled={busy}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            type="submit"
            className="w-max flex-none"
            pending={pending}
            disabled={busy || !canContinue}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}

function urlOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

type CloudScreen = "connect" | "code" | "finishing" | "waiting" | "timed-out" | "ready";

function cloudScreen(
  cloud: SetupCloudConnectState,
  codeEntry: boolean,
  timedOut: boolean,
  finishing: boolean
): CloudScreen {
  if (!cloud.connected) return finishing ? "finishing" : codeEntry ? "code" : "connect";
  if (cloud.signInClient === "ready") return "ready";
  return timedOut || cloud.signInClient === "none" ? "timed-out" : "waiting";
}

/**
 * Opfield account: Connect with Opfield account goes to the account portal and comes back to
 * /setup/cloud-callback; a code from account.opfield.dev works too. Once connected the step waits for
 * the sign-in client the account issues (within seconds), with a retry after a minute.
 */
export function CloudConnectStep({
  busy,
  cloud,
  csrfToken,
  finishing,
  publicUrl,
  setCloud,
  onBack,
  onContinue,
}: NavigationProps & {
  cloud: SetupCloudConnectState;
  csrfToken: string;
  /** The portal sent the browser back with a code and the installation is enrolling with it. */
  finishing: boolean;
  publicUrl: string;
  setCloud: (cloud: SetupCloudConnectState) => void;
}) {
  const [codeEntry, setCodeEntry] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<"connect" | "code" | "retry" | null>(null);
  const [waitStartedAt, setWaitStartedAt] = useState(() => Date.now());
  const [timedOut, setTimedOut] = useState(false);
  const setCloudRef = useRef(setCloud);
  setCloudRef.current = setCloud;
  const screen = cloudScreen(cloud, codeEntry, timedOut, finishing);
  const waiting = cloud.connected && cloud.signInClient === "requested";

  // While the client is on its way: ask every 2 s, and offer a retry after a minute.
  useEffect(() => {
    if (!waiting) return;
    let active = true;
    const poll = window.setInterval(() => {
      void setupRequest<SetupCloudConnectState>("/wizard/cloud-connect")
        .then((next) => {
          if (active) setCloudRef.current(next);
        })
        .catch(() => {});
    }, CLOUD_CLIENT_POLL_MS);
    const remaining = Math.max(0, waitStartedAt + CLOUD_CLIENT_WAIT_MS - Date.now());
    const timeout = window.setTimeout(() => setTimedOut(true), remaining);
    return () => {
      active = false;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
    };
  }, [waiting, waitStartedAt]);

  const connect = async () => {
    setPending("connect");
    try {
      const { url } = await setupRequest<{ url: string }>(
        "/wizard/cloud-connect/start",
        "POST",
        { publicUrl, returnOrigin: window.location.origin },
        csrfToken
      );
      // The portal sends the browser back to /setup/cloud-callback; the spinner stays until it leaves.
      window.location.assign(url);
    } catch (error) {
      toastApiError(error, "Could not start the Opfield account connection");
      setPending(null);
    }
  };

  const connectWithCode = async () => {
    setPending("code");
    try {
      const next = await setupRequest<SetupCloudConnectState>(
        "/wizard/cloud-connect/finish",
        "POST",
        { code: code.trim(), publicUrl },
        csrfToken
      );
      setWaitStartedAt(Date.now());
      setTimedOut(false);
      setCloud(next);
    } catch (error) {
      toastApiError(error, "Could not connect with this code");
    } finally {
      setPending(null);
    }
  };

  const retry = useCallback(async () => {
    setPending("retry");
    try {
      const next = await setupRequest<SetupCloudConnectState>(
        "/wizard/cloud-connect/client",
        "POST",
        { publicUrl },
        csrfToken
      );
      setWaitStartedAt(Date.now());
      setTimedOut(false);
      setCloudRef.current(next);
    } catch (error) {
      toastApiError(error, "Could not ask the Opfield account for the sign-in client");
    } finally {
      setPending(null);
    }
  }, [csrfToken, publicUrl]);

  const locked = busy || finishing || pending !== null;
  const signInOrigin = urlOrigin(publicUrl);
  const administrator = cloud.administrator;

  return (
    <section className="space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Opfield account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect this installation to your Opfield account. The person who connects it becomes the
          first administrator. This server needs outbound HTTPS to account.opfield.dev.
        </p>
        {signInOrigin && signInOrigin !== window.location.origin && (
          <p className="mt-1 text-xs text-muted-foreground">
            You are on {window.location.origin}; sign-in with the Opfield account will happen on{" "}
            {signInOrigin}.
          </p>
        )}
      </div>
      <AnimatedSwitch>
        {screen === "connect" && (
          <motion.div key="connect" {...CONTENT_SWITCH_ANIMATION} className="space-y-3">
            <div className="flex flex-col items-center gap-2">
              <Button
                type="button"
                className="w-max flex-none"
                pending={pending === "connect"}
                disabled={locked}
                onClick={() => void connect()}
              >
                <OpfieldMark className="h-4 w-4 text-current" title="" />
                Connect with Opfield account
              </Button>
              <Button
                type="button"
                variant="link"
                size="inline"
                disabled={locked}
                onClick={() => setCodeEntry(true)}
              >
                Enter a code instead
              </Button>
            </div>
          </motion.div>
        )}
        {screen === "code" && (
          <motion.div key="code" {...CONTENT_SWITCH_ANIMATION}>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (isCloudCodeValid(code) && !locked) void connectWithCode();
              }}
            >
              <div className="space-y-1.5 text-left">
                <label htmlFor="setup-cloud-code" className="text-sm font-medium">
                  Connect code
                </label>
                <Input
                  id="setup-cloud-code"
                  value={code}
                  autoComplete="off"
                  placeholder="CLD-XXXX-XXXX"
                  onChange={(event) => setCode(event.target.value)}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Create one in account.opfield.dev → Installations → Add.
                </p>
              </div>
              <div className="flex flex-col items-center gap-2">
                <Button
                  type="submit"
                  className="w-max flex-none"
                  pending={pending === "code"}
                  disabled={locked || !isCloudCodeValid(code)}
                >
                  <Check className="h-4 w-4" />
                  Connect
                </Button>
                <Button
                  type="button"
                  variant="link"
                  size="inline"
                  disabled={locked}
                  onClick={() => setCodeEntry(false)}
                >
                  Connect with Opfield account instead
                </Button>
              </div>
            </form>
          </motion.div>
        )}
        {screen === "finishing" && (
          <motion.div
            key="finishing"
            {...CONTENT_SWITCH_ANIMATION}
            className="flex flex-col items-center gap-2 py-2 text-center"
          >
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Connecting to your Opfield account</p>
          </motion.div>
        )}
        {screen === "waiting" && (
          <motion.div
            key="waiting"
            {...CONTENT_SWITCH_ANIMATION}
            className="flex flex-col items-center gap-2 py-2 text-center"
          >
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Waiting for the sign-in client</p>
            <p className="text-sm text-muted-foreground">
              Connected to {cloud.accountEmail ?? "your Opfield account"}. The account issues this
              installation&apos;s sign-in client within a few seconds.
            </p>
          </motion.div>
        )}
        {screen === "timed-out" && (
          <motion.div key="timed-out" {...CONTENT_SWITCH_ANIMATION} className="space-y-3">
            <Notice tone="warning" title="The sign-in client has not arrived">
              {cloud.signInClient === "none"
                ? "This installation is connected but has not asked the Opfield account for its sign-in client yet."
                : "The Opfield account did not send it within a minute. Check that this server can keep an outbound connection to account.opfield.dev, then retry."}
            </Notice>
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                className="w-max flex-none"
                pending={pending === "retry"}
                disabled={locked}
                onClick={() => void retry()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          </motion.div>
        )}
        {screen === "ready" && (
          <motion.div key="ready" {...CONTENT_SWITCH_ANIMATION}>
            <PanelShell title="Connected" description={cloud.accountEmail ?? undefined}>
              <SettingsControlRow title="Administrator" controlsClassName="sm:min-w-0 sm:max-w-64">
                <span className="break-all text-right text-sm text-muted-foreground">
                  {administrator
                    ? administrator.name
                      ? `${administrator.name} <${administrator.email}>`
                      : administrator.email
                    : "—"}
                </span>
              </SettingsControlRow>
              <SettingsControlRow title="Sign-in" controlsClassName="sm:min-w-0 sm:max-w-64">
                <span className="text-right text-sm text-muted-foreground">Opfield account</span>
              </SettingsControlRow>
            </PanelShell>
          </motion.div>
        )}
      </AnimatedSwitch>
      <div className="flex justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-max flex-none"
          onClick={onBack}
          disabled={locked}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button
          type="button"
          className="w-max flex-none"
          disabled={locked || screen !== "ready"}
          onClick={onContinue}
        >
          Continue
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}

function downloadRecoveryCodes(codes: string[]) {
  const url = URL.createObjectURL(
    new Blob([`Opfield recovery codes\n\n${codes.join("\n")}\n`], { type: "text/plain" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "opfield-recovery-codes.txt";
  anchor.click();
  URL.revokeObjectURL(url);
  toast.success("Downloaded");
}

type SecondFactorScreen = "start" | "totp" | "recovery" | "done";

/**
 * Password + authenticator app: the administrator (created on the step before) enrols an
 * authenticator app before setup can go on, and sees the recovery codes once.
 */
export function AdminSecondFactorStep({
  administrator,
  busy,
  csrfToken,
  onConfigured,
  onBack,
  onContinue,
}: NavigationProps & {
  administrator: SetupAdministrator | null;
  csrfToken: string;
  onConfigured: () => void;
}) {
  const configured = Boolean(administrator?.secondFactor);
  const [screen, setScreen] = useState<SecondFactorScreen>(configured ? "done" : "start");
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  const startTotp = async () => {
    setPending(true);
    try {
      setTotp(
        await setupRequest<{ secret: string; uri: string }>(
          "/wizard/administrator/totp/setup",
          "POST",
          undefined,
          csrfToken
        )
      );
      setCode("");
      setScreen("totp");
    } catch (error) {
      toastApiError(error, "Could not start the authenticator app setup");
    } finally {
      setPending(false);
    }
  };

  const confirmTotp = async () => {
    if (code.length !== 6) return;
    setPending(true);
    try {
      const result = await setupRequest<{ recoveryCodes: string[] }>(
        "/wizard/administrator/totp/confirm",
        "POST",
        { code },
        csrfToken
      );
      setRecoveryCodes(result.recoveryCodes);
      setScreen("recovery");
    } catch (error) {
      toastApiError(error, "The authentication code is not valid");
    } finally {
      setPending(false);
    }
  };

  const locked = busy || pending;

  return (
    <section className="mx-auto max-w-sm space-y-3">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Authenticator app</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {administrator?.email ?? "The administrator"} signs in with the password and a 6-digit
          code from an authenticator app. Administrators always need one.
        </p>
      </div>
      <AnimatedSwitch>
        {screen === "start" && (
          <motion.div key="start" {...CONTENT_SWITCH_ANIMATION} className="flex justify-center">
            <Button
              type="button"
              className="w-max flex-none"
              pending={pending}
              disabled={locked}
              onClick={() => void startTotp()}
            >
              <ShieldCheck className="h-4 w-4" />
              Set up authenticator app
            </Button>
          </motion.div>
        )}
        {screen === "totp" && totp && (
          <motion.div key="totp" {...CONTENT_SWITCH_ANIMATION}>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (code.length === 6 && !locked) void confirmTotp();
              }}
            >
              <p className="text-center text-sm text-muted-foreground">
                Scan this QR code with your authenticator app, then enter the code it shows.
              </p>
              <div className="flex justify-center bg-qr p-4">
                <QRCodeSVG
                  value={totp.uri}
                  size={176}
                  level="M"
                  marginSize={4}
                  title="TOTP setup QR code"
                />
              </div>
              <CopyValueField label="Manual setup key" value={totp.secret} />
              <div className="flex gap-2">
                <Input
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-label="Authentication code"
                  placeholder="6-digit code"
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  autoFocus
                />
                <Button
                  type="submit"
                  className="shrink-0"
                  pending={pending}
                  disabled={busy || code.length !== 6}
                >
                  <Check />
                  Activate
                </Button>
              </div>
            </form>
          </motion.div>
        )}
        {screen === "recovery" && (
          <motion.div key="recovery" {...CONTENT_SWITCH_ANIMATION} className="space-y-3">
            <Notice tone="warning" icon={ShieldCheck} title="Save your recovery codes">
              Each code works once if you lose the authenticator app. They are not shown again.
            </Notice>
            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((recoveryCode, index) => (
                <Input
                  key={recoveryCode}
                  value={recoveryCode}
                  readOnly
                  aria-label={`Recovery code ${index + 1}`}
                  className="font-mono"
                />
              ))}
            </div>
            <div className="flex justify-center gap-2">
              <CopyButton
                value={recoveryCodes.join("\n")}
                label="recovery codes"
                className="border border-border bg-background hover:bg-accent hover:text-accent-foreground"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => downloadRecoveryCodes(recoveryCodes)}
              >
                <Download className="h-4 w-4" />
                Download
              </Button>
            </div>
          </motion.div>
        )}
        {screen === "done" && (
          <motion.div key="done" {...CONTENT_SWITCH_ANIMATION}>
            <Notice tone="success" title="The authenticator app is set up">
              Recovery codes can be regenerated after setup in Profile → Security.
            </Notice>
          </motion.div>
        )}
      </AnimatedSwitch>
      <div className="flex justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-max flex-none"
          onClick={() => (screen === "totp" ? setScreen("start") : onBack?.())}
          disabled={locked || screen === "recovery"}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        {screen === "recovery" ? (
          <Button
            type="button"
            className="w-max flex-none"
            disabled={locked}
            onClick={() => {
              onConfigured();
              onContinue();
            }}
          >
            <Check className="h-4 w-4" />I saved these codes
          </Button>
        ) : (
          <Button
            type="button"
            className="w-max flex-none"
            disabled={locked || screen !== "done"}
            onClick={onContinue}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </section>
  );
}
