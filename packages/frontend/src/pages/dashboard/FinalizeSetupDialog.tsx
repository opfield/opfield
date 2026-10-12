import { ArrowRight, Bot, Check, Cloud, KeyRound, Server, Sparkles, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { ChoiceCard } from "@/components/common/ChoiceCard";
import { confirm } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastApiError } from "@/lib/api-error-toast";
import type { FinalizeSetupState, FinalizeSetupStep, FinalizeSetupStepStatus } from "@/types";

export type FinalizeSetupRootStep =
  | Exclude<FinalizeSetupStep, "cloudflare" | "gitlab">
  | "integrations";

export function finalizeSetupSkipPromptStorageKey(userId: string): string {
  return `gateway:finalize-setup:skip-prompt-shown:${userId}`;
}

function readSkipPromptShown(userId: string): boolean {
  if (!userId || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(finalizeSetupSkipPromptStorageKey(userId)) === "true";
  } catch {
    return false;
  }
}

function saveSkipPromptShown(userId: string): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(finalizeSetupSkipPromptStorageKey(userId), "true");
  } catch {
    // Storage can be unavailable; it is safe to ask for confirmation again.
  }
}

const ROOT_STEPS: Array<{
  id: FinalizeSetupRootStep;
  title: string;
  description: string;
  icon: typeof Server;
}> = [
  {
    id: "nodes",
    title: "Connect your first node",
    description: "Enroll an nginx, Docker, database, or monitoring node.",
    icon: Server,
  },
  {
    id: "ai_workspace",
    title: "Configure AI Workspace",
    description: "Connect the Workspace model used for intent-driven operations.",
    icon: Bot,
  },
  {
    id: "mfa",
    title: "Set up MFA for your account",
    description: "Protect this administrator account with a passkey or authenticator app.",
    icon: KeyRound,
  },
  {
    id: "invite_users",
    title: "Invite users",
    description: "Create an additional local account and send its sign-in instructions.",
    icon: UserPlus,
  },
  {
    id: "integrations",
    title: "Connect integrations",
    description: "Configure DNS and source-control connectors for infrastructure workflows.",
    icon: Cloud,
  },
];

type FinalizeSetupRootStepStatus = FinalizeSetupStepStatus | "in_progress";

function stepStatus(
  state: FinalizeSetupState,
  step: FinalizeSetupRootStep
): FinalizeSetupRootStepStatus {
  if (step !== "integrations") return state.steps[step];
  const statuses = [state.steps.cloudflare, state.steps.gitlab];
  if (
    statuses.every((status) => status !== "pending") &&
    statuses.some((status) => status === "configured")
  ) {
    return "configured";
  }
  if (statuses.every((status) => status !== "pending")) return "skipped";
  if (statuses.some((status) => status === "configured" || status === "skipped"))
    return "in_progress";
  return "pending";
}

function StepStatusBadge({ status }: { status: FinalizeSetupRootStepStatus }) {
  if (status === "configured") {
    return (
      <Badge variant="success" className="gap-1">
        <Check className="h-3 w-3" /> Configured
      </Badge>
    );
  }
  if (status === "skipped") return <Badge variant="outline">Skipped</Badge>;
  if (status === "in_progress") return <Badge variant="secondary">In progress</Badge>;
  return <Badge variant="secondary">Not started</Badge>;
}

export function FinalizeSetupDialog({
  open,
  state,
  userId,
  busy,
  canInviteUsers = false,
  onOpenWizard,
  onSkipForNow,
  onFinish,
}: {
  open: boolean;
  state: FinalizeSetupState;
  userId: string;
  busy?: boolean;
  canInviteUsers?: boolean;
  onOpenWizard: (step: FinalizeSetupRootStep) => void;
  onSkipForNow: () => void | Promise<void>;
  onFinish: () => void;
}) {
  const isComplete = Object.values(state.steps).every((status) => status !== "pending");
  const [dismissing, setDismissing] = useState(false);
  const [skipPromptShown, setSkipPromptShown] = useState(() => readSkipPromptShown(userId));

  useEffect(() => {
    if (!open) {
      setDismissing(false);
    }
  }, [open]);

  useEffect(() => {
    setSkipPromptShown(readSkipPromptShown(userId));
  }, [userId]);

  const skipForNow = async () => {
    setDismissing(true);
    try {
      await onSkipForNow();
    } catch (cause) {
      toastApiError(cause, "Failed to skip setup for now");
    } finally {
      setDismissing(false);
    }
  };

  const requestDismiss = async () => {
    if (skipPromptShown) {
      await skipForNow();
      return;
    }
    const confirmed = await confirm({
      title: "Skip Setup for Now?",
      description:
        "These steps introduce Opfield's core capabilities. If you are new to Opfield or want to understand its features in more detail, we recommend completing at least the items that apply to your installation. You can still configure every feature later from Settings.",
      cancelLabel: "Continue setup",
      confirmLabel: "Skip for now",
      variant: "default",
      locked: true,
    });
    if (confirmed) {
      saveSkipPromptShown(userId);
      setSkipPromptShown(true);
      await skipForNow();
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}} modal>
      <DialogContent
        hideCloseButton
        className="sm:max-w-2xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Finalize Opfield Setup</DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="space-y-2">
            <p>
              Opfield is ready to use. This checklist walks the first administrator through the
              capabilities that usually make a new installation useful: infrastructure nodes,
              account protection, optional AI, and external integrations.
            </p>
            <p>
              Every item stays inside this guided experience and only applies changes after you
              explicitly save them. Complete the parts that apply to this installation; a completed
              item is marked here so you can see your progress.
            </p>
            <p>
              You can skip this checklist for now or skip an optional flow and return to every
              setting later. If Opfield is new to you, completing at least the relevant items
              provides the quickest path to understanding how its core features fit together.
            </p>
          </div>
        </DialogDescription>
        <div className="space-y-3">
          {ROOT_STEPS.filter((step) => step.id !== "invite_users" || canInviteUsers).map((step) => {
            const status = stepStatus(state, step.id);
            const canOpen = !isComplete && status !== "configured";
            return (
              <ChoiceCard
                key={step.id}
                icon={step.icon}
                title={step.title}
                description={step.description}
                trailing={<StepStatusBadge status={status} />}
                disabled={!canOpen || busy}
                onClick={() => onOpenWizard(step.id)}
              />
            );
          })}
        </div>
        <DialogFooter>
          <Button
            variant={isComplete ? "default" : "outline"}
            onClick={() => void (isComplete ? onFinish() : requestDismiss())}
            pending={dismissing}
            disabled={busy}
          >
            {isComplete ? (
              <>
                <Sparkles />
                Finish
              </>
            ) : (
              <>
                Skip for now
                <ArrowRight />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
