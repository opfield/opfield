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
  title,
  subtitle = "Infrastructure control plane",
}: {
  children?: React.ReactNode;
  contentClassName?: string;
  footerLeading?: React.ReactNode;
  wide?: boolean;
  /** Hides the content behind `AuthWindowLoader` until it can show at its final size. */
  loading?: boolean;
  loadingLabel?: string;
  /**
   * A page that is not Opfield's own sign-in (an access list's, on a protected site's behalf)
   * names what it is for: the title replaces the Opfield mark and name, and the footer reads
   * "Protected by Opfield".
   */
  title?: string;
  subtitle?: string;
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
          {title !== undefined ? (
            <h1 className="max-w-full break-words text-3xl font-bold tracking-tight text-foreground">
              {title}
            </h1>
          ) : (
            <div className="flex items-center gap-3">
              <OpfieldMark className="h-10 w-10" />
              <h1 className="text-3xl font-bold tracking-tight text-foreground">Opfield</h1>
            </div>
          )}
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {children}
        <div className="flex flex-col items-center gap-2 pt-3 text-xs text-muted-foreground">
          {footerLeading}
          <p>
            {title !== undefined ? "Protected by" : "Powered by"}{" "}
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
