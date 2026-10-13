import { create } from "zustand";
import { toastApiError } from "@/lib/api-error-toast";
import {
  createConversationFolder,
  deleteConversation,
  deleteConversationFolder,
  getConversation,
  listConversationFolders,
  listConversations,
  moveConversationsToFolder,
  renameConversation,
  reorderConversationFolders,
  rollbackConversationToMessage,
  updateConversationFolder,
  updateConversationProvider,
} from "@/services/ai-conversations";
import { AIWebSocketClient } from "@/services/ai-websocket";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  AIConversationInput,
  AIMessage,
  AIProviderStatus,
  AIScenario,
  PageContext,
  WSServerMessage,
} from "@/types/ai";
import { installAIStoreLifecycle } from "./ai.store-lifecycle";
import {
  applyConversationStatus,
  handleWSMessage,
  normalizeConversationMessages,
  sortConversationFolders,
  sortConversationSummaries,
} from "./ai.store-runtime";
import {
  type AIState,
  ANSWERED_QUESTION_TOMBSTONE_TTL_MS,
  aiContextEstimateState,
  aiConversationLoadState,
  aiWebSocketState,
  answeredQuestionTombstones,
  appendLocalAssistantError,
  appendPendingSteerMessage,
  appliedConversationRevisions,
  assistantDeltaBuffers,
  assistantDraftVersions,
  cancelledPlanTombstones,
  canSendSelectedReasoningEffort,
  completedAssistantCommentVersions,
  contextEstimateRequests,
  generateId,
  generateUuid,
  getAIContextUsage,
  getConversationBlock,
  loadStoredAIModel,
  loadStoredAIReasoningEffort,
  nowIso,
  observedPlanStatuses,
  pendingInputCommands,
  pendingPlanCancellationCommands,
  pendingSetupCommands,
  pendingToolCommands,
  removeStartingAssistantMessage,
  resolveDraftProviderSelection,
  resolveReasoningEffort,
  type SendMessageOptions,
  sendWSMessage,
  startingAssistantMessageId,
  storeAIModel,
  storeAIReasoningEffort,
  terminalAssistantRuns,
  trySendWSMessage,
  updateToolCallById,
} from "./ai.store-shared";

export * from "./ai.store-shared";

export const useAIStore = create<AIState>()((set, get) => ({
  messages: [],
  queuedInputs: [],
  resourceReferences: [],
  recentConversations: [],
  conversationFolders: [],
  isLoadingRecentConversations: false,
  isLoadingConversationFolders: false,
  isStreaming: false,
  isStartingConversation: false,
  isConnected: false,
  isConnecting: false,
  connectionError: null,
  isEnabled: null,
  retryAfter: null,
  savedName: null,
  activeConversationId: null,
  sidebarActiveConversationId: null,
  activeRunId: null,
  activePlan: null,
  plans: [],
  dismissedPlanDecisionKey: null,
  devPlanProgressPreview: null,
  workMode: "normal",
  canContinueConversation: false,
  isCompactingContext: false,
  lastContext: null,
  pendingApprovalToolCallId: null,
  pendingCredentialChallenge: null,
  pendingSetupInteraction: null,
  providerStatus: null,
  selectedModel: loadStoredAIModel(),
  selectedReasoningEffort: loadStoredAIReasoningEffort(loadStoredAIModel()),
  contextUsageDialog: null,

  connect: async () => {
    const auth = useAuthStore.getState();
    if (!auth.user && auth.isLoading) {
      set({ isConnecting: true, connectionError: null });
      return false;
    }
    if (!auth.user) {
      set({ isConnecting: false, connectionError: "Not authenticated" });
      return false;
    }
    void get()
      .refreshProviderStatus()
      .catch(() => {});
    if (aiWebSocketState.client?.isConnected) {
      set({ isConnected: true, isConnecting: false, connectionError: null });
      return true;
    }
    if (aiWebSocketState.client) {
      return false;
    }

    const client = new AIWebSocketClient();
    aiWebSocketState.client = client;
    set({ isConnecting: true, connectionError: null });
    client.onMessage((msg: WSServerMessage) => {
      if (aiWebSocketState.client !== client) return;
      handleWSMessage(msg, set, get);
    });
    client.onStatusChange((connected) => {
      if (aiWebSocketState.client !== client) return;
      set({
        isConnected: connected,
        isConnecting: false,
        connectionError: connected ? null : get().connectionError,
      });
      const activeConversationId = get().activeConversationId;
      if (connected && activeConversationId) {
        trySendWSMessage({ type: "conversation.subscribe", conversationId: activeConversationId });
      }
      if (!connected) {
        set((state) => ({
          isStreaming: false,
          isStartingConversation: false,
          isCompactingContext: false,
          messages: removeStartingAssistantMessage(state.messages),
        }));
      }
    });
    client.onConnectionError((message) => {
      if (aiWebSocketState.client !== client) return;
      set({ connectionError: message, isConnecting: false });
    });

    const ok = await client.connect();
    if (aiWebSocketState.client !== client) return false;
    if (!ok) {
      const currentError = get().connectionError;
      const transientFailure = currentError === null || currentError === "Reconnecting...";
      set({
        isConnecting: false,
        isConnected: false,
        connectionError: transientFailure ? "Reconnecting..." : currentError,
      });
    }
    return ok;
  },

  disconnect: () => {
    aiWebSocketState.client?.disconnect();
    aiWebSocketState.client = null;
    set((state) => ({
      isConnected: false,
      isConnecting: false,
      connectionError: null,
      isStreaming: false,
      isStartingConversation: false,
      isCompactingContext: false,
      messages: removeStartingAssistantMessage(state.messages),
    }));
  },

  sendMessage: (
    content: string,
    context?: PageContext,
    attachments: AIMessage["attachments"] = [],
    options: SendMessageOptions = {}
  ) => {
    const state = get();
    const baseMessages = options.startNewConversation ? [] : state.messages;
    if ((!options.startNewConversation && state.isStreaming) || getConversationBlock(baseMessages))
      return;
    if (options.startNewConversation && state.activeConversationId) {
      trySendWSMessage({
        type: "conversation.unsubscribe",
        conversationId: state.activeConversationId,
      });
    }
    if (options.startNewConversation) aiConversationLoadState.generation += 1;
    const clientCommandId = generateId();

    set({
      isStreaming: true,
      canContinueConversation: false,
      isStartingConversation: options.startNewConversation === true,
      isCompactingContext: false,
      lastContext: context ?? null,
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      workMode: state.workMode,
      messages: [
        ...baseMessages,
        {
          id: `starting:${clientCommandId}:user`,
          role: "user",
          content,
          attachments,
          clientCommandId,
          createdAt: nowIso(),
          localOnly: true,
        },
        {
          id: startingAssistantMessageId(clientCommandId),
          role: "assistant",
          content: "",
          clientCommandId,
          createdAt: nowIso(),
          isStreaming: true,
        },
      ],
      ...(options.startNewConversation
        ? {
            queuedInputs: [],
            resourceReferences: [],
            savedName: null,
            activeConversationId: null,
            sidebarActiveConversationId: null,
            activeRunId: null,
            activePlan: null,
            plans: [],
            isCompactingContext: false,
          }
        : {}),
    });

    try {
      sendWSMessage({
        type: "conversation.send_message",
        clientCommandId,
        content,
        attachments,
        context,
        ...(state.providerStatus?.providerType === "opfield_inference" && state.selectedModel
          ? { model: state.selectedModel }
          : {}),
        ...(canSendSelectedReasoningEffort(state.providerStatus) && state.selectedReasoningEffort
          ? { reasoningEffort: state.selectedReasoningEffort }
          : {}),
        ...(state.workMode === "plan" ? { workMode: "plan" as const } : {}),
        conversationId: options.startNewConversation
          ? undefined
          : (state.activeConversationId ?? undefined),
      });
    } catch (error) {
      set((state) => ({
        isStreaming: false,
        isStartingConversation: false,
        isCompactingContext: false,
        messages: appendLocalAssistantError(
          removeStartingAssistantMessage(state.messages, clientCommandId),
          `**Error:** ${error instanceof Error ? error.message : "Failed to send message"}`
        ),
      }));
    }
  },

  startScenario: (scenario: AIScenario, context?: PageContext) => {
    const state = get();
    const currentConversationIsRunning =
      state.isStartingConversation ||
      (state.activeConversationId !== null && state.messages.length > 0 && state.isStreaming);
    if (currentConversationIsRunning || getConversationBlock(state.messages)) return;
    if (state.activeConversationId) {
      trySendWSMessage({
        type: "conversation.unsubscribe",
        conversationId: state.activeConversationId,
      });
    }
    aiConversationLoadState.generation += 1;
    const clientCommandId = generateUuid();
    set({
      isStreaming: true,
      isStartingConversation: true,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      // A scenario starts by gathering requirements. Its plan mode is shown only
      // once the assistant has actually produced a plan for the conversation.
      workMode: "normal",
      messages: [
        {
          id: `starting:${clientCommandId}:user`,
          role: "user",
          content: scenario.title,
          scenario,
          createdAt: nowIso(),
          localOnly: true,
        },
        {
          id: startingAssistantMessageId(clientCommandId),
          role: "assistant",
          content: "",
          createdAt: nowIso(),
          isStreaming: true,
        },
      ],
      queuedInputs: [],
      resourceReferences: [],
      savedName: null,
      activeConversationId: null,
      sidebarActiveConversationId: null,
      activeRunId: null,
      activePlan: null,
      plans: [],
      isCompactingContext: false,
    });
    try {
      sendWSMessage({
        type: "conversation.start_scenario",
        clientCommandId,
        scenarioId: scenario.id,
        context,
        ...(state.providerStatus?.providerType === "opfield_inference" && state.selectedModel
          ? { model: state.selectedModel }
          : {}),
        ...(canSendSelectedReasoningEffort(state.providerStatus) && state.selectedReasoningEffort
          ? { reasoningEffort: state.selectedReasoningEffort }
          : {}),
      });
    } catch (error) {
      set((current) => ({
        isStreaming: false,
        isStartingConversation: false,
        messages: appendLocalAssistantError(
          removeStartingAssistantMessage(current.messages, clientCommandId),
          `**Error:** ${error instanceof Error ? error.message : "Failed to start scenario"}`
        ),
      }));
    }
  },

  setWorkMode: (workMode) => set({ workMode }),

  abandonPlanning: () => {
    const state = get();
    if (!state.activeConversationId) {
      set({ workMode: "normal" });
      return;
    }
    const clientCommandId = generateId();
    sendWSMessage({
      type: "conversation.abandon_planning",
      conversationId: state.activeConversationId,
      clientCommandId,
    });
    const publishedPlan = [
      ...state.plans,
      ...(state.activePlan?.publishedAt ? [state.activePlan] : []),
    ]
      .filter(
        (plan) =>
          plan.id === state.activePlan?.id &&
          plan.conversationId === state.activeConversationId &&
          Boolean(plan.publishedAt)
      )
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0];
    const publishedDecisionKey = publishedPlan?.revisionId
      ? `${state.activeConversationId}:${publishedPlan.revisionId}`
      : null;
    set((current) => ({
      activeRunId: null,
      activePlan: publishedPlan ? { ...publishedPlan, status: "awaiting_decision" } : null,
      plans: publishedPlan
        ? current.plans
        : current.plans.filter(
            (plan) => !["drafting", "validating", "awaiting_decision"].includes(plan.status)
          ),
      isStreaming: false,
      isStartingConversation: false,
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      dismissedPlanDecisionKey: publishedDecisionKey,
      workMode: "normal",
    }));
  },

  decidePlan: (decision, customInstruction) => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan?.revisionId) return;
    const decisionKey = `${activeConversationId}:${activePlan.revisionId}`;
    if (decision === "refine") {
      set({ dismissedPlanDecisionKey: decisionKey, workMode: "plan" });
      return;
    }
    set({ dismissedPlanDecisionKey: null, workMode: "normal" });
    sendWSMessage({
      type: "plan.decide",
      conversationId: activeConversationId,
      planId: activePlan.id,
      revisionId: activePlan.revisionId,
      decision,
      ...(customInstruction?.trim() ? { customInstruction: customInstruction.trim() } : {}),
      clientCommandId: generateId(),
    });
  },

  pausePlan: () => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan) return;
    sendWSMessage({
      type: "plan.pause",
      conversationId: activeConversationId,
      planId: activePlan.id,
      clientCommandId: generateId(),
    });
  },

  resumePlan: () => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan) return;
    sendWSMessage({
      type: "plan.resume",
      conversationId: activeConversationId,
      planId: activePlan.id,
      clientCommandId: generateId(),
    });
  },

  cancelPlan: () => {
    const { activeConversationId, activePlan } = get();
    if (!activeConversationId || !activePlan) return;
    const clientCommandId = generateId();
    cancelledPlanTombstones.set(activeConversationId, { planId: activePlan.id, clientCommandId });
    pendingPlanCancellationCommands.set(clientCommandId, {
      conversationId: activeConversationId,
      plan: activePlan,
    });
    try {
      sendWSMessage({
        type: "plan.cancel",
        conversationId: activeConversationId,
        planId: activePlan.id,
        clientCommandId,
      });
    } catch (error) {
      cancelledPlanTombstones.delete(activeConversationId);
      pendingPlanCancellationCommands.delete(clientCommandId);
      toastApiError(error, "Failed to cancel plan");
      return;
    }
    set((state) => ({
      activePlan: null,
      plans: state.plans.map((plan) =>
        plan.id === activePlan.id ? { ...plan, status: "cancelled", updatedAt: nowIso() } : plan
      ),
      workMode: "normal",
    }));
  },

  queueMessage: (
    content: string,
    context?: PageContext,
    attachments: AIMessage["attachments"] = []
  ) => {
    const state = get();
    const text = content.trim();
    if (!state.activeConversationId || (!text && attachments.length === 0)) return;
    const inputId = generateUuid();
    const clientCommandId = generateId();
    const createdAt = nowIso();
    const input: AIConversationInput = {
      id: inputId,
      conversationId: state.activeConversationId,
      targetRunId: state.activeRunId,
      userId: "",
      clientCommandId,
      mode: "queued",
      status: "pending",
      content: text,
      attachments,
      context: context ?? null,
      consumedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    pendingInputCommands.set(clientCommandId, { kind: "queue", input });
    set((current) => ({ queuedInputs: [...current.queuedInputs, input] }));
    try {
      sendWSMessage({
        type: "conversation.queue_message",
        conversationId: state.activeConversationId,
        inputId,
        clientCommandId,
        content: text,
        attachments,
        context,
      });
    } catch {
      pendingInputCommands.delete(clientCommandId);
      set((current) => ({
        queuedInputs: current.queuedInputs.filter((item) => item.id !== inputId),
      }));
    }
  },

  steerQueuedMessage: (inputId: string) => {
    const state = get();
    if (!state.activeConversationId) return;
    const input = state.queuedInputs.find((item) => item.id === inputId);
    if (!input) return;
    const clientCommandId = generateId();
    pendingInputCommands.set(clientCommandId, { kind: "steer", input });
    set((current) => ({
      queuedInputs: current.queuedInputs.filter((item) => item.id !== inputId),
      messages: appendPendingSteerMessage(current.messages, { ...input, mode: "steer" }),
    }));
    try {
      sendWSMessage({
        type: "conversation.steer_message",
        conversationId: state.activeConversationId,
        inputId,
        clientCommandId,
      });
    } catch {
      pendingInputCommands.delete(clientCommandId);
      set((current) => ({
        queuedInputs: [...current.queuedInputs, input],
        messages: current.messages.filter((message) => message.id !== `steer:${inputId}`),
      }));
    }
  },

  cancelQueuedMessage: (inputId: string) => {
    const state = get();
    if (!state.activeConversationId) return;
    const input = state.queuedInputs.find((item) => item.id === inputId);
    if (!input) return;
    const clientCommandId = generateId();
    pendingInputCommands.set(clientCommandId, { kind: "cancel", input });
    set((current) => ({
      queuedInputs: current.queuedInputs.filter((item) => item.id !== inputId),
    }));
    try {
      sendWSMessage({
        type: "conversation.cancel_queued_message",
        conversationId: state.activeConversationId,
        inputId,
        clientCommandId,
      });
    } catch {
      pendingInputCommands.delete(clientCommandId);
      set((current) => ({ queuedInputs: [...current.queuedInputs, input] }));
    }
  },

  continueConversation: (context?: PageContext) => {
    const state = get();
    if (
      !state.activeConversationId ||
      state.isStreaming ||
      state.isCompactingContext ||
      !state.canContinueConversation ||
      getConversationBlock(state.messages)
    ) {
      return;
    }
    const clientCommandId = generateId();
    set({
      isStreaming: true,
      canContinueConversation: false,
      activeRunId: null,
      activePlan: null,
      plans: [],
      workMode: "normal",
      lastContext: context ?? state.lastContext,
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
    });
    try {
      sendWSMessage({
        type: "conversation.continue",
        conversationId: state.activeConversationId,
        clientCommandId,
        context: context ?? state.lastContext ?? undefined,
        ...(state.providerStatus?.providerType === "opfield_inference" && state.selectedModel
          ? { model: state.selectedModel }
          : {}),
        ...(canSendSelectedReasoningEffort(state.providerStatus) && state.selectedReasoningEffort
          ? { reasoningEffort: state.selectedReasoningEffort }
          : {}),
      });
    } catch (error) {
      set((current) => ({
        isStreaming: false,
        canContinueConversation: true,
        messages: appendLocalAssistantError(
          current.messages,
          `**Error:** ${error instanceof Error ? error.message : "Failed to continue conversation"}`
        ),
      }));
    }
  },

  approveTool: (toolCallId: string) => {
    const state = get();
    if (!state.activeConversationId || !state.activeRunId) return;
    const previous = state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === toolCallId);
    const clientCommandId = generateId();

    set((state) => ({
      messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
        ...tc,
        status: "running",
        approvalPolicy: "requires_approval",
        approvalDecisionPending: true,
        error: undefined,
      })),
    }));
    pendingToolCommands.set(clientCommandId, {
      toolCallId,
      previousStatus: previous?.status ?? "awaiting_approval",
      previousResult: previous?.result,
      decision: "approval",
      approvalDecision: "approved",
    });
    try {
      sendWSMessage({
        type: "approval.decide",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        approvalId: toolCallId,
        decision: "approved",
        clientCommandId,
      });
    } catch (error) {
      pendingToolCommands.delete(clientCommandId);
      set((state) => ({
        messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
          ...tc,
          status: "awaiting_approval",
          approvalDecisionPending: false,
          result: previous?.result,
          error: error instanceof Error ? error.message : "Failed to send approval",
        })),
      }));
    }
  },

  rejectTool: (toolCallId: string) => {
    const state = get();
    if (!state.activeConversationId || !state.activeRunId) return;
    const previous = state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === toolCallId);
    const clientCommandId = generateId();

    set((state) => ({
      messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
        ...tc,
        status: "rejected",
        approvalDecisionPending: true,
        error: undefined,
      })),
    }));
    pendingToolCommands.set(clientCommandId, {
      toolCallId,
      previousStatus: previous?.status ?? "awaiting_approval",
      previousResult: previous?.result,
      decision: "approval",
      approvalDecision: "rejected",
    });
    try {
      sendWSMessage({
        type: "approval.decide",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        approvalId: toolCallId,
        decision: "rejected",
        clientCommandId,
      });
    } catch (error) {
      pendingToolCommands.delete(clientCommandId);
      set((state) => ({
        messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
          ...tc,
          status: "awaiting_approval",
          approvalDecisionPending: false,
          result: previous?.result,
          error: error instanceof Error ? error.message : "Failed to send rejection",
        })),
      }));
    }
  },

  answerQuestion: (toolCallId: string, answer: string) => {
    const state = get();
    if (!state.activeConversationId || !state.activeRunId) return;

    const previous = state.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((toolCall) => toolCall.id === toolCallId);
    const clientCommandId = generateId();
    answeredQuestionTombstones.set(toolCallId, {
      conversationId: state.activeConversationId,
      runId: state.activeRunId,
      expiresAt: Date.now() + ANSWERED_QUESTION_TOMBSTONE_TTL_MS,
    });

    set((state) => ({
      messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
        ...tc,
        status: "running",
        result: { answer },
        error: undefined,
      })),
      pendingApprovalToolCallId: null,
    }));
    pendingToolCommands.set(clientCommandId, {
      toolCallId,
      previousStatus: previous?.status ?? "awaiting_approval",
      previousResult: previous?.result,
      decision: "question",
    });
    try {
      sendWSMessage({
        type: "question.answer",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        questionId: toolCallId,
        answer,
        clientCommandId,
      });
    } catch (error) {
      pendingToolCommands.delete(clientCommandId);
      answeredQuestionTombstones.delete(toolCallId);
      set((state) => ({
        messages: updateToolCallById(state.messages, toolCallId, (tc) => ({
          ...tc,
          status: "awaiting_approval",
          result: previous?.result,
          error: error instanceof Error ? error.message : "Failed to send answer",
        })),
        pendingApprovalToolCallId: toolCallId,
      }));
    }
  },

  resolveCredentialChallenge: (decision: "authorized" | "rejected") => {
    const challenge = get().pendingCredentialChallenge;
    if (!challenge) return;
    sendWSMessage({
      type: "credential.resolve",
      conversationId: challenge.conversationId,
      runId: challenge.runId,
      challengeId: challenge.id,
      decision,
      clientCommandId: generateId(),
    });
  },

  resolveSetupInteraction: (status, result) => {
    const interaction = get().pendingSetupInteraction;
    if (!interaction) return;
    const clientCommandId = generateId();
    pendingSetupCommands.set(clientCommandId, interaction);
    try {
      sendWSMessage({
        type: "setup.resolve",
        conversationId: interaction.conversationId,
        runId: interaction.runId,
        interactionId: interaction.id,
        status,
        ...(result ? { result } : {}),
        clientCommandId,
      });
      set({ pendingSetupInteraction: null });
    } catch (error) {
      pendingSetupCommands.delete(clientCommandId);
      toastApiError(error, "Failed to continue setup");
    }
  },

  stopStreaming: () => {
    const state = get();
    if (state.isCompactingContext) return;
    if (state.activeConversationId && state.activeRunId) {
      trySendWSMessage({
        type: "run.stop",
        conversationId: state.activeConversationId,
        runId: state.activeRunId,
        clientCommandId: generateId(),
      });
    }
    set((state) => ({
      isStreaming: false,
      messages: state.messages.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg
      ),
    }));
  },

  clearMessages: () => {
    aiConversationLoadState.generation += 1;
    const activeConversationId = get().activeConversationId;
    if (activeConversationId) {
      trySendWSMessage({ type: "conversation.unsubscribe", conversationId: activeConversationId });
    }
    const draftSelection = resolveDraftProviderSelection(get().providerStatus);
    set({
      messages: [],
      queuedInputs: [],
      resourceReferences: [],
      savedName: null,
      activeConversationId: null,
      sidebarActiveConversationId: null,
      activeRunId: null,
      activePlan: null,
      plans: [],
      devPlanProgressPreview: null,
      workMode: "normal",
      canContinueConversation: false,
      isStreaming: false,
      isStartingConversation: false,
      isCompactingContext: false,
      lastContext: null,
      contextUsageDialog: null,
      ...draftSelection,
    });
  },

  fetchRecentConversations: async () => {
    if (!useAuthStore.getState().user) return;
    set((state) => ({
      isLoadingRecentConversations: state.recentConversations.length === 0,
    }));
    try {
      const conversations = await listConversations();
      set({ recentConversations: conversations, isLoadingRecentConversations: false });
    } catch {
      set({ isLoadingRecentConversations: false });
    }
  },

  fetchConversationFolders: async () => {
    if (!useAuthStore.getState().user) return;
    set((state) => ({
      isLoadingConversationFolders: state.conversationFolders.length === 0,
    }));
    try {
      const folders = await listConversationFolders();
      set({
        conversationFolders: sortConversationFolders(folders),
        isLoadingConversationFolders: false,
      });
    } catch {
      set({ isLoadingConversationFolders: false });
    }
  },

  createConversationFolder: async (input) => {
    const created = await createConversationFolder(input);
    set((state) => ({
      conversationFolders: sortConversationFolders([...state.conversationFolders, created]),
    }));
    return created;
  },

  updateConversationFolder: async (id, input) => {
    const previousFolders = get().conversationFolders;
    set((state) => ({
      conversationFolders: state.conversationFolders.map((folder) =>
        folder.id === id
          ? {
              ...folder,
              ...input,
              updatedAt: nowIso(),
            }
          : folder
      ),
    }));
    try {
      const updated = await updateConversationFolder(id, input);
      set((state) => ({
        conversationFolders: sortConversationFolders(
          state.conversationFolders.map((folder) => (folder.id === id ? updated : folder))
        ),
      }));
      return updated;
    } catch (error) {
      set({ conversationFolders: previousFolders });
      throw error;
    }
  },

  deleteConversationFolder: async (id) => {
    const previousFolders = get().conversationFolders;
    const previousConversations = get().recentConversations;
    set((state) => ({
      conversationFolders: state.conversationFolders.filter((folder) => folder.id !== id),
      recentConversations: state.recentConversations.map((conversation) =>
        conversation.folderId === id ? { ...conversation, folderId: null } : conversation
      ),
    }));
    try {
      await deleteConversationFolder(id);
    } catch (error) {
      set({ conversationFolders: previousFolders, recentConversations: previousConversations });
      throw error;
    }
  },

  reorderConversationFolders: async (folderIds) => {
    const previousFolders = get().conversationFolders;
    const orderById = new Map(folderIds.map((id, index) => [id, index]));
    const nextFolders = sortConversationFolders(
      previousFolders.map((folder) =>
        orderById.has(folder.id) ? { ...folder, sortOrder: orderById.get(folder.id)! } : folder
      )
    );
    set({ conversationFolders: nextFolders });
    try {
      const folders = await reorderConversationFolders(
        nextFolders.map((folder, index) => ({ id: folder.id, sortOrder: index }))
      );
      set({ conversationFolders: sortConversationFolders(folders) });
    } catch (error) {
      set({ conversationFolders: previousFolders });
      throw error;
    }
  },

  moveConversationsToFolder: async (conversationIds, folderId) => {
    const ids = new Set(conversationIds);
    const previousConversations = get().recentConversations;
    set((state) => ({
      recentConversations: state.recentConversations.map((conversation) =>
        ids.has(conversation.id) ? { ...conversation, folderId } : conversation
      ),
    }));
    try {
      await moveConversationsToFolder(conversationIds, folderId);
    } catch (error) {
      set({ recentConversations: previousConversations });
      throw error;
    }
  },

  loadConversation: async (conversationId: string) => {
    const loadGeneration = (aiConversationLoadState.generation += 1);
    try {
      const previousConversationId = get().activeConversationId;
      if (previousConversationId && previousConversationId !== conversationId) {
        trySendWSMessage({
          type: "conversation.unsubscribe",
          conversationId: previousConversationId,
        });
      }
      set({ sidebarActiveConversationId: conversationId, workMode: "normal" });
      const conversation = await getConversation(conversationId);
      if (loadGeneration !== aiConversationLoadState.generation) return;
      set({
        messages: applyConversationStatus(
          normalizeConversationMessages(conversation.messages, conversation.id),
          conversation.id,
          conversation.status,
          conversation.blockReason
        ),
        savedName: conversation.title,
        activeConversationId: conversation.id,
        sidebarActiveConversationId: conversation.id,
        activeRunId: null,
        activePlan: null,
        plans: [],
        workMode: "normal",
        isStreaming: false,
        canContinueConversation: false,
        isStartingConversation: false,
        isCompactingContext: false,
        lastContext: conversation.lastContext,
        selectedModel: conversation.model ?? get().selectedModel,
        selectedReasoningEffort:
          conversation.reasoningEffort ??
          resolveReasoningEffort(get().providerStatus, conversation.model ?? get().selectedModel),
      });
      trySendWSMessage({ type: "conversation.subscribe", conversationId });
    } catch {
      if (loadGeneration !== aiConversationLoadState.generation) return;
      const localMsg: AIMessage = {
        id: generateId(),
        role: "assistant",
        content: "Failed to load conversation.",
        createdAt: nowIso(),
        localOnly: true,
      };
      set({
        messages: [localMsg],
        queuedInputs: [],
        savedName: null,
        activeConversationId: null,
        sidebarActiveConversationId: null,
        activeRunId: null,
        activePlan: null,
        plans: [],
        workMode: "normal",
        isStreaming: false,
        canContinueConversation: false,
        isStartingConversation: false,
        isCompactingContext: false,
        lastContext: null,
        pendingApprovalToolCallId: null,
        pendingCredentialChallenge: null,
        pendingSetupInteraction: null,
      });
    }
  },

  deleteConversation: async (conversationId: string) => {
    try {
      await deleteConversation(conversationId);
      if (get().activeConversationId === conversationId) {
        trySendWSMessage({ type: "conversation.unsubscribe", conversationId });
      }
      set((state) => ({
        recentConversations: state.recentConversations.filter(
          (conversation) => conversation.id !== conversationId
        ),
        ...(state.activeConversationId === conversationId
          ? {
              messages: [],
              queuedInputs: [],
              resourceReferences: [],
              savedName: null,
              activeConversationId: null,
              sidebarActiveConversationId: null,
              activeRunId: null,
              activePlan: null,
              plans: [],
              canContinueConversation: false,
              isStartingConversation: false,
              isCompactingContext: false,
              lastContext: null,
              ...resolveDraftProviderSelection(state.providerStatus),
            }
          : {}),
      }));
    } catch {
      const localMsg: AIMessage = {
        id: generateId(),
        role: "assistant",
        content: "Failed to delete conversation.",
        createdAt: nowIso(),
        localOnly: true,
      };
      set((state) => ({ messages: [...state.messages, localMsg] }));
    }
  },

  renameConversation: async (conversationId: string, title: string) => {
    const conversation = await renameConversation(conversationId, title);
    set((state) => ({
      savedName:
        state.activeConversationId === conversationId ? conversation.title : state.savedName,
      recentConversations: sortConversationSummaries(
        state.recentConversations.map((item) =>
          item.id === conversationId
            ? {
                ...item,
                title: conversation.title,
                updatedAt: conversation.updatedAt,
                lastUserMessageAt: conversation.lastUserMessageAt,
                status: conversation.status,
                blockReason: conversation.blockReason,
                activeRunStatus: conversation.activeRunStatus,
              }
            : item
        )
      ),
    }));
  },

  rollbackToMessage: async (messageId: string) => {
    const state = get();
    if (!state.activeConversationId || state.isCompactingContext) return null;
    const existing = state.messages.find((message) => message.id === messageId);
    if (!existing || existing.role !== "user") return null;

    const activeRunId = state.activeRunId;
    const result = activeRunId
      ? await rollbackConversationToMessage(state.activeConversationId, messageId, activeRunId)
      : await rollbackConversationToMessage(state.activeConversationId, messageId);
    const messages = normalizeConversationMessages(
      result.conversation.messages,
      result.conversation.id
    );
    set((state) => ({
      messages,
      savedName: result.conversation.title,
      activeConversationId: result.conversation.id,
      sidebarActiveConversationId: result.conversation.id,
      activeRunId: null,
      isCompactingContext: false,
      lastContext: result.conversation.lastContext,
      selectedModel: result.conversation.model ?? state.selectedModel,
      selectedReasoningEffort:
        result.conversation.reasoningEffort ??
        resolveReasoningEffort(
          state.providerStatus,
          result.conversation.model ?? state.selectedModel
        ),
      pendingApprovalToolCallId: null,
      pendingCredentialChallenge: null,
      pendingSetupInteraction: null,
      isStreaming: false,
      isStartingConversation: false,
      recentConversations: sortConversationSummaries(
        state.recentConversations.map((item) =>
          item.id === result.conversation.id
            ? {
                ...item,
                title: result.conversation.title,
                updatedAt: result.conversation.updatedAt,
                lastUserMessageAt: result.conversation.lastUserMessageAt,
                folderId: result.conversation.folderId,
                messageCount: result.conversation.messages.length,
                status: result.conversation.status,
                blockReason: result.conversation.blockReason,
                activeRunStatus: result.conversation.activeRunStatus,
              }
            : item
        )
      ),
    }));
    trySendWSMessage({ type: "conversation.sync", conversationId: result.conversation.id });
    return result.message;
  },

  retryMessage: async (messageId: string) => {
    const state = get();
    if (state.isStreaming || state.isCompactingContext) return;
    const message = await get().rollbackToMessage(messageId);
    if (!message) return;
    get().sendMessage(message.content, get().lastContext ?? undefined, message.attachments ?? []);
  },

  setEnabled: (enabled: boolean) => {
    set({ isEnabled: enabled });
  },

  setProviderStatus: (status: AIProviderStatus) => {
    set((state) => {
      if (status.providerType === "openai_compatible") {
        const storedReasoningEffort = loadStoredAIReasoningEffort(status.defaultModel);
        const currentReasoningEffort = (status.reasoningEfforts ?? []).includes(
          state.selectedReasoningEffort ?? ""
        )
          ? state.selectedReasoningEffort
          : null;
        return {
          providerStatus: status,
          selectedModel: null,
          selectedReasoningEffort: status.allowUserReasoningEffortSelection
            ? currentReasoningEffort ||
              ((status.reasoningEfforts ?? []).includes(storedReasoningEffort ?? "")
                ? storedReasoningEffort
                : status.defaultReasoningEffort)
            : null,
          isEnabled: status.enabled,
        };
      }
      const selectable = status.providerType === "opfield_inference" && status.models.length > 0;
      const hasLoadedConversation =
        Boolean(state.activeConversationId) && state.messages.length > 0;
      const currentAllowed =
        selectable &&
        (status.allowUserModelSelection || hasLoadedConversation) &&
        status.models.some((model) => model.id === state.selectedModel);
      const selectedModel = selectable
        ? currentAllowed
          ? state.selectedModel
          : status.defaultModel || status.models[0]?.id || null
        : null;
      const selectedModelOption = status.models.find((model) => model.id === selectedModel);
      const storedReasoningEffort = loadStoredAIReasoningEffort(selectedModel);
      const selectedReasoningEffort =
        hasLoadedConversation && currentAllowed
          ? state.selectedReasoningEffort
          : selectedModelOption?.reasoningEfforts.includes(state.selectedReasoningEffort ?? "")
            ? state.selectedReasoningEffort
            : selectedModelOption?.reasoningEfforts.includes(storedReasoningEffort ?? "")
              ? storedReasoningEffort
              : selectedModelOption?.defaultReasoningEffort ||
                selectedModelOption?.reasoningEfforts[0] ||
                null;
      if (!hasLoadedConversation) storeAIModel(selectedModel);
      return {
        providerStatus: status,
        selectedModel,
        selectedReasoningEffort,
        isEnabled: status.enabled,
      };
    });
  },

  refreshProviderStatus: async () => {
    const status = await api.getAIStatus();
    get().setProviderStatus(status);
  },

  setSelectedModel: async (model: string) => {
    const state = get();
    const status = state.providerStatus;
    if (
      status?.providerType !== "opfield_inference" ||
      !status.allowUserModelSelection ||
      !status.models.some((option) => option.id === model)
    ) {
      return;
    }
    storeAIModel(model);
    const option = status.models.find((candidate) => candidate.id === model);
    const storedReasoningEffort = loadStoredAIReasoningEffort(model);
    const selectedReasoningEffort = option?.reasoningEfforts.includes(storedReasoningEffort ?? "")
      ? storedReasoningEffort
      : option?.defaultReasoningEffort || option?.reasoningEfforts[0] || null;
    const previousModel = state.selectedModel;
    const previousReasoningEffort = state.selectedReasoningEffort;
    set({ selectedModel: model, selectedReasoningEffort });
    if (!state.activeConversationId || state.messages.length === 0) return;

    try {
      const conversation = await updateConversationProvider(state.activeConversationId, {
        model,
        reasoningEffort: selectedReasoningEffort,
      });
      if (get().activeConversationId !== conversation.id) return;
      set({
        messages: applyConversationStatus(
          normalizeConversationMessages(conversation.messages, conversation.id),
          conversation.id,
          conversation.status,
          conversation.blockReason
        ),
        selectedModel: conversation.model ?? model,
        selectedReasoningEffort: conversation.reasoningEffort ?? selectedReasoningEffort,
      });
    } catch (error) {
      if (get().activeConversationId === state.activeConversationId) {
        set({
          selectedModel: previousModel,
          selectedReasoningEffort: previousReasoningEffort,
        });
      }
      storeAIModel(previousModel);
      throw error;
    }
  },

  setSelectedReasoningEffort: async (effort: string) => {
    const state = get();
    const { providerStatus, selectedModel } = state;
    if (providerStatus?.providerType === "openai_compatible") {
      if (
        !providerStatus.allowUserReasoningEffortSelection ||
        !(providerStatus.reasoningEfforts ?? []).includes(effort)
      ) {
        return;
      }
      storeAIReasoningEffort(providerStatus.defaultModel, effort);
      set({ selectedReasoningEffort: effort });
      if (!state.activeConversationId || state.messages.length === 0) return;
      try {
        const conversation = await updateConversationProvider(state.activeConversationId, {
          model: providerStatus.defaultModel,
          reasoningEffort: effort,
        });
        if (get().activeConversationId !== conversation.id) return;
        set({
          selectedModel: null,
          selectedReasoningEffort: conversation.reasoningEffort ?? effort,
        });
      } catch (error) {
        if (get().activeConversationId === state.activeConversationId) {
          set({ selectedReasoningEffort: state.selectedReasoningEffort });
        }
        storeAIReasoningEffort(providerStatus.defaultModel, state.selectedReasoningEffort);
        throw error;
      }
      return;
    }
    const option = providerStatus?.models.find((model) => model.id === selectedModel);
    if (
      providerStatus?.providerType !== "opfield_inference" ||
      !selectedModel ||
      !option?.reasoningEfforts.includes(effort)
    ) {
      return;
    }
    storeAIReasoningEffort(selectedModel, effort);
    set({ selectedReasoningEffort: effort });
    if (!state.activeConversationId || state.messages.length === 0) return;

    try {
      const conversation = await updateConversationProvider(state.activeConversationId, {
        model: selectedModel,
        reasoningEffort: effort,
      });
      if (get().activeConversationId !== conversation.id) return;
      set({
        selectedModel: conversation.model ?? selectedModel,
        selectedReasoningEffort: conversation.reasoningEffort ?? effort,
      });
    } catch (error) {
      if (get().activeConversationId === state.activeConversationId) {
        set({ selectedReasoningEffort: state.selectedReasoningEffort });
      }
      storeAIReasoningEffort(selectedModel, state.selectedReasoningEffort);
      throw error;
    }
  },

  setMessages: (messages: AIMessage[]) => {
    set({ messages });
  },

  closeContextUsageDialog: () => {
    set({ contextUsageDialog: null });
  },

  handleSlashCommand: async (input: string): Promise<boolean> => {
    if (get().isStreaming) return true;
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    if (cmd === "/clear" || cmd === "/new") {
      const activeConversationId = get().activeConversationId;
      if (activeConversationId) {
        trySendWSMessage({
          type: "conversation.unsubscribe",
          conversationId: activeConversationId,
        });
      }
      const draftSelection = resolveDraftProviderSelection(get().providerStatus);
      set({
        messages: [],
        queuedInputs: [],
        resourceReferences: [],
        savedName: null,
        activeConversationId: null,
        sidebarActiveConversationId: null,
        activeRunId: null,
        activePlan: null,
        plans: [],
        workMode: "normal",
        isStreaming: false,
        isStartingConversation: false,
        isCompactingContext: false,
        lastContext: null,
        contextUsageDialog: null,
        ...draftSelection,
      });
      return true;
    }

    if (cmd === "/compact") {
      const {
        activeConversationId,
        lastContext,
        providerStatus,
        selectedModel,
        selectedReasoningEffort,
      } = get();
      if (!activeConversationId) {
        set((state) => ({
          messages: appendLocalAssistantError(
            state.messages,
            "Open a saved conversation before compacting context."
          ),
        }));
        return true;
      }

      const clientCommandId = generateId();
      set({
        isStreaming: true,
        activeRunId: null,
        isCompactingContext: true,
        pendingApprovalToolCallId: null,
        pendingCredentialChallenge: null,
        pendingSetupInteraction: null,
      });
      try {
        sendWSMessage({
          type: "conversation.compact",
          conversationId: activeConversationId,
          clientCommandId,
          context: lastContext ?? undefined,
          ...(providerStatus?.providerType === "opfield_inference" && selectedModel
            ? { model: selectedModel }
            : {}),
          ...(canSendSelectedReasoningEffort(providerStatus) && selectedReasoningEffort
            ? { reasoningEffort: selectedReasoningEffort }
            : {}),
        });
      } catch (error) {
        set((state) => ({
          isStreaming: false,
          isCompactingContext: false,
          messages: appendLocalAssistantError(
            state.messages,
            `**Error:** ${error instanceof Error ? error.message : "Failed to compact context"}`
          ),
        }));
      }
      return true;
    }

    if (cmd === "/context") {
      const {
        activeConversationId,
        lastContext,
        messages,
        providerStatus,
        selectedModel,
        selectedReasoningEffort,
      } = get();
      const usage = await getAIContextUsage(
        messages,
        lastContext ?? undefined,
        activeConversationId,
        providerStatus?.providerType === "opfield_inference" ? selectedModel : undefined,
        canSendSelectedReasoningEffort(providerStatus) ? selectedReasoningEffort : undefined
      );
      set({ contextUsageDialog: usage });
      return true;
    }

    return false;
  },
}));

export function resetAIStateForAuthChange() {
  aiWebSocketState.client?.disconnect();
  aiWebSocketState.client = null;
  for (const buffer of assistantDeltaBuffers.values()) clearTimeout(buffer.timer);
  assistantDeltaBuffers.clear();
  aiConversationLoadState.generation += 1;
  assistantDraftVersions.clear();
  completedAssistantCommentVersions.clear();
  terminalAssistantRuns.clear();
  appliedConversationRevisions.clear();
  answeredQuestionTombstones.clear();
  pendingToolCommands.clear();
  pendingInputCommands.clear();
  observedPlanStatuses.clear();
  cancelledPlanTombstones.clear();
  pendingPlanCancellationCommands.clear();
  pendingSetupCommands.clear();
  aiContextEstimateState.cache = null;
  contextEstimateRequests.clear();
  useAIStore.setState({
    messages: [],
    queuedInputs: [],
    resourceReferences: [],
    recentConversations: [],
    conversationFolders: [],
    isLoadingRecentConversations: false,
    isLoadingConversationFolders: false,
    isStreaming: false,
    isStartingConversation: false,
    isConnected: false,
    isConnecting: false,
    connectionError: null,
    retryAfter: null,
    savedName: null,
    activeConversationId: null,
    sidebarActiveConversationId: null,
    activeRunId: null,
    activePlan: null,
    plans: [],
    devPlanProgressPreview: null,
    dismissedPlanDecisionKey: null,
    workMode: "normal",
    canContinueConversation: false,
    isCompactingContext: false,
    lastContext: null,
    pendingApprovalToolCallId: null,
    pendingCredentialChallenge: null,
    pendingSetupInteraction: null,
    providerStatus: null,
    selectedModel: loadStoredAIModel(),
    selectedReasoningEffort: loadStoredAIReasoningEffort(loadStoredAIModel()),
    contextUsageDialog: null,
  });
}

installAIStoreLifecycle(useAIStore);
