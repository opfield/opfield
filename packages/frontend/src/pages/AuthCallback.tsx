import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthWindowLoader } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/button";
import { resolveAuthReturnTo } from "@/lib/auth-return-to";

let currentUserRequest: Promise<void> | null = null;
const redirectToOpfield = (path: string) => window.location.replace(path);

function loadCurrentUserOnce() {
  if (!currentUserRequest) {
    currentUserRequest = fetch("/auth/me", { credentials: "include" })
      .then(async (response) => {
        if (response.ok) return;
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Authentication failed");
      })
      .finally(() => {
        currentUserRequest = null;
      });
  }
  return currentUserRequest;
}

export function AuthCallback({
  onAuthenticated = redirectToOpfield,
}: {
  onAuthenticated?: (path: string) => void;
} = {}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const returnTo = resolveAuthReturnTo(`?${searchParams.toString()}`);

  useEffect(() => {
    let cancelled = false;

    const handleCallback = async () => {
      const errorParam = searchParams.get("error");

      if (errorParam) {
        if (!cancelled) setError(errorParam);
        return;
      }

      try {
        await loadCurrentUserOnce();
        if (cancelled) return;
        onAuthenticated(returnTo);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Authentication failed";
        setError(message);
      }
    };

    void handleCallback();

    return () => {
      cancelled = true;
    };
  }, [searchParams, onAuthenticated, returnTo]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <h2 className="text-lg font-semibold text-foreground">Authentication Failed</h2>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" className="mt-2" onClick={() => navigate("/login")}>
            Back to login
          </Button>
        </div>
      </div>
    );
  }

  return <AuthWindowLoader label="Authenticating..." />;
}
