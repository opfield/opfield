import { LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AuthShell } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";

const INVALID_LINK =
  "This recovery link is invalid, expired or used already. Run the admin recovery command again for a new link.";

/**
 * The one-time link of the admin recovery command (`node dist/cli/admin-recovery-link.js`, run on
 * the host): signs a system administrator in without their usual sign-in or second factor, then
 * opens Profile → Security to fix it. The link is taken only on the button, never on load, so a
 * link preview cannot use it up.
 */
export function RecoverySignIn() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [pending, setPending] = useState(false);

  // The page is left on success, so the button stays pending until it is gone (and resets if it comes back from cache).
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const signIn = async () => {
    setPending(true);
    try {
      const response = await fetch("/auth/recovery/sign-in", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        redirectTo?: string;
      };
      if (!response.ok) throw new Error(data.message ?? INVALID_LINK);
      window.location.assign(data.redirectTo ?? "/profile#security");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : INVALID_LINK);
      setPending(false);
    }
  };

  return (
    <AuthShell>
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Recovery sign-in</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This one-time link signs you in as a system administrator without your usual sign-in or
            second factor. You land on Profile → Security to fix them. It works once and for 30
            minutes after it was made.
          </p>
        </div>
        <div className="flex justify-center">
          <Button
            className="w-max flex-none"
            pending={pending}
            disabled={!token}
            onClick={() => void signIn()}
          >
            <LogIn className="h-4 w-4" />
            Sign in
          </Button>
        </div>
      </section>
    </AuthShell>
  );
}
