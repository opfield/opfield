import { AlertTriangle } from "lucide-react";
import { useSearchParams } from "react-router-dom";

export function OAuthError() {
  const [searchParams] = useSearchParams();
  const code = searchParams.get("code") || "OAUTH_ERROR";
  const message = searchParams.get("message") || "OAuth authorization could not be completed.";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-warning/40 bg-warning/15 text-warning-foreground">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase text-warning-foreground">{code}</p>
            <h1 className="mt-1 text-lg font-semibold text-foreground">
              OAuth authorization failed
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{message}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
