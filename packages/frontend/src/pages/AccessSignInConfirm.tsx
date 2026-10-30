import { ArrowRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AuthWindowLoader } from "@/components/auth/AuthShell";
import { OpfieldMark } from "@/components/common/OpfieldMark";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import type { AccessSignInConsent } from "@/types";

/**
 * A protected route offers "Opfield account" sign-in: the console asks its signed-in user before it vouches for them.
 * Continue sends the visitor back to the route signed in; Cancel sends them back with a failed sign-in.
 */
export function AccessSignInConfirm() {
  const [searchParams] = useSearchParams();
  const state = searchParams.get("state") ?? "";
  const [consent, setConsent] = useState<AccessSignInConsent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (!state) {
      setError("This sign-in expired; start again");
      return;
    }
    let cancelled = false;
    void api
      .getAccessSignInConsent(state)
      .then((data) => {
        if (!cancelled) setConsent(data);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "This sign-in expired; start again");
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  // The page is left on success, so the buttons stay pending until it is gone (and reset if it comes back from cache).
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setSubmitting(null);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const decide = async (decision: "approve" | "deny") => {
    setSubmitting(decision);
    try {
      const result = await api.decideAccessSignIn(state, decision);
      window.location.assign(result.redirectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This sign-in expired; start again");
      setSubmitting(null);
    }
  };

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md border border-border bg-card p-5">
          <h1 className="text-lg font-semibold text-foreground">Sign-in failed</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }
  if (!consent) return <AuthWindowLoader label="Loading sign-in request..." />;

  const accountName = consent.account.name || consent.account.email;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="flex w-full max-w-md flex-col border border-border bg-card">
        <div className="border-b border-border p-5">
          <div className="flex items-center gap-3">
            <OpfieldMark className="h-9 w-9" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Opfield account</p>
              <h1 className="break-words text-xl font-semibold text-foreground">
                Continue to {consent.host}?
              </h1>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{consent.host}</span> will be signed in as
            you and receives your name, email and groups. Continue only if you opened this site
            yourself.
          </p>
        </div>
        <section className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-border bg-muted text-sm font-semibold">
              {accountName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 text-left">
              <p className="truncate text-sm font-medium text-foreground">{accountName}</p>
              <p className="truncate text-xs text-muted-foreground">{consent.account.email}</p>
            </div>
          </div>
        </section>
        <div className="flex flex-col-reverse gap-3 border-t border-border p-5 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => void decide("deny")}
            pending={submitting === "deny"}
            disabled={submitting !== null}
          >
            <X className="h-4 w-4" />
            Cancel
          </Button>
          <Button
            onClick={() => void decide("approve")}
            pending={submitting === "approve"}
            disabled={submitting !== null}
          >
            <ArrowRight className="h-4 w-4" />
            Continue as {accountName}
          </Button>
        </div>
      </div>
    </div>
  );
}
