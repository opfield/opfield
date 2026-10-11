import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { CopyValueField } from "@/components/common/CopyValueField";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import type { GitHubOAuthSession, GitHubOAuthStartRequest } from "@/types/integrations";

export function GitHubDeviceFlow({
  request,
  disabled,
  onCompleted,
  onActiveChange,
}: {
  request: GitHubOAuthStartRequest;
  disabled?: boolean;
  onCompleted: (connectorId: string) => void | Promise<void>;
  onActiveChange?: (active: boolean) => void;
}) {
  const [session, setSession] = useState<GitHubOAuthSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [pollAttempt, setPollAttempt] = useState(0);
  const sessionRef = useRef<GitHubOAuthSession | null>(null);
  sessionRef.current = session;

  useEffect(
    () => () => {
      const current = sessionRef.current;
      if (current?.status === "pending" || current?.status === "processing") {
        void api.cancelGitHubOAuth(current.id).catch(() => {});
      }
    },
    []
  );

  useEffect(() => {
    if (!session || (session.status !== "pending" && session.status !== "processing")) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.getGitHubOAuthStatus(session.id);
        if (cancelled) return;
        if (pollAttempt !== 0) setPollAttempt(0);
        setSession(next);
        if (next.status === "complete" && next.connectorId) await onCompleted(next.connectorId);
        else if (["error", "expired", "cancelled"].includes(next.status)) {
          toast.error(next.errorMessage ?? "GitHub authorization did not complete");
        }
      } catch (cause) {
        if (!cancelled) {
          toast.error(cause instanceof Error ? cause.message : "GitHub authorization check failed");
          setPollAttempt((current) => current + 1);
        }
      }
    }, Math.max(1, session.pollIntervalSeconds) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onCompleted, pollAttempt, session]);

  const start = async () => {
    setStarting(true);
    try {
      // Deliberately do not open GitHub here. The code must be visible before
      // the user explicitly chooses to leave the Gateway tab.
      setSession(await api.startGitHubOAuth(request));
      onActiveChange?.(true);
      setPollAttempt(0);
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "GitHub authorization could not be started"
      );
    } finally {
      setStarting(false);
    }
  };

  if (!session) {
    return (
      <DeviceFlowTransition stateKey="start">
        <Button type="button" disabled={disabled} pending={starting} onClick={() => void start()}>
          Start GitHub authorization
        </Button>
      </DeviceFlowTransition>
    );
  }

  const terminal = ["error", "expired", "cancelled"].includes(session.status);
  if (terminal) {
    return (
      <DeviceFlowTransition stateKey="terminal">
        <div className="space-y-2 text-sm">
          <p className="text-destructive">
            {session.errorMessage ?? "GitHub authorization did not complete."}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSession(null);
              onActiveChange?.(false);
            }}
          >
            Restart authorization
          </Button>
        </div>
      </DeviceFlowTransition>
    );
  }

  return (
    <DeviceFlowTransition stateKey="pending">
      <div className="space-y-3 border border-border p-4">
        <p className="text-sm">
          Complete authorization in the GitHub window. Gateway checks the status automatically.
        </p>
        <CopyValueField
          label="Authorization code"
          value={session.userCode}
          valueClassName="font-mono"
          actions={
            <Button
              type="button"
              variant="ghost"
              className="rounded-none border-l border-border bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => window.open(session.verificationUri, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink />
              Open GitHub
            </Button>
          }
        />
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Waiting for GitHub authorization…
        </p>
      </div>
    </DeviceFlowTransition>
  );
}

function DeviceFlowTransition({ stateKey, children }: { stateKey: string; children: ReactNode }) {
  return (
    <AnimatedHeight>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={stateKey}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </AnimatedHeight>
  );
}
