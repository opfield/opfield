import { AlertTriangle, ArrowRight, CheckCircle2, Info, Loader2 } from "lucide-react";
import type { ComponentProps, ElementType, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

export type NoticeTone = "destructive" | "warning" | "info" | "success";

const TONE_CLASSES: Record<NoticeTone, { border: string; text: string }> = {
  destructive: { border: "border-destructive/60", text: "text-destructive" },
  warning: { border: "border-warning/60", text: "text-warning-text" },
  info: { border: "border-link/55", text: "text-link" },
  success: { border: "border-success/60", text: "text-success-text" },
};

const TONE_ICONS: Record<NoticeTone, ElementType> = {
  destructive: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
};

/**
 * The tone to draw for a value that may come from the API: a known tone as is, "danger" or
 * "error" as destructive, anything else as warning, so an unexpected word never breaks the page.
 */
export function noticeTone(tone: string | null | undefined): NoticeTone {
  if (tone && Object.hasOwn(TONE_CLASSES, tone)) return tone as NoticeTone;
  if (tone === "danger" || tone === "error") return "destructive";
  return "warning";
}

/**
 * A notice that asks for attention, on the dashboard or inside a page or dialog:
 * an icon centred against a title in the tone colour and a muted summary, and
 * text actions on the right (`NoticeAction`). Show it only while something
 * needs attention.
 */
export function Notice({
  tone,
  icon,
  title,
  children,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  tone: NoticeTone;
  /** Defaults to the tone's icon. */
  icon?: ElementType;
  title: ReactNode;
  /** Summary under the title, in the muted text colour. */
  children?: ReactNode;
  /** Usually one or more `NoticeAction`. */
  actions?: ReactNode;
}) {
  const safeTone = noticeTone(tone);
  const toneClasses = TONE_CLASSES[safeTone];
  const Icon = icon ?? TONE_ICONS[safeTone];
  return (
    <div className={cn("rounded-lg border bg-card", toneClasses.border, className)} {...props}>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Icon className={cn("h-4 w-4 shrink-0", toneClasses.text)} aria-hidden="true" />
          <div className="min-w-0">
            <p className={cn("text-sm font-semibold", toneClasses.text)}>{title}</p>
            {children ? (
              <div className="mt-0.5 text-sm text-muted-foreground">{children}</div>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-4">{actions}</div> : null}
      </div>
    </div>
  );
}

const actionClassName = "flex shrink-0 items-center gap-1 text-sm font-medium hover:underline";

/**
 * A text action of a notice with a trailing arrow: an app link when `to` is
 * set, an external link when `href` is set, otherwise a button. It reads as part of the notice rather than as a
 * separate button. `pending` disables it and turns the arrow into a spinner.
 */
export function NoticeAction({
  tone,
  children,
  to,
  href,
  state,
  onClick,
  disabled,
  pending = false,
  muted = false,
  arrow = true,
}: {
  tone: NoticeTone;
  children: ReactNode;
  to?: string;
  /** An external page, opened in a new tab. */
  href?: string;
  state?: unknown;
  onClick?: () => void;
  disabled?: boolean;
  /** The action it started is running. */
  pending?: boolean;
  /** A secondary action, such as Hide, in the muted text colour. */
  muted?: boolean;
  arrow?: boolean;
}) {
  const className = cn(
    actionClassName,
    muted ? "text-muted-foreground hover:text-foreground" : TONE_CLASSES[noticeTone(tone)].text,
    "disabled:pointer-events-none disabled:opacity-50"
  );
  const content = (
    <>
      {children}
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : arrow ? (
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      ) : null}
    </>
  );
  if (to) {
    return (
      <Link to={to} state={state} className={className}>
        {content}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {content}
    </button>
  );
}
