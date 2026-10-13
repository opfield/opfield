import { OpfieldMark } from "@/components/common/OpfieldMark";
import { cn } from "@/lib/utils";

/**
 * The header lockup: the 24 px mark and the lowercase wordmark in the display face at 16 px, as in the brand
 * files. One component for every header, so a fix to it reaches all of them.
 */
export function OpfieldLockup({ suffix, className }: { suffix?: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 whitespace-nowrap font-display text-base font-semibold text-foreground/80",
        className
      )}
    >
      <OpfieldMark className="h-6 w-6" />
      opfield
      {suffix ? ` ${suffix}` : null}
    </span>
  );
}
