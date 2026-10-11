import { AnimatePresence, motion } from "framer-motion";
import {
  Expand,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type AIApprovalMode, formatAIApprovalModeLabel } from "@/lib/ai-approval-mode";
import { selectedModelSupportsImages } from "@/lib/ai-model-capabilities";
import { isQuestionAwaitingAnswer } from "@/lib/ai-question-state";
import {
  confirmBypassEverythingMode,
  updateAIApprovalModeOptimistically,
} from "@/lib/ai-user-preferences";
import {
  AI_PANEL_DEFAULT_WIDTH,
  AI_PANEL_MAX_WIDTH,
  AI_PANEL_MIN_WIDTH,
  getDefaultAIPanelWidth,
} from "@/lib/responsive-panels";
import { cn } from "@/lib/utils";
import { NodeSetupWizard } from "@/pages/dashboard/finalize-setup/NodeSetupWizard";
import { api } from "@/services/api";
import { getConversationBlock, useAIStore } from "@/stores/ai";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useUIStore } from "@/stores/ui";
import type {
  AIComposerAttachment,
  AIComposerLocalImageAttachment,
  AIConversationInput,
  AIMessageAttachment,
  AIToolCall,
  PageContext,
} from "@/types/ai";
import { AIComposer, AIPlanDecision, AIPlanProgress, AIQueuedMessages } from "./AIComposer";
import { AIConversationBlockedBlock } from "./AIConversationBlockedBlock";
import { AIConversationStatusIndicator } from "./AIConversationStatusIndicator";
import { AIPlanTimeline } from "./AIPlanTimeline";
import { ApprovalBlock, QuestionBlock } from "./AIToolCallBlock";
import {
  AIWorkspaceAssistantConnectorSetup,
  type AssistantConnectorSetup,
  parseAssistantConnectorSetup,
} from "./AIWorkspaceScenarioStart";
import { GitLabAuthorizationModal } from "./GitLabAuthorizationModal";
import { QuickActionChips } from "./QuickActionChips";
import {
  composerAttachmentToFile,
  filesToComposerAttachments,
  getComposerAttachmentId,
  getComposerAttachmentPreviewUrl,
  useAIComposerAttachmentsDraft,
  useAIComposerDraft,
} from "./useAIComposerDraft";
import { useAIMessageScroll } from "./useAIMessageScroll";

function autoResizeTextarea(el: HTMLTextAreaElement, maxRows = 6) {
  const style = getComputedStyle(el);
  const lineHeight = parseInt(style.lineHeight, 10) || 20;
  const paddingTop = parseInt(style.paddingTop, 10) || 0;
  const paddingBottom = parseInt(style.paddingBottom, 10) || 0;
  const borderTop = parseInt(style.borderTopWidth, 10) || 0;
  const borderBottom = parseInt(style.borderBottomWidth, 10) || 0;
  const extra = paddingTop + paddingBottom + borderTop + borderBottom;
  const minHeight = lineHeight * (el.rows || 1) + extra;
  const maxHeight = lineHeight * maxRows + extra;
  el.style.height = "auto";
  const targetHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));
  el.style.overflow = el.scrollHeight > maxHeight ? "auto" : "hidden";
  el.style.height = `${targetHeight}px`;
}

async function uploadComposerAttachments(
  attachments: AIComposerAttachment[],
  conversationId: string | null
): Promise<AIMessageAttachment[]> {
  const uploaded: AIMessageAttachment[] = [];
  for (const attachment of attachments) {
    if ("artifactId" in attachment) {
      uploaded.push(attachment);
      continue;
    }
    uploaded.push(await uploadLocalComposerAttachment(attachment, conversationId));
  }
  return uploaded;
}

async function uploadLocalComposerAttachment(
  attachment: AIComposerLocalImageAttachment,
  conversationId: string | null
): Promise<AIMessageAttachment> {
  const file = await composerAttachmentToFile(attachment);
  return api.uploadAIChatArtifact(file, conversationId);
}

const PANEL_WIDTH_KEY = "gateway-ai-panel-width";
const NORMAL_RECENT_CONVERSATION_LIMIT = 5;

function readPanelWidth(): number {
  try {
    const stored = localStorage.getItem(PANEL_WIDTH_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (parsed >= AI_PANEL_MIN_WIDTH && parsed <= AI_PANEL_MAX_WIDTH) return parsed;
    }
  } catch {
    /* ignore */
  }
  return typeof window === "undefined"
    ? AI_PANEL_DEFAULT_WIDTH
    : getDefaultAIPanelWidth(window.innerWidth);
}

function usePageContext(): PageContext {
  const location = useLocation();
  const params = useParams();
  const resolvedStatus = useResolvedPageContext((s) => s.status);
  const resolvedRouteKey = useResolvedPageContext((s) => s.routeKey);
  const resolvedResource = useResolvedPageContext((s) => s.resource);
  const route = location.pathname;
  const ownsRoute =
    resolvedStatus === "ready" &&
    resolvedRouteKey &&
    (route === resolvedRouteKey || route.startsWith(`${resolvedRouteKey}/`));

  return useMemo(() => {
    if (ownsRoute && resolvedResource) {
      return {
        route,
        resourceType: resolvedResource.resourceType,
        resourceId: resolvedResource.resourceId,
        label: resolvedResource.label,
        nodeId: resolvedResource.nodeId,
      };
    }

    if (params.id && route.startsWith("/cas/")) {
      return { route, resourceType: "ca", resourceId: params.id };
    }
    if (params.id && route.startsWith("/certificates/")) {
      return { route, resourceType: "certificate", resourceId: params.id };
    }

    return { route };
  }, [ownsRoute, params.id, resolvedResource, route]);
}

const SLASH_COMMANDS = [
  { name: "new", description: "Start new Work Session" },
  { name: "clear", description: "Clear Work Session" },
  { name: "compact", description: "Compact older context" },
  { name: "context", description: "Show token usage" },
];

interface AIChatSurfaceProps {
  active?: boolean;
  onClose?: () => void;
  onEnterLiteMode?: () => void;
}

export function AIChatSurface({ active = true, onClose, onEnterLiteMode }: AIChatSurfaceProps) {
  const {
    messages,
    resourceReferences,
    isStreaming,
    isStartingConversation,
    isConnected,
    isConnecting,
    connectionError,
    recentConversations,
    retryAfter,
    savedName,
    activeConversationId,
    activeRunId,
    pendingSetupInteraction,
    activePlan,
    plans,
    dismissedPlanDecisionKey,
    devPlanProgressPreview,
    workMode,
    canContinueConversation,
    isCompactingContext,
    queuedInputs,
    sendMessage,
    queueMessage,
    steerQueuedMessage,
    cancelQueuedMessage,
    continueConversation,
    approveTool,
    rejectTool,
    answerQuestion,
    resolveSetupInteraction,
    stopStreaming,
    setWorkMode,
    decidePlan,
    pausePlan,
    resumePlan,
    cancelPlan,
    clearMessages,
    handleSlashCommand,
    loadConversation,
    deleteConversation,
    renameConversation,
    rollbackToMessage,
    retryMessage,
    providerStatus,
    selectedModel,
    selectedReasoningEffort,
    setSelectedModel,
    setSelectedReasoningEffort,
    refreshProviderStatus,
    fetchRecentConversations,
  } = useAIStore();
  // The empty state is centred, so a recent list arriving late would push it
  // up. Without a cached list it waits for the first fetch, then fades in.
  const [recentConversationsCached] = useState(
    () => useAIStore.getState().recentConversations.length > 0
  );
  const [recentConversationsSettled, setRecentConversationsSettled] =
    useState(recentConversationsCached);
  const emptyStateWaitsForRecent = !recentConversationsSettled && recentConversations.length === 0;
  const assistantConnectorSetup = useMemo(
    () =>
      pendingSetupInteraction?.kind === "connector_setup"
        ? parseAssistantConnectorSetup(pendingSetupInteraction.payload)
        : null,
    [pendingSetupInteraction]
  );
  const assistantNodeEnrollmentOpen = pendingSetupInteraction?.kind === "node_enrollment";
  const currentConversationPlan =
    activePlan?.conversationId === activeConversationId ? activePlan : null;
  const showPlanDecision =
    currentConversationPlan?.status === "awaiting_decision" &&
    `${activeConversationId}:${currentConversationPlan.revisionId}` !== dismissedPlanDecisionKey;
  const progressPlan = devPlanProgressPreview ?? currentConversationPlan;

  const [input, setInput] = useAIComposerDraft(activeConversationId);
  const [attachments, setAttachments] = useAIComposerAttachmentsDraft(activeConversationId);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [slashResults, setSlashResults] = useState<typeof SLASH_COMMANDS>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [excludedResourceContextKey, setExcludedResourceContextKey] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const context = usePageContext();
  const resourceContextKey = `${context.route}\u0000${context.resourceId ?? ""}`;
  const excludeResourceContextOnce = excludedResourceContextKey === resourceContextKey;
  const requestContext = excludeResourceContextOnce ? { route: context.route } : context;
  const {
    aiApprovalMode: approvalMode,
    pinnedAIConversationIds,
    togglePinnedAIConversation,
  } = useUIStore();
  const approvalModeLabel = formatAIApprovalModeLabel(approvalMode);
  const conversationBlock = getConversationBlock(messages);
  const isNewConversationDraft = activeConversationId === null || messages.length === 0;
  const currentConversationStreaming =
    isStartingConversation || (!isNewConversationDraft && isStreaming);
  const currentConversation = activeConversationId
    ? recentConversations.find((conversation) => conversation.id === activeConversationId)
    : null;
  const currentChatTitle = isStartingConversation
    ? "Starting Work Session..."
    : activeConversationId
      ? (savedName ?? currentConversation?.title ?? "New Work Session")
      : "New Work Session";
  const isCurrentChatPinned = activeConversationId
    ? pinnedAIConversationIds.includes(activeConversationId)
    : false;
  const selectedProviderModel = providerStatus?.models.find((model) => model.id === selectedModel);
  const canAttachImages = selectedModelSupportsImages(providerStatus, selectedModel);
  const normalRecentConversations = recentConversations.slice(0, NORMAL_RECENT_CONVERSATION_LIMIT);

  const openRenameDialog = () => {
    if (!activeConversationId) return;
    setRenameDraft(currentChatTitle);
    setRenameDialogOpen(true);
  };

  const submitRename = async () => {
    if (!activeConversationId) return;
    const nextTitle = renameDraft.trim();
    if (!nextTitle) return;
    setIsRenaming(true);
    try {
      await renameConversation(activeConversationId, nextTitle);
      setRenameDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename Work Session");
    } finally {
      setIsRenaming(false);
    }
  };

  const setApprovalMode = useCallback(
    async (mode: AIApprovalMode) => {
      if (
        mode === "bypass-everything" &&
        approvalMode !== "bypass-everything" &&
        !(await confirmBypassEverythingMode())
      ) {
        return;
      }
      try {
        await updateAIApprovalModeOptimistically(mode, approvalMode);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update AI mode");
      }
    },
    [approvalMode]
  );

  const continueAfterConnectorSetup = useCallback(
    (_setup: AssistantConnectorSetup, status: "configured" | "cancelled") => {
      resolveSetupInteraction(status);
    },
    [resolveSetupInteraction]
  );

  const continueAfterNodeEnrollment = useCallback(
    async (status: "configured" | "cancelled") => {
      resolveSetupInteraction(status);
    },
    [resolveSetupInteraction]
  );

  useEffect(() => {
    if (!active) return;
    void refreshProviderStatus().catch(() => undefined);
  }, [active, refreshProviderStatus]);

  useEffect(() => {
    if (!active || !isNewConversationDraft) return;
    void Promise.resolve(fetchRecentConversations())
      .catch(() => undefined)
      .finally(() => setRecentConversationsSettled(true));
  }, [active, fetchRecentConversations, isNewConversationDraft]);

  useEffect(() => {
    if (providerStatus && !canAttachImages && attachments.length > 0) setAttachments([]);
  }, [attachments.length, canAttachImages, providerStatus, setAttachments]);

  const scrollSignature = messages
    .map((message) =>
      [
        message.id,
        message.content.length,
        message.isStreaming ? "streaming" : "idle",
        (message.toolCalls ?? [])
          .map((toolCall) => `${toolCall.id}:${toolCall.status}:${toolCall.error ?? ""}`)
          .join(","),
      ].join(":")
    )
    .join("|");

  const {
    viewportRef: scrollViewportRef,
    onScroll,
    pinToBottom,
  } = useAIMessageScroll(scrollSignature, activeConversationId ?? "__new__");

  useEffect(() => {
    if (!isNewConversationDraft) return;
    const timer = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isNewConversationDraft]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: input changes must re-measure restored composer drafts.
  useLayoutEffect(() => {
    if (textareaRef.current) autoResizeTextarea(textareaRef.current);
  }, [input]);

  const previewAttachment = useCallback((attachment: AIComposerAttachment) => {
    if ("artifactId" in attachment) {
      const params = new URLSearchParams({ filename: attachment.filename });
      params.set("mediaType", attachment.mediaType);
      window.open(
        `/ai/artifact/${encodeURIComponent(attachment.artifactId)}?${params.toString()}`,
        `artifact-${attachment.artifactId}`,
        "width=900,height=600,menubar=no,toolbar=no"
      );
      return;
    }
    window.open(getComposerAttachmentPreviewUrl(attachment), "_blank", "noopener,noreferrer");
  }, []);

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (!canAttachImages || files.length === 0) return;
      try {
        const nextAttachments = await filesToComposerAttachments(files);
        setAttachments([...attachments, ...nextAttachments]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to attach image");
      }
    },
    [attachments, canAttachImages, setAttachments]
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    if (!currentConversationStreaming && attachments.length === 0 && text.startsWith("/")) {
      const handled = await handleSlashCommand(text);
      if (handled) {
        setInput("");
        setAttachments([]);
        setSlashResults([]);
        return;
      }
    }

    setUploadingAttachments(true);
    try {
      const uploadedAttachments = await uploadComposerAttachments(
        attachments,
        activeConversationId
      );
      setInput("");
      setAttachments([]);
      setSlashResults([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      if (currentConversationStreaming) {
        pinToBottom();
        queueMessage(text, requestContext, uploadedAttachments);
      } else {
        pinToBottom();
        sendMessage(text, requestContext, uploadedAttachments, {
          startNewConversation: isNewConversationDraft,
        });
      }
      setExcludedResourceContextKey(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to attach image");
    } finally {
      setUploadingAttachments(false);
    }
  }, [
    activeConversationId,
    attachments,
    requestContext,
    currentConversationStreaming,
    handleSlashCommand,
    input,
    isNewConversationDraft,
    pinToBottom,
    queueMessage,
    sendMessage,
    setAttachments,
    setInput,
  ]);

  const handleEditQueued = useCallback(
    (item: AIConversationInput) => {
      cancelQueuedMessage(item.id);
      setInput(item.content);
      setAttachments(item.attachments);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        autoResizeTextarea(textarea);
      });
    },
    [cancelQueuedMessage, setAttachments, setInput]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Slash command navigation
    if (slashResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashResults.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashResults.length) % slashResults.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (currentConversationStreaming) return;
        const cmd = slashResults[slashIndex];
        handleSlashCommand(`/${cmd.name}`);
        setInput("");
        setSlashResults([]);
        return;
      }
      if (e.key === "Escape") {
        setSlashResults([]);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleQuickAction = (prompt: string) => {
    sendMessage(prompt, context, [], { startNewConversation: messages.length === 0 });
  };

  const handleEditUserMessage = useCallback(
    async (messageId: string, content: string, nextAttachments: AIMessageAttachment[]) => {
      try {
        if (isCompactingContext) return;
        const ok = await confirm({
          title: "Return to Message?",
          description:
            currentConversationStreaming || activeRunId
              ? "All history after this message will be deleted. Returning now will also cancel the current task."
              : "All history after this message will be deleted.",
          confirmLabel: "Return",
          cancelLabel: "Cancel",
          cancelVariant: "ghost",
          variant: "destructive",
        });
        if (!ok) return;
        const message = await rollbackToMessage(messageId);
        if (!message) return;
        setInput(content);
        setAttachments(nextAttachments);
        setSlashResults([]);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.focus();
          autoResizeTextarea(textarea);
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to edit message");
      }
    },
    [
      activeRunId,
      currentConversationStreaming,
      isCompactingContext,
      rollbackToMessage,
      setAttachments,
      setInput,
    ]
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    autoResizeTextarea(e.target);

    // Slash command detection
    if (val.startsWith("/") && !val.includes(" ")) {
      const query = val.slice(1).toLowerCase();
      const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
      setSlashResults(matches);
      setSlashIndex(0);
    } else {
      setSlashResults([]);
    }
  };

  // Find next unanswered question and count progress
  const { activeQuestion, questionIndex, questionsTotal } = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.toolCalls) {
        const allQuestions = msg.toolCalls.filter((tc) => tc.name === "ask_question");
        if (allQuestions.length === 0) continue;
        const nextUnanswered = allQuestions.find(isQuestionAwaitingAnswer);
        if (nextUnanswered) {
          const answeredCount = allQuestions.filter(
            (tc) => tc.status === "completed" || tc.status === "failed" || tc.status === "rejected"
          ).length;
          return {
            activeQuestion: nextUnanswered,
            questionIndex: answeredCount + 1,
            questionsTotal: allQuestions.length,
          };
        }
      }
    }
    return { activeQuestion: null, questionIndex: 0, questionsTotal: 0 };
  })();

  const activeApproval = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !msg.toolCalls) continue;
      const pendingApproval = msg.toolCalls.find(
        (tc): tc is AIToolCall =>
          tc.name !== "ask_question" &&
          (tc.status === "awaiting_approval" || tc.approvalDecisionPending === true)
      );
      if (pendingApproval) return pendingApproval;
    }
    return null;
  })();
  const activeQuestionArgs =
    activeQuestion?.arguments && typeof activeQuestion.arguments === "object"
      ? activeQuestion.arguments
      : {};
  const isCompactionRetryQuestion = activeQuestionArgs._compactionRetry === true;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-[49px] shrink-0 items-center justify-between border-b border-border px-3">
        <span
          className={`min-w-0 flex-1 truncate pr-2 text-sm font-semibold ${isStartingConversation ? "thinking-shimmer text-muted-foreground" : ""}`}
          title={currentChatTitle}
        >
          {currentChatTitle}
        </span>
        <div className="flex items-center gap-1">
          {onEnterLiteMode && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onEnterLiteMode}
              title="Open in AI Workspace"
              aria-label="Open in AI Workspace"
            >
              <Expand className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={clearMessages}
            disabled={!activeConversationId && messages.length === 0}
            title="New Work Session"
            aria-label="New Work Session"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                title="Work Session actions"
                aria-label="Work Session actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                disabled={!activeConversationId}
                onClick={() =>
                  activeConversationId && togglePinnedAIConversation(activeConversationId)
                }
              >
                {isCurrentChatPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                {isCurrentChatPinned ? "Unpin Work Session" : "Pin Work Session"}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!activeConversationId} onClick={openRenameDialog}>
                <Pencil className="h-4 w-4" />
                Rename Work Session
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                disabled={!activeConversationId}
                onClick={() =>
                  activeConversationId && void deleteConversation(activeConversationId)
                }
              >
                <Trash2 className="h-4 w-4" />
                Delete Work Session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1"
              onClick={onClose}
              title="Close AI Workspace"
              aria-label="Close AI Workspace"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Work Session</DialogTitle>
          </DialogHeader>
          <Input
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename();
              }
            }}
            placeholder="Work Session name"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDialogOpen(false)}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitRename()}
              pending={isRenaming}
              disabled={!renameDraft.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Messages */}
      {messages.length === 0 ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-3",
            emptyStateWaitsForRecent
              ? "invisible"
              : !recentConversationsCached && "ai-chat-content-fade-in"
          )}
          aria-busy={emptyStateWaitsForRecent || undefined}
        >
          <Sparkles className="h-8 w-8 text-muted-foreground" />
          <p className="max-w-sm text-center text-sm text-foreground/70">
            Ask questions, investigate issues, and manage your infrastructure with permission-aware
            guidance.
          </p>
          <QuickActionChips onSelect={handleQuickAction} context={context} />
          {recentConversations.length > 0 && (
            <div className="mt-4 w-full max-w-[340px] border border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Recent
              </div>
              {normalRecentConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className="group flex items-center border-b border-border last:border-b-0 hover:bg-muted/50 focus-within:bg-muted/50"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
                    onClick={() => void loadConversation(conversation.id)}
                  >
                    <AIConversationStatusIndicator conversation={conversation} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground">
                        {conversation.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {conversation.messageCount} messages
                      </span>
                    </span>
                    <RelativeTime
                      value={conversation.lastUserMessageAt ?? conversation.createdAt}
                      className="shrink-0 text-xs text-muted-foreground"
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${conversation.title}`}
                    className="mr-0 flex h-6 w-0 shrink-0 translate-x-1 items-center justify-center overflow-hidden text-muted-foreground opacity-0 transition-[width,margin,opacity,transform,color] duration-150 hover:text-destructive group-hover:mr-2 group-hover:w-6 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:mr-2 group-focus-within:w-6 group-focus-within:translate-x-0 group-focus-within:opacity-100"
                    onClick={() => void deleteConversation(conversation.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollViewportRef}
            role="log"
            aria-label="AI messages"
            className="h-full overflow-y-auto dashboard-scrollbar px-3 pt-3"
            onScroll={onScroll}
          >
            <div className="space-y-3">
              <AIPlanTimeline
                messages={messages}
                plans={plans}
                resourceReferences={resourceReferences}
                isStreaming={currentConversationStreaming}
                onApprove={approveTool}
                onReject={rejectTool}
                onAnswer={answerQuestion}
                onEditUserMessage={handleEditUserMessage}
                onRetryUserMessage={(messageId) => void retryMessage(messageId)}
                retryDisabled={currentConversationStreaming || isCompactingContext}
                editUserMessageDisabled={isCompactingContext || isCompactionRetryQuestion}
              />
              <div className="pb-4" />
            </div>
          </div>
        </div>
      )}

      {/* Rate limit indicator */}
      {retryAfter !== null && (
        <div className="text-xs text-muted-foreground text-center py-1.5 border-t border-border">
          Rate limited — retrying in {retryAfter}s...
        </div>
      )}

      {/* Connection status */}
      {!isConnected && (isConnecting || connectionError) && (
        <div className="text-xs text-muted-foreground text-center py-1.5 border-t border-border">
          {isConnecting ? "Connecting..." : connectionError}
        </div>
      )}

      {/* Bottom area: question UI or input */}
      <div className="shrink-0">
        {activeQuestion ? (
          <div className="border-t border-border">
            {questionsTotal > 1 && (
              <div className="border-b border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
                Question {questionIndex} of {questionsTotal}
              </div>
            )}
            <QuestionBlock toolCall={activeQuestion} onAnswer={answerQuestion} />
          </div>
        ) : showPlanDecision ? (
          <div className="border-t border-border">
            <AIPlanDecision
              onImplement={() => decidePlan("implement")}
              onRefine={() => decidePlan("refine")}
              onCustom={(instruction) => decidePlan("custom", instruction)}
            />
          </div>
        ) : activeApproval ? (
          <ApprovalBlock toolCall={activeApproval} onApprove={approveTool} onReject={rejectTool} />
        ) : conversationBlock ? (
          <AIConversationBlockedBlock block={conversationBlock} onNewChat={clearMessages} />
        ) : (
          <div className="relative">
            {progressPlan &&
              (progressPlan.status === "executing" ||
                progressPlan.status === "pause_requested" ||
                progressPlan.status === "paused" ||
                progressPlan.status === "verifying") && (
                <AIPlanProgress
                  plan={progressPlan}
                  onPause={pausePlan}
                  onResume={resumePlan}
                  onCancel={cancelPlan}
                  className="border-x-0 border-b-0"
                />
              )}
            {context.resourceId && !excludeResourceContextOnce && (
              <div className="flex w-full items-center justify-between gap-2 border border-x-0 border-b-0 border-border bg-muted/40 px-2.5 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  Viewing {context.label ?? context.resourceType ?? "current resource"}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setExcludedResourceContextKey(resourceContextKey)}
                  title="Exclude this resource from the next request"
                  aria-label="Exclude this resource from the next request"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
            <AIQueuedMessages
              items={queuedInputs}
              onSendNow={steerQueuedMessage}
              onEdit={handleEditQueued}
              onRemove={cancelQueuedMessage}
              className="border-x-0 border-b-0"
            />
            <AIComposer
              textareaRef={textareaRef}
              input={input}
              onInputChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onSend={() => void handleSend()}
              onContinue={() => continueConversation(requestContext)}
              onStop={stopStreaming}
              onSlashCommandSelect={(command) => {
                void handleSlashCommand(`/${command.name}`);
                setInput("");
                setAttachments([]);
                setSlashResults([]);
              }}
              slashResults={slashResults}
              slashIndex={slashIndex}
              messages={messages}
              context={requestContext}
              conversationId={activeConversationId}
              isStreaming={currentConversationStreaming}
              canContinue={canContinueConversation}
              stopDisabled={isCompactingContext || isStartingConversation}
              isConnected={isConnected}
              retryAfter={retryAfter}
              approvalMode={approvalMode}
              approvalModeLabel={approvalModeLabel}
              setApprovalMode={setApprovalMode}
              workMode={workMode}
              setWorkMode={setWorkMode}
              modelOptions={
                providerStatus?.allowUserModelSelection ? providerStatus.models : undefined
              }
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              reasoningOptions={
                providerStatus?.providerType === "openai_compatible"
                  ? providerStatus.allowUserReasoningEffortSelection
                    ? (providerStatus.reasoningEfforts ?? [])
                    : undefined
                  : selectedProviderModel?.reasoningEfforts
              }
              selectedReasoningEffort={selectedReasoningEffort}
              onReasoningEffortChange={setSelectedReasoningEffort}
              gatewayInferenceMode={providerStatus?.providerType === "gateway_inference"}
              attachments={attachments}
              canAttachImages={canAttachImages}
              uploadingAttachments={uploadingAttachments}
              onAttachFiles={handleAttachFiles}
              onRemoveAttachment={(artifactId) =>
                setAttachments(
                  attachments.filter(
                    (attachment) => getComposerAttachmentId(attachment) !== artifactId
                  )
                )
              }
              onPreviewAttachment={previewAttachment}
              surfaceClassName="border-x-0 border-b-0 focus-within:ring-0"
              slashPaletteClassName="border-x-0"
            />
          </div>
        )}
      </div>
      <GitLabAuthorizationModal />
      <AIWorkspaceAssistantConnectorSetup
        setup={assistantConnectorSetup}
        onFinished={continueAfterConnectorSetup}
      />
      <NodeSetupWizard
        open={assistantNodeEnrollmentOpen}
        onBack={() => void continueAfterNodeEnrollment("cancelled")}
        onConfigured={() => continueAfterNodeEnrollment("configured")}
        onSkipped={() => continueAfterNodeEnrollment("cancelled")}
        completionActionLabel="Continue scenario"
      />
    </div>
  );
}

interface AISidePanelProps {
  isMobile?: boolean;
}

export function AISidePanel({ isMobile = false }: AISidePanelProps) {
  const { aiPanelOpen, setAIPanelOpen } = useUIStore();
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const [isResizing, setIsResizing] = useState(false);

  const handleClose = () => setAIPanelOpen(false);
  const handleEnterLiteMode = () => {
    window.dispatchEvent(new CustomEvent("gateway:open-ai-workspace"));
  };

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    setPanelWidth((w) => {
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(w));
      } catch {
        /* ignore */
      }
      return w;
    });
  }, []);

  useEffect(() => {
    const updateResponsiveDefault = () => {
      if (localStorage.getItem(PANEL_WIDTH_KEY)) return;
      setPanelWidth(getDefaultAIPanelWidth(window.innerWidth));
    };

    window.addEventListener("resize", updateResponsiveDefault);
    return () => window.removeEventListener("resize", updateResponsiveDefault);
  }, []);

  if (isMobile) {
    return (
      <Sheet open={aiPanelOpen} onOpenChange={setAIPanelOpen}>
        <SheetContent side="right" className="w-full p-0" hideCloseButton>
          <SheetHeader className="sr-only">
            <SheetTitle>AI Workspace</SheetTitle>
          </SheetHeader>
          <AIChatSurface active={aiPanelOpen} onClose={handleClose} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {aiPanelOpen && (
        <motion.div
          key="ai-panel"
          initial={{ width: 0 }}
          animate={{ width: panelWidth }}
          exit={{ width: 0 }}
          transition={isResizing ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
          className="relative h-full min-w-0 shrink-0 overflow-visible"
        >
          <ResizeHandle
            side="right"
            onResize={setPanelWidth}
            onResizeStart={() => setIsResizing(true)}
            onResizeEnd={handleResizeEnd}
            minWidth={AI_PANEL_MIN_WIDTH}
            maxWidth={AI_PANEL_MAX_WIDTH}
          />
          <div className="h-full overflow-hidden border-l border-border">
            {/* Inner content pinned to panelWidth so it never reflows */}
            <div style={{ width: panelWidth }} className="h-full flex flex-col bg-background">
              <AIChatSurface onClose={handleClose} onEnterLiteMode={handleEnterLiteMode} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
