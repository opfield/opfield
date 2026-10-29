import { ArrowLeft, ArrowRight, KeyRound, LogIn, UserRound } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AuthShell } from "@/components/auth/AuthShell";
import { OpfieldMark } from "@/components/common/OpfieldMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { authRequest } from "@/pages/Login";
import type { AccessSignInContext, AccessSignInMethodOption } from "@/types";

type ReadyContext = Exclude<AccessSignInContext, { redirect: string }>;
type Step = "methods" | "password" | "shared";

const goTo = (url: string) => window.location.assign(url);

function MethodButton({
  method,
  primary,
  onClick,
}: {
  method: AccessSignInMethodOption;
  primary: boolean;
  onClick: () => void;
}) {
  let icon: ReactNode = <LogIn className="h-4 w-4" />;
  let label = `Sign in with ${method.label}`;
  if (method.kind === "opfield") icon = <OpfieldMark className="h-4 w-4 text-current" title="" />;
  if (method.kind === "password") {
    icon = <UserRound className="h-4 w-4" />;
    label = "Sign in with username";
  }
  if (method.kind === "shared") {
    icon = <KeyRound className="h-4 w-4" />;
    label = "Enter shared password";
  }
  return (
    <Button className="w-full" variant={primary ? "default" : "outline"} onClick={onClick}>
      {icon}
      {label}
    </Button>
  );
}

/**
 * The page an access list sends visitors to (`/access/sign-in` on the sign-in domain): the
 * protected host as the title, the list's sign-in methods, the username and shared password
 * forms, and "no access" for a signed-in visitor the list turns away. Every step ends in a
 * redirect back to the host.
 */
export function AccessSignInPage() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const flow = {
    list: params.get("list") ?? "",
    host: params.get("host") ?? "",
    n: params.get("n") ?? "",
    r: params.get("r") ?? "",
  };
  const [context, setContext] = useState<ReadyContext | null>(null);
  const [failed, setFailed] = useState(false);
  const [step, setStep] = useState<Step>("methods");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authRequest<AccessSignInContext>(`/api/access-sign-in/context${search}`)
      .then((next) => {
        if (cancelled) return;
        if ("redirect" in next) return goTo(next.redirect);
        setContext(next);
        // A list with only a form opens it right away.
        const only = next.methods.length === 1 ? next.methods[0]?.kind : undefined;
        if (only === "password" || only === "shared") setStep(only);
      })
      .catch((error) => {
        if (cancelled) return;
        toastApiError(error, "Sign-in is unavailable");
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [search]);

  const submit = async (kind: "password" | "shared", event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const body = kind === "password" ? { ...flow, username, password } : { ...flow, password };
      const result = await authRequest<{ redirect: string }>(`/api/access-sign-in/${kind}`, body);
      goTo(result.redirect);
    } catch (error) {
      toastApiError(error, "Sign-in failed");
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await authRequest("/api/access-sign-in/sign-out", {});
      window.location.reload();
    } catch (error) {
      toastApiError(error, "Sign-out failed");
      setBusy(false);
    }
  };

  if (!context) {
    return failed ? (
      <AuthShell title={flow.host || "Sign in"} subtitle="This sign-in link no longer works" />
    ) : (
      <AuthShell title="" loading />
    );
  }

  const host = context.host;
  const backToMethods =
    context.methods.length > 1 ? (
      <div className="flex justify-center">
        <Button
          type="button"
          variant="outline"
          className="w-max flex-none"
          onClick={() => {
            setPassword("");
            setStep("methods");
          }}
        >
          <ArrowLeft className="h-4 w-4" />
          Other sign-in methods
        </Button>
      </div>
    ) : null;

  if (context.state === "denied") {
    const who = context.identity?.email || context.identity?.name;
    return (
      <AuthShell title={host} subtitle="You don't have access to this site">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {who ? (
              <>
                Signed in as <span className="text-foreground">{who}</span>. Ask the owner of {host}{" "}
                to let this account in.
              </>
            ) : (
              <>Ask the owner of {host} to let this account in.</>
            )}
          </p>
          <div className="flex justify-center">
            <Button
              variant="outline"
              className="w-max flex-none"
              pending={busy}
              onClick={() => void signOut()}
            >
              <LogIn className="h-4 w-4" />
              Use another account
            </Button>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (step === "shared") {
    return (
      <AuthShell title={host} subtitle="Enter the password to continue">
        <div className="space-y-3">
          <form className="flex gap-2" onSubmit={(event) => void submit("shared", event)}>
            <Input
              type="password"
              aria-label="Password"
              placeholder="Password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" className="shrink-0" pending={busy} disabled={!password}>
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>
          {backToMethods}
        </div>
      </AuthShell>
    );
  }

  if (step === "password") {
    return (
      <AuthShell title={host} subtitle="Sign in to continue">
        <form className="space-y-3" onSubmit={(event) => void submit("password", event)}>
          <Input
            aria-label="Username"
            placeholder="Username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <div className="flex gap-2">
            <Input
              type="password"
              aria-label="Password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button
              type="submit"
              className="shrink-0"
              pending={busy}
              disabled={!username.trim() || !password}
            >
              Sign in
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          {backToMethods}
        </form>
      </AuthShell>
    );
  }

  const choose = (method: AccessSignInMethodOption) => {
    if (method.kind === "opfield") return goTo(`/access/opfield/start${search}`);
    if (method.kind === "idp") {
      const providerId = method.key.replace(/^idp:/, "");
      return goTo(`/access/idp/${encodeURIComponent(providerId)}/start${search}`);
    }
    setPassword("");
    setStep(method.kind);
  };

  return (
    <AuthShell title={host} subtitle="Sign in to continue">
      <div className="flex flex-col gap-3">
        {context.methods.map((method, index) => (
          <MethodButton
            key={method.key}
            method={method}
            primary={index === 0}
            onClick={() => choose(method)}
          />
        ))}
      </div>
    </AuthShell>
  );
}
