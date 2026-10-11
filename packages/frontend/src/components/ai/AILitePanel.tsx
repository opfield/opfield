import { Menu, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { InitialPageReadyContext, useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type AIApprovalMode, formatAIApprovalModeLabel } from "@/lib/ai-approval-mode";
import { aiConversationRoute } from "@/lib/ai-conversation-route";
import { selectedModelSupportsImages } from "@/lib/ai-model-capabilities";
import { isQuestionAwaitingAnswer } from "@/lib/ai-question-state";
import {
  confirmBypassEverythingMode,
  updateAIApprovalModeOptimistically,
} from "@/lib/ai-user-preferences";
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
import {
  AIComposer,
  AIComposerDisclaimer,
  AIPlanDecision,
  AIPlanProgress,
  AIQueuedMessages,
} from "./AIComposer";
import { AIConversationBlockedBlock } from "./AIConversationBlockedBlock";
import { AIPlanTimeline } from "./AIPlanTimeline";
import { ApprovalBlock, QuestionBlock } from "./AIToolCallBlock";
import {
  AIWorkspaceAssistantConnectorSetup,
  AIWorkspaceScenarioStart,
  type AssistantConnectorSetup,
  parseAssistantConnectorSetup,
} from "./AIWorkspaceScenarioStart";
import { GitLabAuthorizationModal } from "./GitLabAuthorizationModal";
import {
  composerAttachmentToFile,
  filesToComposerAttachments,
  getComposerAttachmentId,
  getComposerAttachmentPreviewUrl,
  useAIComposerAttachmentsDraft,
  useAIComposerDraft,
} from "./useAIComposerDraft";
import { useAIMessageScroll } from "./useAIMessageScroll";

const SLASH_COMMANDS = [
  { name: "new", description: "Start new Work Session" },
  { name: "clear", description: "Clear Work Session" },
  { name: "compact", description: "Compact older context" },
  { name: "context", description: "Show token usage" },
];

function autoResizeTextarea(el: HTMLTextAreaElement, maxRows = 8) {
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

export function AILitePanel({ onOpenMobileMenu }: { onOpenMobileMenu?: () => void }) {
  const {
    messages,
    resourceReferences,
    isStreaming,
    isStartingConversation,
    isConnected,
    isConnecting,
    connectionError,
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
    recentConversations,
    sendMessage,
    startScenario,
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
    deleteConversation,
    loadConversation,
    renameConversation,
    rollbackToMessage,
    retryMessage,
    providerStatus,
    selectedModel,
    selectedReasoningEffort,
    setSelectedModel,
    setSelectedReasoningEffort,
    refreshProviderStatus,
  } = useAIStore();
  const currentConversationPlan =
    activePlan?.conversationId === activeConversationId ? activePlan : null;
  const showPlanDecision =
    currentConversationPlan?.status === "awaiting_decision" &&
    `${activeConversationId}:${currentConversationPlan.revisionId}` !== dismissedPlanDecisionKey;
  const progressPlan = devPlanProgressPreview ?? currentConversationPlan;
  const {
    aiApprovalMode: approvalMode,
    pinnedAIConversationIds,
    togglePinnedAIConversation,
  } = useUIStore();

  const navigate = useNavigate();
  const { conversationId: routeConversationId } = useParams<{ conversationId?: string }>();
  const draftConversationId = activeConversationId ?? routeConversationId ?? null;
  const [input, setInput] = useAIComposerDraft(draftConversationId);
  const [attachments, setAttachments] = useAIComposerAttachmentsDraft(draftConversationId);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [slashResults, setSlashResults] = useState<typeof SLASH_COMMANDS>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const assistantConnectorSetup = useMemo(
    () =>
      pendingSetupInteraction?.kind === "connector_setup"
        ? parseAssistantConnectorSetup(pendingSetupInteraction.payload)
        : null,
    [pendingSetupInteraction]
  );
  const assistantNodeEnrollmentOpen = pendingSetupInteraction?.kind === "node_enrollment";
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const context = usePageContext();
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

  // A conversation opened by its link, and the provider controls in the
  // composer, are part of the first render: the page reveals once both are in.
  // Later conversation switches and provider refreshes update in place.
  const [routeConversationLoading, setRouteConversationLoading] = useState(
    () =>
      Boolean(routeConversationId) &&
      routeConversationId !== useAIStore.getState().activeConversationId
  );
  const [providerStatusLoading, setProviderStatusLoading] = useState(
    () => useAIStore.getState().providerStatus === null
  );
  useContentLoading(routeConversationLoading || providerStatusLoading);

  useEffect(() => {
    if (
      !routeConversationId ||
      routeConversationId === useAIStore.getState().activeConversationId
    ) {
      return;
    }
    void Promise.resolve(loadConversation(routeConversationId)).finally(() =>
      setRouteConversationLoading(false)
    );
  }, [loadConversation, routeConversationId]);

  useEffect(() => {
    const previousActiveConversationId = previousActiveConversationIdRef.current;
    previousActiveConversationIdRef.current = activeConversationId;
    if (!activeConversationId || activeConversationId === routeConversationId) return;
    if (!routeConversationId && previousActiveConversationId !== null) return;
    navigate(aiConversationRoute(activeConversationId), { replace: routeConversationId == null });
  }, [activeConversationId, navigate, routeConversationId]);

  const handleNewChat = useCallback(() => {
    navigate("/", { flushSync: true });
    clearMessages();
  }, [clearMessages, navigate]);

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

  const handleDeleteCurrentConversation = async () => {
    if (!activeConversationId) return;
    await deleteConversation(activeConversationId);
    navigate("/");
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

  useEffect(() => {
    void Promise.resolve(refreshProviderStatus())
      .catch(() => undefined)
      .finally(() => setProviderStatusLoading(false));
  }, [refreshProviderStatus]);

  useEffect(() => {
    if (providerStatus && !canAttachImages && attachments.length > 0) setAttachments([]);
  }, [attachments.length, canAttachImages, providerStatus, setAttachments]);

  // Hidden content cannot take focus, so the composer is focused once the page reveals.
  const pageRevealed = useContext(InitialPageReadyContext);
  useEffect(() => {
    if (!isNewConversationDraft || !pageRevealed) return;
    const timer = setTimeout(() => textareaRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isNewConversationDraft, pageRevealed]);

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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    if (!currentConversationStreaming && attachments.length === 0 && text.startsWith("/")) {
      const handled = await handleSlashCommand(text);
      if (handled) {
        if (text === "/new") navigate("/");
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
        queueMessage(text, context, uploadedAttachments);
      } else {
        pinToBottom();
        sendMessage(text, context, uploadedAttachments, {
          startNewConversation: isNewConversationDraft,
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to attach image");
    } finally {
      setUploadingAttachments(false);
    }
  }, [
    activeConversationId,
    attachments,
    context,
    currentConversationStreaming,
    handleSlashCommand,
    input,
    isNewConversationDraft,
    navigate,
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
        void handleSlashCommand(`/${cmd.name}`);
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

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    autoResizeTextarea(e.target);

    if (val.startsWith("/") && !val.includes(" ")) {
      const query = val.slice(1).toLowerCase();
      setSlashResults(SLASH_COMMANDS.filter((command) => command.name.startsWith(query)));
      setSlashIndex(0);
    } else {
      setSlashResults([]);
    }
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

  const handleQuickAction = (prompt: string) => {
    sendMessage(prompt, context, [], { startNewConversation: messages.length === 0 });
  };

  const { activeQuestion, questionIndex, questionsTotal } = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.toolCalls) {
        const allQuestions = msg.toolCalls.filter((tc) => tc.name === "ask_question");
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
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-[49px] shrink-0 items-center justify-between border-b border-border px-4">
        {onOpenMobileMenu && (
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 mr-2"
            onClick={onOpenMobileMenu}
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
        <span
          className={`min-w-0 flex-1 truncate pr-2 text-sm font-semibold ${isStartingConversation ? "thinking-shimmer text-muted-foreground" : ""}`}
          title={currentChatTitle}
        >
          {currentChatTitle}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => activeConversationId && togglePinnedAIConversation(activeConversationId)}
            disabled={!activeConversationId}
            title={isCurrentChatPinned ? "Unpin Work Session" : "Pin Work Session"}
            aria-label={isCurrentChatPinned ? "Unpin Work Session" : "Pin Work Session"}
          >
            {isCurrentChatPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={openRenameDialog}
            disabled={!activeConversationId}
            title="Rename Work Session"
            aria-label="Rename Work Session"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void handleDeleteCurrentConversation()}
            disabled={!activeConversationId}
            title="Delete Work Session"
            aria-label="Delete Work Session"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
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

      {messages.length === 0 ? (
        <AIWorkspaceScenarioStart
          context={context}
          disabled={currentConversationStreaming}
          onStart={(scenario) => startScenario(scenario, context)}
          onInvestigateOperationalIssue={() =>
            handleQuickAction(
              "Investigate the current Gateway relay issue, identify impact and evidence, then propose the safest recovery plan."
            )
          }
        />
      ) : (
        <div className="ai-chat-content-fade-in relative min-h-0 flex-1">
          <div
            ref={scrollViewportRef}
            role="log"
            aria-label="AI messages"
            className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges] dashboard-scrollbar pt-4"
            onScroll={onScroll}
          >
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-8">
              <AIPlanTimeline
                messages={messages}
                plans={plans}
                resourceReferences={resourceReferences}
                isStreaming={currentConversationStreaming}
                assistantMaxWidthClass="max-w-[90%]"
                onApprove={approveTool}
                onReject={rejectTool}
                onAnswer={answerQuestion}
                onEditUserMessage={handleEditUserMessage}
                onRetryUserMessage={(messageId) => void retryMessage(messageId)}
                retryDisabled={currentConversationStreaming || isCompactingContext}
                editUserMessageDisabled={isCompactingContext || isCompactionRetryQuestion}
              />
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-background/50 to-transparent" />
        </div>
      )}

      {retryAfter !== null && (
        <div className="text-center text-xs text-muted-foreground">
          Rate limited — retrying in {retryAfter}s...
        </div>
      )}
      {!isConnected && (isConnecting || connectionError) && (
        <div className="text-center text-xs text-muted-foreground">
          {isConnecting ? "Connecting..." : connectionError}
        </div>
      )}

      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
        {activeQuestion ? (
          <div className="border border-border bg-background">
            {questionsTotal > 1 && (
              <div className="border-b border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
                Question {questionIndex} of {questionsTotal}
              </div>
            )}
            <QuestionBlock toolCall={activeQuestion} onAnswer={answerQuestion} />
          </div>
        ) : showPlanDecision ? (
          <div className="border border-border bg-background">
            <AIPlanDecision
              onImplement={() => decidePlan("implement")}
              onRefine={() => decidePlan("refine")}
              onCustom={(instruction) => decidePlan("custom", instruction)}
            />
          </div>
        ) : activeApproval ? (
          <ApprovalBlock toolCall={activeApproval} onApprove={approveTool} onReject={rejectTool} />
        ) : conversationBlock ? (
          <div className="border border-border bg-background">
            <AIConversationBlockedBlock
              block={conversationBlock}
              onNewChat={handleNewChat}
              showTopBorder={false}
            />
          </div>
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
                  className="border-b-0"
                />
              )}
            <AIQueuedMessages
              items={queuedInputs}
              onSendNow={steerQueuedMessage}
              onEdit={handleEditQueued}
              onRemove={cancelQueuedMessage}
              className="border-b-0"
            />
            <AIComposer
              textareaRef={textareaRef}
              input={input}
              onInputChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onSend={() => void handleSend()}
              onContinue={() => continueConversation(context)}
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
              context={context}
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
            />
          </div>
        )}
        <AIComposerDisclaimer />
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
