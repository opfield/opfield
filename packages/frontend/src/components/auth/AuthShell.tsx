import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { OpfieldMark } from "@/components/common/OpfieldMark";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

/**
 * An auth window's only content while it loads what it shows first. The
 * content then replaces it whole, so nothing already on screen moves.
 */
export function AuthWindowLoader({ label }: { label?: string }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-background">
      <LoadingSpinner className="" label={label} />
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
    </div>
  );
}

export function AuthShell({
  children,
  contentClassName,
  footerLeading,
  wide = false,
  loading = false,
  loadingLabel,
}: {
  children?: React.ReactNode;
  contentClassName?: string;
  footerLeading?: React.ReactNode;
  wide?: boolean;
  /** Hides the content behind `AuthWindowLoader` until it can show at its final size. */
  loading?: boolean;
  loadingLabel?: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div
        className={cn(
          "w-full space-y-6 text-center",
          wide ? "max-w-md" : "max-w-sm",
          contentClassName
        )}
        style={loading ? { visibility: "hidden" } : undefined}
        aria-busy={loading || undefined}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-3">
            <OpfieldMark className="h-10 w-10" />
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Opfield</h1>
          </div>
          <p className="text-sm text-muted-foreground">Infrastructure control plane</p>
        </div>
        {children}
        <div className="flex flex-col items-center gap-2 pt-3 text-xs text-muted-foreground">
          {footerLeading}
          <p>
            Powered by{" "}
            <a
              href="https://opfield.dev"
              target="_blank"
              rel="noreferrer"
              className="text-foreground hover:underline"
            >
              Opfield
            </a>
          </p>
        </div>
      </div>
      {loading ? <AuthWindowLoader label={loadingLabel} /> : null}
      <Toaster position="bottom-center" />
    </div>
  );
}
