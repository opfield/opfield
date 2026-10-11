import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ListChecks,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Square,
  X,
} from "lucide-react";
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AI_APPROVAL_MODE_META,
  AI_APPROVAL_MODES,
  type AIApprovalMode,
} from "@/lib/ai-approval-mode";
import { cn } from "@/lib/utils";
import { type AIContextUsage, getAIContextUsage, useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature } from "@/stores/license-paywall";
import type {
  AIComposerAttachment,
  AIConversationInput,
  AIInferenceModelOption,
  AIMessage as AIMessageType,
  AIPlanRuntimeSnapshot,
  PageContext,
} from "@/types/ai";
import { AIContextUsageDialog } from "./AIContextUsageDialog";
import { AIProgressRing } from "./AIProgressRing";
import { AIProviderControls } from "./AIProviderControls";
import { QuestionBlock } from "./AIToolCallBlock";
import {
  AI_ATTACHMENT_TILE,
  AI_CONTROL_DISABLED,
  AI_ICON_CONTROL,
  AI_TEXT_ACTION,
  AI_TOOLBAR_TRIGGER,
  AI_TOOLBAR_TRIGGER_MUTED,
} from "./ai-control-classes";
import { InferenceQuotaStatus, useInferenceQuota } from "./InferenceQuotaStatus";
import { getComposerAttachmentId, getComposerAttachmentPreviewUrl } from "./useAIComposerDraft";

export interface AISlashCommand {
  name: string;
  description: string;
}

interface AIComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onContinue?: () => void;
  onStop: () => void;
  onSlashCommandSelect: (command: AISlashCommand) => void;
  slashResults: AISlashCommand[];
  slashIndex: number;
  messages: AIMessageType[];
  context?: PageContext;
  conversationId?: string | null;
  isStreaming: boolean;
  isConnected: boolean;
  canContinue?: boolean;
  stopDisabled?: boolean;
  retryAfter?: number | null;
  approvalMode: AIApprovalMode;
  approvalModeLabel: string;
  setApprovalMode: (mode: AIApprovalMode) => void | Promise<void>;
  workMode: "normal" | "plan";
  setWorkMode: (mode: "normal" | "plan") => void;
  interactionDisabled?: boolean;
  modelOptions?: AIInferenceModelOption[];
  selectedModel?: string | null;
  onModelChange?: (model: string) => void | Promise<void>;
  reasoningOptions?: string[];
  selectedReasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string) => void | Promise<void>;
  gatewayInferenceMode?: boolean;
  attachments?: AIComposerAttachment[];
  canAttachImages?: boolean;
  uploadingAttachments?: boolean;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemoveAttachment?: (attachmentId: string) => void;
  onPreviewAttachment?: (attachment: AIComposerAttachment) => void;
  maxRows?: number;
  className?: string;
  surfaceClassName?: string;
  slashPaletteClassName?: string;
  showDisclaimer?: boolean;
}

const MAX_IMAGE_ATTACHMENTS = 3;

function formatPlanStepTitle(title: string): string {
  return title.replace(/^\s*\d+[.)]\s+/, "");
}

export function AIPlanBlock({
  plan,
  collapsed = false,
  className,
}: {
  plan: AIPlanRuntimeSnapshot;
  collapsed?: boolean;
  className?: string;
}) {
  if (!plan.revisionId || !plan.goal) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="border border-border bg-muted/30">
        <div className="border-b border-border bg-muted/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-link" />
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
              {plan.title || "Implementation plan"}
            </h3>
            <span className="text-xs capitalize text-muted-foreground">
              {(collapsed ? plan.revisionStatus : plan.status)?.replace("_", " ")}
            </span>
          </div>
          {!collapsed && <p className="mt-2 text-sm text-muted-foreground">{plan.goal}</p>}
        </div>
        {!collapsed && (
          <div className="divide-y divide-border">
            {plan.steps.map((step) => (
              <div key={step.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center border border-border text-xs",
                    (step.status === "completed" || step.status === "skipped") &&
                      "border-primary bg-primary text-primary-foreground"
                  )}
                >
                  {step.status === "completed" || step.status === "skipped" ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    step.ordinal + 1
                  )}
                </span>
                <div className="min-w-0">
                  <div className="font-medium">{formatPlanStepTitle(step.title)}</div>
                  <div className="mt-0.5 text-muted-foreground">{step.description}</div>
                  {step.skipReason && (
                    <div className="mt-1 text-xs">Skipped: {step.skipReason}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="divide-y divide-border border border-border bg-muted/30">
          <PlanDetails label="Research">
            {plan.research.map((item) => (
              <div key={`${item.title}:${item.summary}`}>
                <div className="font-medium text-foreground">{item.title}</div>
                <div>{item.summary}</div>
              </div>
            ))}
          </PlanDetails>
          <PlanDetails label="Intent and safety review">
            <div>{plan.intentReview?.summary || "Intent review is pending."}</div>
            <div>{plan.securityReview?.summary || "Safety review is pending."}</div>
          </PlanDetails>
          <PlanDetails label="Verification">
            {plan.verification.map((item) => (
              <div key={`${item.title}:${item.description}`}>
                <span className="font-medium text-foreground">{item.title}: </span>
                {item.description}
              </div>
            ))}
          </PlanDetails>
        </div>
      )}
    </div>
  );
}

export function AIPlanDecision({
  onImplement,
  onRefine,
  onCustom,
}: {
  onImplement: () => void;
  onRefine: () => void;
  onCustom: (instruction: string) => void;
}) {
  return (
    <QuestionBlock
      toolCall={{
        id: "plan-decision",
        name: "ask_question",
        arguments: {
          question: "Implement this plan?",
          options: [
            {
              label: "Implement plan",
              description: "Exit Plan mode and begin execution.",
            },
            {
              label: "Refine details",
              description: "Stay in Plan mode and add more detail.",
            },
          ],
          allowFreeText: true,
        },
        status: "awaiting_approval",
      }}
      onAnswer={(_id, answer) => {
        if (answer === "Implement plan") onImplement();
        else if (answer === "Refine details") onRefine();
        else onCustom(answer);
      }}
    />
  );
}

function PlanDetails({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium">
        <ChevronDown className="h-3.5 w-3.5 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-4 pb-3 text-sm text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AIPlanProgress({
  plan,
  onPause,
  onResume,
  onCancel,
  className,
}: {
  plan: AIPlanRuntimeSnapshot;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const [elapsedMs, setElapsedMs] = useState(plan.activeTimeMs);
  useEffect(() => {
    setElapsedMs(plan.activeTimeMs);
    if (
      plan.status !== "executing" &&
      plan.status !== "pause_requested" &&
      plan.status !== "verifying"
    )
      return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedMs(plan.activeTimeMs + Date.now() - startedAt),
      1000
    );
    return () => window.clearInterval(timer);
  }, [plan.activeTimeMs, plan.status]);
  if (
    plan.status !== "executing" &&
    plan.status !== "pause_requested" &&
    plan.status !== "paused" &&
    plan.status !== "verifying"
  ) {
    return null;
  }
  const completed = plan.steps.filter(
    (step) => step.status === "completed" || step.status === "skipped"
  ).length;
  const progress = plan.steps.length > 0 ? (completed / plan.steps.length) * 100 : 0;
  const canPause = plan.status === "executing" || plan.status === "verifying";
  const cancel = async () => {
    const accepted = await confirm({
      title: "Cancel Plan?",
      description: "Execution will stop. Changes already made will not be rolled back.",
      confirmLabel: "Cancel plan",
      cancelLabel: "Keep running",
      variant: "destructive",
    });
    if (accepted) onCancel();
  };
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 border border-border bg-primary/5 px-2.5 py-1.5",
        className
      )}
    >
      <AIProgressRing value={progress} className="h-5 w-5" ariaLabel="Plan progress" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{plan.title || "Plan execution"}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">
            {plan.status === "paused"
              ? plan.pauseReason || "Paused"
              : plan.status === "pause_requested"
                ? "Pausing after current tool round"
                : plan.status === "verifying"
                  ? "Running final verification"
                  : plan.steps.find((step) => step.status === "in_progress")?.title ||
                    "Preparing next step"}
          </span>
          <span className="shrink-0">
            {completed}/{plan.steps.length} · {formatPlanDuration(elapsedMs)}
          </span>
        </div>
      </div>
      {plan.status === "paused" ? (
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onResume}
          aria-label="Resume plan"
          title="Resume plan"
        >
          <Play className="h-3.5 w-3.5" />
        </Button>
      ) : canPause ? (
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onPause}
          aria-label="Pause plan"
          title="Pause plan"
        >
          <Pause className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={() => void cancel()}
        aria-label="Cancel plan"
        title="Cancel plan"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

function formatPlanDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface AIQueuedMessagesProps {
  items: AIConversationInput[];
  onSendNow: (inputId: string) => void;
  onEdit: (item: AIConversationInput) => void;
  onRemove: (inputId: string) => void;
  className?: string;
}

export function AIQueuedMessages({
  items,
  onSendNow,
  onEdit,
  onRemove,
  className,
}: AIQueuedMessagesProps) {
  if (items.length === 0) return null;
  return (
    <div className={cn("divide-y divide-border border border-border bg-background", className)}>
      {items.map((item) => (
        <div key={item.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {item.content || `${item.attachments.length} attached image(s)`}
          </span>
          {/* Queue row actions share the composer's borderless controls. */}
          <button
            type="button"
            className={cn(AI_ICON_CONTROL, "h-7 w-7")}
            onClick={() => onEdit(item)}
            aria-label="Edit queued message"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={cn(AI_ICON_CONTROL, "h-7 w-7")}
            onClick={() => onRemove(item.id)}
            aria-label="Remove queued message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={cn(AI_TEXT_ACTION, "text-sm text-primary")}
            onClick={() => onSendNow(item.id)}
          >
            Send now
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ContextRing({ usage }: { usage: AIContextUsage | null }) {
  const percent = Math.max(0, Math.min(100, usage?.percent ?? 0));
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (circumference * percent) / 100;

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button type="button" className={cn(AI_ICON_CONTROL, "h-8 w-8")} aria-label="Context usage">
          <svg className="h-4 w-4 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
            <circle
              cx="10"
              cy="10"
              r={radius}
              fill="none"
              strokeWidth="3"
              className="stroke-border"
            />
            <circle
              cx="10"
              cy="10"
              r={radius}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className="stroke-muted-foreground transition-[stroke-dashoffset]"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" className="w-64 p-3 text-xs">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Context</span>
            <span className="font-mono">
              {usage
                ? `${usage.estimatedTokens.toLocaleString()} / ${usage.limit.toLocaleString()}`
                : "Loading..."}
            </span>
          </div>
          {usage && (
            <>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Used</span>
                <span>{usage.percent}%</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Messages</span>
                <span>{usage.messageCount}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">System</span>
                <span>{usage.systemTokens.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Tools</span>
                <span>{usage.toolsTokens.toLocaleString()}</span>
              </div>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function AIComposer({
  textareaRef,
  input,
  onInputChange,
  onKeyDown,
  onSend,
  onContinue,
  onStop,
  onSlashCommandSelect,
  slashResults,
  slashIndex,
  messages,
  context,
  conversationId,
  isStreaming,
  isConnected,
  canContinue = false,
  stopDisabled = false,
  retryAfter,
  approvalMode,
  approvalModeLabel,
  setApprovalMode,
  workMode,
  setWorkMode,
  interactionDisabled = false,
  modelOptions = [],
  selectedModel,
  onModelChange,
  reasoningOptions = [],
  selectedReasoningEffort,
  onReasoningEffortChange,
  gatewayInferenceMode = false,
  attachments = [],
  canAttachImages = false,
  uploadingAttachments = false,
  onAttachFiles,
  onRemoveAttachment,
  onPreviewAttachment,
  className,
  surfaceClassName,
  slashPaletteClassName,
  showDisclaimer = false,
}: AIComposerProps) {
  const modeMeta = AI_APPROVAL_MODE_META[approvalMode];
  const activePlan = useAIStore((state) => state.activePlan);
  const plans = useAIStore((state) => state.plans);
  const abandonPlanning = useAIStore((state) => state.abandonPlanning);
  const currentConversationPlan = activePlan?.conversationId === conversationId ? activePlan : null;
  const hasPublishedPlan =
    Boolean(currentConversationPlan?.publishedAt) ||
    plans.some(
      (plan) =>
        plan.id === currentConversationPlan?.id &&
        plan.conversationId === conversationId &&
        Boolean(plan.publishedAt)
    );
  const planModeActive =
    workMode === "plan" ||
    currentConversationPlan?.status === "drafting" ||
    currentConversationPlan?.status === "validating";
  const planningActive =
    (workMode === "plan" && isStreaming) ||
    currentConversationPlan?.status === "drafting" ||
    currentConversationPlan?.status === "validating";
  const ModeIcon = planModeActive ? ListChecks : modeMeta.icon;
  const [usage, setUsage] = useState<AIContextUsage | null>(null);
  const [updatingProvider, setUpdatingProvider] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contextUsageDialog = useAIStore((state) => state.contextUsageDialog);
  const closeContextUsageDialog = useAIStore((state) => state.closeContextUsageDialog);
  const canViewInferenceUsage = useAuthStore((state) => state.hasScope("feat:ai:use"));

  useEffect(() => {
    let active = true;
    void getAIContextUsage(
      messages,
      context,
      conversationId,
      selectedModel,
      selectedReasoningEffort
    ).then((nextUsage) => {
      if (active) setUsage(nextUsage);
    });
    return () => {
      active = false;
    };
  }, [context, conversationId, messages, selectedModel, selectedReasoningEffort]);

  const inferenceQuota = useInferenceQuota({
    enabled: gatewayInferenceMode && canViewInferenceUsage,
    isStreaming,
  });
  const disabled = !isConnected || !!retryAfter || interactionDisabled;
  const hasDraft = input.trim().length > 0 || attachments.length > 0;
  const canResume = !hasDraft && canContinue && Boolean(onContinue) && !disabled;

  const changeModel = async (model: string) => {
    if (!onModelChange || model === selectedModel || updatingProvider) return;
    if (conversationId && messages.length > 0) {
      const accepted = await confirm({
        title: "Change Model?",
        description:
          "Changing the model during a conversation may increase costs and reduce performance.",
        confirmLabel: "Change model",
        cancelLabel: "Cancel",
        cancelVariant: "ghost",
      });
      if (!accepted) return;
    }
    setUpdatingProvider(true);
    try {
      await onModelChange(model);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change model");
    } finally {
      setUpdatingProvider(false);
    }
  };

  const changeReasoningEffort = async (effort: string) => {
    if (!onReasoningEffortChange || effort === selectedReasoningEffort || updatingProvider) return;
    setUpdatingProvider(true);
    try {
      await onReasoningEffortChange(effort);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to change reasoning effort");
    } finally {
      setUpdatingProvider(false);
    }
  };

  const changeApprovalMode = async (mode: AIApprovalMode) => {
    if (planningActive) {
      const accepted = await confirm({
        title: "Leave Plan Mode?",
        description: hasPublishedPlan
          ? "Leaving Plan Mode stops the current planning run and discards only the unfinished revision. The published plan will remain available."
          : "Leaving Plan Mode stops the current planning run and deletes the unfinished plan.",
        confirmLabel: hasPublishedPlan ? "Leave Plan Mode" : "Leave and delete plan",
        cancelLabel: "Keep planning",
        variant: hasPublishedPlan ? "default" : "destructive",
      });
      if (!accepted) return;
      abandonPlanning();
    } else {
      setWorkMode("normal");
    }
    await setApprovalMode(mode);
  };

  const attachFiles = (files: FileList | File[] | null) => {
    if (!canAttachImages || !files || !onAttachFiles) return;
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (images.length + attachments.length > MAX_IMAGE_ATTACHMENTS) {
      toast.error(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images`);
      return;
    }
    if (images.length > 0) void onAttachFiles(images);
  };

  return (
    <div
      className={cn("relative", className)}
      onDragOver={(event) => {
        if (!canAttachImages) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!canAttachImages) return;
        event.preventDefault();
        attachFiles(event.dataTransfer.files);
      }}
    >
      <AIContextUsageDialog usage={contextUsageDialog} onClose={closeContextUsageDialog} />

      <AnimatePresence>
        {!inferenceQuota.exhausted && slashResults.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className={cn(
              "absolute bottom-full left-0 right-0 z-10 -mb-px border border-border bg-background shadow-md",
              slashPaletteClassName
            )}
          >
            {/* Palette rows: the textarea keeps focus and drives them with the arrow keys. */}
            {slashResults.map((command, index) => (
              <button
                key={command.name}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  index === slashIndex ? "bg-muted" : "hover:bg-muted/50"
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (isStreaming) return;
                  onSlashCommandSelect(command);
                }}
              >
                <span className="font-mono text-muted-foreground">/{command.name}</span>
                <span className="ml-auto shrink-0 text-muted-foreground/60">
                  {command.description}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <InferenceQuotaStatus quota={inferenceQuota} exhaustedClassName={surfaceClassName} />

      {!inferenceQuota.exhausted && (
        <div
          className={cn(
            "flex flex-col border border-border bg-muted/30 transition-colors",
            surfaceClassName
          )}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {attachments.map((attachment) => (
                <button
                  key={getComposerAttachmentId(attachment)}
                  type="button"
                  className={cn(AI_ATTACHMENT_TILE, "group relative")}
                  onClick={() => onPreviewAttachment?.(attachment)}
                  aria-label={`Preview ${attachment.filename}`}
                >
                  <img
                    src={getComposerAttachmentPreviewUrl(attachment)}
                    alt={attachment.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <span className="absolute inset-0 bg-background/0 transition-colors group-hover:bg-background/30" />
                  <span
                    role="button"
                    tabIndex={-1}
                    className="absolute inset-0 flex items-center justify-center bg-background/45 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveAttachment?.(getComposerAttachmentId(attachment));
                    }}
                    aria-label={`Remove ${attachment.filename}`}
                  >
                    <X className="h-7 w-7" />
                  </span>
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={(event) => attachFiles(event.clipboardData.files)}
            placeholder={
              interactionDisabled
                ? "Choose how to continue the plan above"
                : isStreaming
                  ? "Queue a message..."
                  : "Ask anything... (/ commands)"
            }
            disabled={disabled}
            rows={1}
            autoFocus
            className="block min-h-[42px] resize-none border-0 bg-transparent px-3 pb-1.5 pt-3 pr-3 text-base leading-5 focus-visible:ring-0 md:text-sm"
          />
          <div className="-mt-1 flex min-h-10 items-center gap-1 px-2 pb-2">
            <div className="min-w-0 shrink">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      AI_TOOLBAR_TRIGGER,
                      "max-w-[15rem]",
                      planModeActive
                        ? "text-link hover:text-link focus-visible:text-link"
                        : approvalMode === "bypass-everything"
                          ? "text-warning-foreground hover:text-warning-text focus-visible:text-warning-text"
                          : AI_TOOLBAR_TRIGGER_MUTED
                    )}
                    title={planModeActive ? "Plan" : approvalModeLabel}
                    aria-label={planModeActive ? "Plan" : approvalModeLabel}
                  >
                    <ModeIcon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{planModeActive ? "Plan" : modeMeta.label}</span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-60">
                  <DropdownMenuItem
                    onClick={() => {
                      if (!requireLicenseFeature("ai-plan-mode", "AI Plan Mode")) return;
                      setWorkMode("plan");
                    }}
                  >
                    <ListChecks className="h-4 w-4 text-link" />
                    <span className="text-link">Plan</span>
                    <LicensePlanBadge feature="ai-plan-mode" />
                    {planModeActive && <Check className="ml-auto h-4 w-4 text-link" />}
                  </DropdownMenuItem>
                  {AI_APPROVAL_MODES.map((mode) => {
                    const item = AI_APPROVAL_MODE_META[mode];
                    const ItemIcon = item.icon;
                    return (
                      <DropdownMenuItem key={mode} onClick={() => void changeApprovalMode(mode)}>
                        <ItemIcon className="h-4 w-4" />
                        <span>{item.menuLabel}</span>
                        {!planModeActive && approvalMode === mode && (
                          <Check className="ml-auto h-4 w-4" />
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <AIProviderControls
              modelOptions={modelOptions}
              selectedModel={selectedModel}
              onModelChange={onModelChange ? changeModel : undefined}
              reasoningOptions={reasoningOptions}
              selectedReasoningEffort={selectedReasoningEffort}
              onReasoningEffortChange={onReasoningEffortChange ? changeReasoningEffort : undefined}
              disabled={isStreaming || updatingProvider}
            />

            <div className="flex shrink-0 items-center">
              {canAttachImages && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      attachFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className={cn(AI_ICON_CONTROL, AI_CONTROL_DISABLED, "h-8 w-8")}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingAttachments || disabled}
                    aria-label="Attach images"
                    title="Attach images"
                  >
                    {uploadingAttachments ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                  </button>
                </>
              )}
              <ContextRing usage={usage} />
              <button
                type="button"
                className={cn(
                  AI_ICON_CONTROL,
                  AI_CONTROL_DISABLED,
                  "h-8 w-8",
                  canResume && "text-foreground"
                )}
                onClick={
                  isStreaming ? (hasDraft ? onSend : onStop) : canResume ? onContinue : onSend
                }
                disabled={
                  isStreaming
                    ? hasDraft
                      ? disabled
                      : stopDisabled
                    : (!hasDraft && !canResume) || disabled
                }
                aria-label={
                  isStreaming
                    ? hasDraft
                      ? "Queue message"
                      : "Stop response"
                    : canResume
                      ? "Continue response"
                      : "Send message"
                }
              >
                {isStreaming && !hasDraft ? (
                  <Square className="h-4 w-4" />
                ) : canResume ? (
                  <Play className="h-4 w-4 fill-current" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {showDisclaimer && !inferenceQuota.exhausted && <AIComposerDisclaimer />}
    </div>
  );
}

export function AIComposerDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn("pt-2 text-center text-xs text-muted-foreground", className)}>
      AI can make mistakes. Check important information.
    </p>
  );
}
