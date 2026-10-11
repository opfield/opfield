import { useEffect, useState } from "react";

/** Time left as m:ss (0:00 once expired). */
export function formatCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Counts down to `expiresAt` once a second; calls `onExpired` once when it reaches zero. */
export function ConnectCodeCountdown({
  expiresAt,
  onExpired,
}: {
  expiresAt: string;
  onExpired?: () => void;
}) {
  const deadline = Date.parse(expiresAt);
  const [now, setNow] = useState(() => Date.now());
  const remaining = deadline - now;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const expired = remaining <= 0;
  useEffect(() => {
    if (expired) onExpired?.();
  }, [expired, onExpired]);

  return (
    <span
      className="tabular-nums text-sm text-muted-foreground"
      role="timer"
      aria-label={`Code expires in ${formatCountdown(remaining)}`}
    >
      {formatCountdown(remaining)}
    </span>
  );
}
