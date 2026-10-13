import { toast } from "sonner";
import type { AIConversationFolder, AIConversationSummary } from "@/services/ai-conversations";
import { invalidateToolStore } from "@/services/tool-store-invalidation";
import { applyAssistantResourcePinAction } from "@/stores/assistant-resource-pins";
import {
  handleLicenseError,
  type LicenseFeature,
  licenseErrorFeature,
} from "@/stores/license-paywall";
import type {
  AIConversationRuntimeSnapshot,
  AIConversationStatus,
  AICredentialChallenge,
  AIMessage,
  AIResourceReference,
  AIRunToolCall,
  AIToolCall,
  WSServerMessage,
} from "@/types/ai";
import {
  type AIState,
  ANSWERED_QUESTION_TOMBSTONE_TTL_MS,
  ASSISTANT_DELTA_BATCH_MS,
  ASSISTANT_DELTA_BATCH_WORDS,
  acceptConversationRevision,
  answeredQuestionTombstones,
  appendLocalAssistantError,
  appendPendingSteerMessages,
  assistantDeltaBuffers,
  assistantDraftVersions,
  cancelledPlanTombstones,
  completedAssistantCommentVersions,
  generateId,
  getConversationBlock,
  nowIso,
  observedPlanStatuses,
  pendingInputCommands,
  pendingPlanCancellationCommands,
  pendingSetupCommands,
  pendingToolCommands,
  removeStartingAssistantMessage,
  startingAssistantMessageId,
  terminalAssistantRuns,
  updateToolCallById,
  upsertTimelinePlan,
} from "./ai.store-shared";

const AI_LICENSE_CAPABILITIES: Partial<Record<LicenseFeature, string>> = {
  "ai-plan-mode": "AI Plan Mode",
  "ai-scenarios": "AI scenarios",
  "ai-sandboxes": "AI sandboxes",
};

export function handleWSMessage(
  msg: WSServerMessage,
  set: (partial: Partial<AIState> | ((state: AIState) => Partial<AIState>)) => void,
  get: () => AIState
) {
  switch (msg.type) {
    case "command.ack":
      {
        if (msg.clientCommandId) pendingSetupCommands.delete(msg.clientCommandId);
        if (msg.clientCommandId) pendingInputCommands.delete(msg.clientCommandId);
        if (msg.clientCommandId && msg.commandType === "plan.cancel") {
          pendingPlanCancellationCommands.delete(msg.clientCommandId);
        }
        const pending = msg.clientCommandId
          ? pendingToolCommands.get(msg.clientCommandId)
          : undefined;
        if (msg.clientCommandId) pendingToolCommands.delete(msg.clientCommandId);
        if (pending?.decision === "approval") {
          set((state) => ({
            messages: updateToolCallById(state.messages, pending.toolCallId, (tc) => ({
              ...tc,
              approvalDecisionPending: false,
              status: pending.approvalDecision === "rejected" ? "rejected" : "running",
            })),
            pendingApprovalToolCallId:
              state.pendingApprovalToolCallId === pending.toolCallId
                ? null
                : state.pendingApprovalToolCallId,
          }));
        }
      }
      set((state) => {
        const selectsConversation =
          msg.commandType === "conversation.send_message" ||
          msg.commandType === "conversation.start_scenario";
        const matchesCurrentConversation =
          !!msg.conversationId && state.activeConversationId === msg.conversationId;
        return {
          ...(selectsConversation && msg.conversationId
            ? {
                activeConversationId: msg.conversationId,
                sidebarActiveConversationId: msg.conversationId,
              }
            : {}),
          ...(msg.runId && (selectsConversation || matchesCurrentConversation)
            ? { activeRunId: msg.runId }
            : {}),
          ...(msg.runId && msg.clientCommandId && selectsConversation
            ? {
                messages: state.messages.map((message) =>
                  message.id === startingAssistantMessageId(msg.clientCommandId!)
                    ? {
                        ...message,
                        id: `${msg.runId}:runtime`,
                        runId: msg.runId,
                        isStreaming: true,
                      }
                    : message
                ),
              }
            : {}),
        };
      });
      break;

    case "command.error":
      {
        const failedSetup = msg.clientCommandId
          ? pendingSetupCommands.get(msg.clientCommandId)
          : undefined;
        if (failedSetup) {
          pendingSetupCommands.delete(msg.clientCommandId!);
          set({ pendingSetupInteraction: failedSetup });
          toast.error(msg.message);
          break;
        }
        const cancelledPlan = msg.clientCommandId
          ? pendingPlanCancellationCommands.get(msg.clientCommandId)
          : undefined;
        if (cancelledPlan && msg.commandType === "plan.cancel") {
          pendingPlanCancellationCommands.delete(msg.clientCommandId!);
          const tombstone = cancelledPlanTombstones.get(cancelledPlan.conversationId);
          if (tombstone?.clientCommandId === msg.clientCommandId) {
            cancelledPlanTombstones.delete(cancelledPlan.conversationId);
          }
          set((state) => ({
            activePlan:
              state.activeConversationId === cancelledPlan.conversationId
                ? cancelledPlan.plan
                : state.activePlan,
            plans: upsertTimelinePlan(state.plans, cancelledPlan.plan),
          }));
          toast.error(msg.message);
          break;
        }
        const pendingInput = msg.clientCommandId
          ? pendingInputCommands.get(msg.clientCommandId)
          : undefined;
        if (pendingInput) {
          if (msg.clientCommandId) pendingInputCommands.delete(msg.clientCommandId);
          set((state) => {
            if (pendingInput.kind === "queue") {
              return {
                queuedInputs: state.queuedInputs.filter(
                  (input) => input.id !== pendingInput.input.id
                ),
              };
            }
            return {
              queuedInputs: state.queuedInputs.some((input) => input.id === pendingInput.input.id)
                ? state.queuedInputs
                : [...state.queuedInputs, pendingInput.input],
              messages:
                pendingInput.kind === "steer"
                  ? state.messages.filter(
                      (message) => message.id !== `steer:${pendingInput.input.id}`
                    )
                  : state.messages,
            };
          });
          break;
        }
        const pending = msg.clientCommandId
          ? pendingToolCommands.get(msg.clientCommandId)
          : undefined;
        if (pending) {
          if (msg.clientCommandId) pendingToolCommands.delete(msg.clientCommandId);
          if (pending.decision === "question") {
            answeredQuestionTombstones.delete(pending.toolCallId);
          }
          set((state) => ({
            isStreaming: false,
            isCompactingContext: false,
            messages: updateToolCallById(state.messages, pending.toolCallId, (tc) => ({
              ...tc,
              status: pending.previousStatus,
              approvalDecisionPending: false,
              result: pending.previousResult,
              error: msg.message,
            })),
            pendingApprovalToolCallId: pending.toolCallId,
          }));
          break;
        }
        // A license denial opens the shared upgrade dialog instead of an error bubble.
        const licenseFeature = licenseErrorFeature(msg.details);
        const capability =
          (licenseFeature && AI_LICENSE_CAPABILITIES[licenseFeature]) ?? "This AI request";
        if (handleLicenseError(msg, capability)) {
          set((state) => ({
            isStreaming: false,
            isStartingConversation: false,
            isCompactingContext: false,
            messages: removeStartingAssistantMessage(state.messages, msg.clientCommandId),
            ...(licenseFeature === "ai-plan-mode" ? { workMode: "normal" as const } : {}),
            ...(msg.commandType === "conversation.continue"
              ? { canContinueConversation: true }
              : {}),
          }));
          break;
        }
      }
      set((state) => ({
        isStreaming: false,
        isStartingConversation: false,
        isCompactingContext: false,
        messages: appendLocalAssistantError(
          removeStartingAssistantMessage(state.messages, msg.clientCommandId),
          `**Error:** ${msg.message}`
        ),
        ...(msg.commandType === "conversation.continue" ? { canContinueConversation: true } : {}),
      }));
      break;

    case "conversation.snapshot": {
      const revision = typeof msg.snapshot.revision === "number" ? msg.snapshot.revision : null;
      if (!acceptConversationRevision(msg.conversationId, revision ?? undefined)) return;
      set((state) => ({
        recentConversations: patchRecentConversationFromSnapshot(
          state.recentConversations,
          msg.snapshot
        ),
      }));
      if (get().activeConversationId !== msg.conversationId) return;
      const previousRunId = get().activeRunId;
      const snapshotRun = msg.snapshot.runtime.activeRun;
      if (!snapshotRun) {
        const completedRunIds = new Set(
          [...assistantDeltaBuffers.entries()]
            .filter(([, buffer]) => buffer.message.conversationId === msg.conversationId)
            .map(([runId]) => runId)
        );
        if (previousRunId) completedRunIds.add(previousRunId);
        for (const runId of completedRunIds) {
          flushAssistantDelta(runId, set, get);
          terminalAssistantRuns.add(runId);
        }
      } else if (snapshotRun && isActiveRunStatus(snapshotRun.status)) {
        terminalAssistantRuns.delete(snapshotRun.id);
      }
      set((state) => {
        const projection = projectConversationSnapshot(
          msg.snapshot,
          state.messages,
          state.pendingCredentialChallenge
        );
        const tombstone = cancelledPlanTombstones.get(msg.conversationId);
        const snapshotPlan = msg.snapshot.runtime.activePlan;
        if (tombstone) {
          if (!snapshotPlan || snapshotPlan.id !== tombstone.planId) {
            cancelledPlanTombstones.delete(msg.conversationId);
          } else if (snapshotPlan.status === "cancelled") {
            cancelledPlanTombstones.delete(msg.conversationId);
            projection.activePlan = null;
          } else {
            projection.activePlan = null;
            projection.plans = (projection.plans ?? []).map((plan) =>
              plan.id === tombstone.planId
                ? { ...plan, status: "cancelled", updatedAt: nowIso() }
                : plan
            );
          }
        }
        return { ...projection, isStartingConversation: false };
      });
      break;
    }

    case "plan.status_changed": {
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      const tombstone = cancelledPlanTombstones.get(msg.conversationId);
      if (tombstone?.planId === msg.plan.id && msg.plan.status !== "cancelled") return;
      if (tombstone?.planId === msg.plan.id) {
        cancelledPlanTombstones.delete(msg.conversationId);
      }
      const previousStatus = observedPlanStatuses.get(msg.conversationId);
      observedPlanStatuses.set(msg.conversationId, msg.plan.status);
      set((state) => ({
        recentConversations: state.recentConversations.map((conversation) =>
          conversation.id === msg.conversationId
            ? { ...conversation, planStatus: msg.plan.status }
            : conversation
        ),
        ...(state.activeConversationId === msg.conversationId
          ? {
              activePlan: msg.plan.status === "cancelled" ? null : msg.plan,
              plans: upsertTimelinePlan(state.plans, msg.plan),
            }
          : {}),
      }));
      if (previousStatus && previousStatus !== msg.plan.status) {
        const title = msg.plan.title || "Work Session plan";
        if (msg.plan.status === "awaiting_decision") toast.info(`${title} is ready to review`);
        if (msg.plan.status === "paused") toast.warning(`${title} is paused`);
        if (msg.plan.status === "completed") toast.success(`${title} is complete`);
      }
      break;
    }

    case "client.action":
      if (get().activeConversationId !== msg.conversationId) return;
      if (get().activeRunId && get().activeRunId !== msg.runId) return;
      applyAssistantResourcePinAction({ clientAction: msg.action });
      break;

    case "assistant.delta":
      if (get().activeConversationId !== msg.conversationId) return;
      completedAssistantCommentVersions.delete(msg.runId);
      queueAssistantDelta(msg, "assistant", set, get);
      break;

    case "assistant.comment_delta":
      if (get().activeConversationId !== msg.conversationId) return;
      completedAssistantCommentVersions.delete(msg.runId);
      queueAssistantDelta(msg, "comment", set, get);
      break;

    case "assistant.comment_done":
      if (get().activeConversationId !== msg.conversationId) return;
      if (terminalAssistantRuns.has(msg.runId)) return;
      flushAssistantDelta(msg.runId, set, get);
      completedAssistantCommentVersions.set(msg.runId, assistantDraftVersions.get(msg.runId) ?? 0);
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        messages: applyAssistantCommentDoneToMessages(state.messages, msg),
      }));
      break;

    case "credential.required":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (get().activeConversationId !== msg.conversationId) return;
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        isCompactingContext: false,
        pendingCredentialChallenge: msg.challenge,
        recentConversations: patchRecentConversationRunStatus(
          state.recentConversations,
          msg.conversationId,
          "waiting_for_credential"
        ),
      }));
      break;

    case "run.status_changed":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (!isActiveRunStatus(msg.run?.status) && msg.run?.id) {
        flushAssistantDelta(msg.run.id, set, get);
        terminalAssistantRuns.add(msg.run.id);
      } else if (msg.run?.id) {
        terminalAssistantRuns.delete(msg.run.id);
      }
      set((state) => ({
        recentConversations: patchRecentConversationRunStatus(
          state.recentConversations,
          msg.conversationId,
          msg.run?.status ?? null
        ),
        ...(state.activeConversationId === msg.conversationId
          ? {
              activeRunId: msg.run?.id ?? null,
              isStreaming: isActiveRunStatus(msg.run?.status),
              isCompactingContext: Boolean(
                msg.run && msg.run.activeMessageId === null && isActiveRunStatus(msg.run.status)
              ),
            }
          : {}),
      }));
      break;

    case "stores.invalidated":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      for (const storeName of msg.stores) invalidateToolStore(storeName);
      break;

    case "question.answered":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (get().activeConversationId !== msg.conversationId) return;
      answeredQuestionTombstones.set(msg.question.toolCallId, {
        conversationId: msg.conversationId,
        runId: msg.runId,
        expiresAt: Date.now() + ANSWERED_QUESTION_TOMBSTONE_TTL_MS,
      });
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        pendingApprovalToolCallId: null,
        messages: ensureActiveRuntimePlaceholder(
          updateToolCallById(state.messages, msg.question.toolCallId, (tc) => ({
            ...tc,
            status: "completed",
            result: { answer: msg.question.answer ?? tc.result },
            error: undefined,
          })),
          msg.runId
        ),
      }));
      break;

    case "credential.updated":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      if (get().activeConversationId !== msg.conversationId) return;
      set((state) => ({
        activeRunId: msg.runId,
        isStreaming: true,
        pendingCredentialChallenge:
          state.pendingCredentialChallenge?.id === msg.challenge.id
            ? null
            : state.pendingCredentialChallenge,
      }));
      break;

    case "approval.updated":
      if (!acceptConversationRevision(msg.conversationId, msg.revision)) return;
      for (const [clientCommandId, pending] of pendingToolCommands) {
        if (pending.toolCallId === msg.approval.toolCallId) {
          pendingToolCommands.delete(clientCommandId);
        }
      }
      if (get().activeConversationId !== msg.conversationId) return;
      set((state) => ({
        activeRunId: msg.runId,
        messages: updateToolCallById(state.messages, msg.approval.toolCallId, () =>
          runtimeToolCallToUI(msg.approval)
        ),
        pendingApprovalToolCallId:
          state.pendingApprovalToolCallId === msg.approval.toolCallId
            ? null
            : state.pendingApprovalToolCallId,
      }));
      break;
  }
}

export function projectConversationSnapshot(
  snapshot: AIConversationRuntimeSnapshot,
  currentMessages: AIMessage[] = [],
  currentCredentialChallenge: AICredentialChallenge | null = null
): Partial<AIState> {
  const activeRunId = snapshot.runtime.activeRun?.id ?? null;
  const pendingCredentialChallenge =
    snapshot.runtime.pendingCredentialChallenge ??
    (currentCredentialChallenge &&
    activeRunId === currentCredentialChallenge.runId &&
    isActiveRunStatus(snapshot.runtime.activeRun?.status)
      ? currentCredentialChallenge
      : null);
  const snapshotDraftVersion = snapshot.runtime.assistantDraftVersion;
  const currentDraftVersion = activeRunId ? (assistantDraftVersions.get(activeRunId) ?? -1) : -1;
  const completedCommentVersion = activeRunId
    ? (completedAssistantCommentVersions.get(activeRunId) ?? -1)
    : -1;
  const snapshotDraftIsStale = Boolean(
    activeRunId &&
      typeof snapshotDraftVersion === "number" &&
      (snapshotDraftVersion < currentDraftVersion ||
        snapshotDraftVersion <= completedCommentVersion)
  );

  if (activeRunId && typeof snapshotDraftVersion === "number" && !snapshotDraftIsStale) {
    assistantDraftVersions.set(activeRunId, snapshotDraftVersion);
  }
  const runtimeToolCalls = snapshot.runtime.toolCalls
    .filter((toolCall) => toolCall.toolName !== "send_comment")
    .map(runtimeToolCallToUI);
  const runtimeToolCallsById = new Map(runtimeToolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const pendingQuestions = (
    snapshot.runtime.pendingQuestions.length > 0
      ? snapshot.runtime.pendingQuestions
      : snapshot.runtime.pendingQuestion
        ? [snapshot.runtime.pendingQuestion]
        : []
  ).filter((question) => {
    const tombstone = answeredQuestionTombstones.get(question.toolCallId);
    if (tombstone && tombstone.expiresAt <= Date.now()) {
      answeredQuestionTombstones.delete(question.toolCallId);
      return true;
    }
    return !(
      tombstone &&
      tombstone.conversationId === snapshot.conversation.id &&
      tombstone.runId === question.runId
    );
  });
  const pendingQuestionToolCalls = pendingQuestions.map((question) =>
    pendingQuestionToToolCall(question, runtimeToolCallsById.get(question.toolCallId))
  );
  const pendingInputs = snapshot.runtime.pendingInputs ?? [];
  const snapshotMessages = reconcileOptimisticMessages(
    suppressAnsweredQuestionTombstones(
      normalizeSnapshotMessages(snapshot),
      currentMessages,
      snapshot.conversation.id
    ),
    currentMessages,
    snapshot.runtime.activeRun?.id ?? null,
    snapshot.runtime.activeRun?.clientCommandId ?? null
  );
  const attachedMessages = preserveFreshRuntimeDraft(
    attachRuntimeToolCallsToMessages(
      appendPendingSteerMessages(snapshotMessages, pendingInputs),
      [...runtimeToolCalls, ...pendingQuestionToolCalls],
      Boolean(snapshot.runtime.activeRun),
      snapshot.runtime.activeRun?.id ?? null
    ),
    currentMessages,
    snapshotDraftIsStale ? activeRunId : null
  );
  const messages = applyConversationStatus(
    clearActiveToolBoundaryStreamingWhenTextStarted(attachedMessages, activeRunId),
    snapshot.conversation.id,
    snapshot.conversation.status,
    snapshot.conversation.blockReason
  );

  return {
    messages,
    queuedInputs: pendingInputs.filter((input) => input.mode === "queued"),
    resourceReferences: snapshot.resourceReferences ?? [],
    savedName: snapshot.conversation.title,
    activeConversationId: snapshot.conversation.id,
    sidebarActiveConversationId: snapshot.conversation.id,
    activeRunId: snapshot.runtime.activeRun?.id ?? null,
    activePlan: snapshot.runtime.activePlan ?? null,
    plans:
      snapshot.runtime.plans ?? (snapshot.runtime.activePlan ? [snapshot.runtime.activePlan] : []),
    canContinueConversation: snapshot.runtime.canContinue === true,
    isCompactingContext: Boolean(
      snapshot.runtime.activeRun &&
        snapshot.runtime.activeRun.activeMessageId === null &&
        isActiveRunStatus(snapshot.runtime.activeRun.status)
    ),
    lastContext: snapshot.conversation.lastContext,
    ...(typeof snapshot.conversation.model === "string"
      ? {
          selectedModel: snapshot.conversation.model,
          selectedReasoningEffort: snapshot.conversation.reasoningEffort ?? null,
        }
      : {}),
    pendingApprovalToolCallId:
      snapshot.runtime.pendingApprovals[0]?.toolCallId ?? pendingQuestions[0]?.toolCallId ?? null,
    pendingCredentialChallenge,
    pendingSetupInteraction: snapshot.runtime.pendingSetupInteraction ?? null,
    isStreaming:
      Boolean(pendingCredentialChallenge) || isActiveRunStatus(snapshot.runtime.activeRun?.status),
    isStartingConversation: false,
  };
}

export function suppressAnsweredQuestionTombstones(
  messages: AIMessage[],
  currentMessages: AIMessage[],
  conversationId: string
): AIMessage[] {
  const currentToolCalls = new Map(
    currentMessages.flatMap((message) =>
      (message.toolCalls ?? []).map((toolCall) => [toolCall.id, toolCall] as const)
    )
  );
  return messages.map((message) => {
    if (!message.toolCalls?.length) return message;
    let changed = false;
    const toolCalls = message.toolCalls.map((toolCall) => {
      const tombstone = answeredQuestionTombstones.get(toolCall.id);
      if (tombstone && tombstone.expiresAt <= Date.now()) {
        answeredQuestionTombstones.delete(toolCall.id);
        return toolCall;
      }
      if (
        toolCall.name !== "ask_question" ||
        !tombstone ||
        tombstone.conversationId !== conversationId
      ) {
        return toolCall;
      }
      changed = true;
      const current = currentToolCalls.get(toolCall.id);
      return {
        ...toolCall,
        status: "completed" as const,
        result: current?.result ?? toolCall.result,
      };
    });
    return changed ? { ...message, toolCalls } : message;
  });
}

export function reconcileOptimisticMessages(
  snapshotMessages: AIMessage[],
  currentMessages: AIMessage[],
  activeRunId: string | null,
  activeClientCommandId: string | null
): AIMessage[] {
  const currentUsersByCommand = new Map(
    currentMessages.flatMap((message) =>
      message.role === "user" && message.clientCommandId
        ? [[message.clientCommandId, message] as const]
        : []
    )
  );
  const stableSnapshotMessages = snapshotMessages.map((message) => {
    if (message.role !== "user" || !message.clientCommandId) return message;
    const current = currentUsersByCommand.get(message.clientCommandId);
    return current ? { ...message, id: current.id, serverId: message.id } : message;
  });
  const persistedCommands = new Set(
    stableSnapshotMessages.flatMap((message) =>
      message.clientCommandId ? [message.clientCommandId] : []
    )
  );
  const missingOptimisticUsers = currentMessages.filter(
    (message) =>
      message.role === "user" &&
      message.localOnly &&
      message.clientCommandId &&
      !persistedCommands.has(message.clientCommandId)
  );
  const next = [...stableSnapshotMessages, ...missingOptimisticUsers];
  if (!activeRunId || !activeClientCommandId) return next;
  const optimisticAssistant = currentMessages.find(
    (message) => message.id === startingAssistantMessageId(activeClientCommandId)
  );
  if (!optimisticAssistant || next.some((message) => message.id === `${activeRunId}:runtime`)) {
    return next;
  }
  return [
    ...next,
    {
      ...optimisticAssistant,
      id: `${activeRunId}:runtime`,
      runId: activeRunId,
      isStreaming: true,
    },
  ];
}

export function preserveFreshRuntimeDraft(
  snapshotMessages: AIMessage[],
  currentMessages: AIMessage[],
  activeRunId: string | null
): AIMessage[] {
  if (!activeRunId) return snapshotMessages;
  const currentIndex = findActiveRuntimeAssistantIndex(currentMessages, activeRunId);
  const nextMessages = [...snapshotMessages];
  if (currentIndex !== -1) {
    const snapshotIndex = findActiveRuntimeAssistantIndex(snapshotMessages, activeRunId);
    if (snapshotIndex !== -1) {
      const currentDraft = currentMessages[currentIndex];
      nextMessages[snapshotIndex] = {
        ...nextMessages[snapshotIndex],
        content: currentDraft.content,
        isStreaming: currentDraft.isStreaming,
        streamingChunk: currentDraft.streamingChunk,
      };
    }
  }

  const currentCommentIndex = findActiveCommentIndex(currentMessages, activeRunId);
  if (
    currentCommentIndex !== -1 &&
    !nextMessages.some((message) => message.id === currentMessages[currentCommentIndex].id)
  ) {
    nextMessages.push(currentMessages[currentCommentIndex]);
  }
  return sortMessagesBySequence(nextMessages);
}

export function queueAssistantDelta(
  message: Extract<WSServerMessage, { type: "assistant.delta" | "assistant.comment_delta" }>,
  kind: "assistant" | "comment",
  set: (partial: Partial<AIState> | ((state: AIState) => Partial<AIState>)) => void,
  get: () => AIState
): void {
  if (terminalAssistantRuns.has(message.runId)) return;
  const buffered = assistantDeltaBuffers.get(message.runId);
  const appliedVersion = assistantDraftVersions.get(message.runId) ?? 0;
  if (message.version <= Math.max(appliedVersion, buffered?.version ?? 0)) return;
  if (buffered && buffered.kind !== kind) flushAssistantDelta(message.runId, set, get);
  const active = assistantDeltaBuffers.get(message.runId);
  const timer =
    active?.timer ??
    setTimeout(() => flushAssistantDelta(message.runId, set, get), ASSISTANT_DELTA_BATCH_MS);
  assistantDeltaBuffers.set(message.runId, {
    kind,
    content: `${active?.content ?? ""}${message.content}`,
    version: message.version,
    message,
    timer,
  });
  const pendingContent = assistantDeltaBuffers.get(message.runId)?.content ?? "";
  if (pendingContent.trim().split(/\s+/u).filter(Boolean).length >= ASSISTANT_DELTA_BATCH_WORDS) {
    flushAssistantDelta(message.runId, set, get);
  }
}

export function flushAssistantDelta(
  runId: string,
  set: (partial: Partial<AIState> | ((state: AIState) => Partial<AIState>)) => void,
  get: () => AIState
): void {
  const buffered = assistantDeltaBuffers.get(runId);
  if (!buffered) return;
  clearTimeout(buffered.timer);
  assistantDeltaBuffers.delete(runId);
  if (get().activeConversationId !== buffered.message.conversationId) return;
  const delta = { ...buffered.message, content: buffered.content, version: buffered.version };
  set((state) => ({
    activeRunId: runId,
    isStreaming: true,
    isStartingConversation: false,
    isCompactingContext: false,
    messages:
      buffered.kind === "assistant"
        ? applyAssistantDeltaToMessages(
            state.messages,
            delta as Extract<WSServerMessage, { type: "assistant.delta" }>
          )
        : applyAssistantCommentDeltaToMessages(
            state.messages,
            delta as Extract<WSServerMessage, { type: "assistant.comment_delta" }>
          ),
    recentConversations: patchRecentConversationRunStatus(
      state.recentConversations,
      buffered.message.conversationId,
      "running"
    ),
  }));
}

export function applyAssistantDeltaToMessages(
  messages: AIMessage[],
  delta: Extract<WSServerMessage, { type: "assistant.delta" }>
): AIMessage[] {
  const previousVersion = assistantDraftVersions.get(delta.runId) ?? 0;
  if (delta.version <= previousVersion) return messages;
  assistantDraftVersions.set(delta.runId, delta.version);

  const nextMessages = [...messages];
  let targetIndex = findActiveRuntimeAssistantIndex(nextMessages, delta.runId);
  if (targetIndex === -1) {
    targetIndex = nextMessages.length;
    nextMessages.push({
      id: `${delta.runId}:runtime`,
      role: "assistant",
      content: "",
      sequence: nextMessageSequence(nextMessages),
      createdAt: nowIso(),
      isStreaming: true,
    });
  }

  const current = nextMessages[targetIndex];
  nextMessages[targetIndex] = {
    ...current,
    content: `${current.content}${delta.content}`,
    streamingChunk: delta.content,
    isStreaming: true,
  };
  return sortMessagesBySequence(
    clearActiveToolBoundaryStreamingWhenTextStarted(nextMessages, delta.runId)
  );
}

export function applyAssistantCommentDeltaToMessages(
  messages: AIMessage[],
  delta: Extract<WSServerMessage, { type: "assistant.comment_delta" }>
): AIMessage[] {
  const previousVersion = assistantDraftVersions.get(delta.runId) ?? 0;
  if (delta.version <= previousVersion) return messages;
  assistantDraftVersions.set(delta.runId, delta.version);

  const nextMessages = [...messages];
  let targetIndex = findLastIndex(
    nextMessages,
    (message) =>
      message.role === "assistant" &&
      message.id.startsWith(`${delta.runId}:comment:`) &&
      Boolean(message.isStreaming)
  );
  if (targetIndex === -1) {
    const placeholderIndex = nextMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.id === `${delta.runId}:runtime` &&
        !message.content.trim() &&
        !message.toolCalls?.length
    );
    if (placeholderIndex === -1) {
      targetIndex = nextMessages.length;
      nextMessages.push({
        id: `${delta.runId}:comment:${delta.version}`,
        role: "assistant",
        content: "",
        sequence: nextMessageSequence(nextMessages),
        createdAt: nowIso(),
        isStreaming: true,
      });
    } else {
      targetIndex = placeholderIndex;
      nextMessages[targetIndex] = {
        ...nextMessages[targetIndex],
        id: `${delta.runId}:comment:${delta.version}`,
      };
    }
  }

  const current = nextMessages[targetIndex];
  nextMessages[targetIndex] = {
    ...current,
    content: `${current.content}${delta.content}`,
    streamingChunk: delta.content,
    isStreaming: true,
  };
  return sortMessagesBySequence(nextMessages);
}

export function applyAssistantCommentDoneToMessages(
  messages: AIMessage[],
  event: Extract<WSServerMessage, { type: "assistant.comment_done" }>
): AIMessage[] {
  let completedBoundary = 0;
  const nextMessages = messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    if (message.id.startsWith(`${event.runId}:comment:`) && message.isStreaming) {
      return [{ ...message, isStreaming: false }];
    }
    if (message.id !== `${event.runId}:runtime` && message.id !== `${event.runId}:draft`) {
      return [message];
    }
    if (!message.content.trim() && !message.toolCalls?.length) return [];
    completedBoundary += 1;
    return [
      {
        ...message,
        id: `${event.runId}:comment:completed:${message.sequence ?? completedBoundary}:${completedBoundary}`,
        isStreaming: false,
      },
    ];
  });
  return ensureActiveRuntimePlaceholder(nextMessages, event.runId);
}

export function ensureActiveRuntimePlaceholder(messages: AIMessage[], runId: string): AIMessage[] {
  if (
    messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.id === `${runId}:runtime` || message.id === `${runId}:draft`)
    )
  ) {
    return sortMessagesBySequence(messages);
  }
  return sortMessagesBySequence([
    ...messages,
    {
      id: `${runId}:runtime`,
      role: "assistant",
      content: "",
      sequence: nextMessageSequence(messages),
      createdAt: nowIso(),
      isStreaming: true,
    },
  ]);
}

export function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

export function clearActiveToolBoundaryStreamingWhenTextStarted(
  messages: AIMessage[],
  activeRunId: string | null
): AIMessage[] {
  if (!activeRunId) return messages;
  const activeTextStarted = messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.id === `${activeRunId}:runtime` || message.id === `${activeRunId}:draft`) &&
      message.content.trim().length > 0
  );
  if (!activeTextStarted) return messages;

  return messages.map((message) => {
    const hasActiveRunToolCall = message.toolCalls?.some(
      (toolCall) => toolCall.runId === activeRunId
    );
    if (!hasActiveRunToolCall) return message;
    return { ...message, isStreaming: false };
  });
}

export function normalizeSnapshotMessages(snapshot: AIConversationRuntimeSnapshot): AIMessage[] {
  return normalizeConversationMessages(snapshot.messages, snapshot.conversation.id);
}

export function normalizeConversationMessages(
  messages: unknown[],
  conversationId: string
): AIMessage[] {
  return sortMessagesBySequence(
    messages
      .map((message, index) => normalizeConversationMessage(message, conversationId, index))
      .filter((message): message is AIMessage => message !== null)
  );
}

export function normalizeConversationMessage(
  value: unknown,
  conversationId: string,
  index: number
): AIMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;
  const id =
    typeof message.id === "string" && message.id.length > 0
      ? message.id
      : `${conversationId}:message:${index}`;
  return {
    id,
    role,
    content: typeof message.content === "string" ? message.content : "",
    sequence: typeof message.sequence === "number" ? message.sequence : index,
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as AIMessage["attachments"])
      : undefined,
    createdAt:
      typeof message.createdAt === "string" && message.createdAt.length > 0
        ? message.createdAt
        : undefined,
    toolCalls: Array.isArray(message.toolCalls)
      ? normalizeMessageToolCalls(message.toolCalls, id)
      : undefined,
    resourceReferences: Array.isArray(message.resourceReferences)
      ? (message.resourceReferences as AIResourceReference[])
      : undefined,
    changedResourceReferences: Array.isArray(message.changedResourceReferences)
      ? (message.changedResourceReferences as AIResourceReference[])
      : undefined,
    compactMarker: message.compactMarker === true,
    compactVersion:
      typeof message.compactVersion === "number" && Number.isFinite(message.compactVersion)
        ? Math.max(1, Math.trunc(message.compactVersion))
        : undefined,
    compactEpoch:
      typeof message.compactEpoch === "number" && Number.isFinite(message.compactEpoch)
        ? Math.max(0, Math.trunc(message.compactEpoch))
        : undefined,
    compactBoundaryMessageId:
      typeof message.compactBoundaryMessageId === "string"
        ? message.compactBoundaryMessageId
        : undefined,
    compactedMessageCount:
      typeof message.compactedMessageCount === "number" &&
      Number.isFinite(message.compactedMessageCount)
        ? Math.max(0, Math.trunc(message.compactedMessageCount))
        : undefined,
    sourceTokenEstimate:
      typeof message.sourceTokenEstimate === "number" &&
      Number.isFinite(message.sourceTokenEstimate)
        ? Math.max(0, Math.trunc(message.sourceTokenEstimate))
        : undefined,
    resultTokenEstimate:
      typeof message.resultTokenEstimate === "number" &&
      Number.isFinite(message.resultTokenEstimate)
        ? Math.max(0, Math.trunc(message.resultTokenEstimate))
        : undefined,
    compactTrigger:
      message.compactTrigger === "automatic" || message.compactTrigger === "manual"
        ? message.compactTrigger
        : message.compactTrigger === "auto"
          ? "automatic"
          : undefined,
    compactTailMessageCount:
      typeof message.compactTailMessageCount === "number" &&
      Number.isFinite(message.compactTailMessageCount)
        ? Math.max(0, Math.trunc(message.compactTailMessageCount))
        : undefined,
    conversationStatus: normalizeConversationBlockStatus(message.conversationStatus),
    blockReason: typeof message.blockReason === "string" ? message.blockReason : undefined,
    modelChange: normalizeModelChange(message.modelChange),
    steer: message.steer === true,
    steerPending: message.steerPending === true,
    localOnly: message.localOnly === true,
    runError: message.runError === true,
    runId: typeof message.runId === "string" ? message.runId : undefined,
    clientCommandId:
      typeof message.clientCommandId === "string" ? message.clientCommandId : undefined,
    isStreaming: false,
  };
}

export function normalizeModelChange(value: unknown): AIMessage["modelChange"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.fromModel !== "string" || typeof record.toModel !== "string") {
    return undefined;
  }
  return {
    fromModel: record.fromModel,
    toModel: record.toModel,
    fromDisplayName:
      typeof record.fromDisplayName === "string" ? record.fromDisplayName : undefined,
    toDisplayName: typeof record.toDisplayName === "string" ? record.toDisplayName : undefined,
  };
}

export function normalizeConversationBlockStatus(
  value: unknown
): Exclude<AIConversationStatus, "active"> | undefined {
  return value === "ended" || value === "context_blocked" ? value : undefined;
}

export function applyConversationStatus(
  messages: AIMessage[],
  conversationId: string,
  status: AIConversationStatus | undefined,
  blockReason: string | null | undefined
): AIMessage[] {
  if (status !== "ended" && status !== "context_blocked") return messages;
  if (getConversationBlock(messages)) return messages;
  return sortMessagesBySequence([
    ...messages,
    {
      id: `${conversationId}:status:${status}`,
      role: "assistant",
      content: "",
      sequence: nextMessageSequence(messages),
      conversationStatus: status,
      blockReason: blockReason ?? undefined,
    },
  ]);
}

export function normalizeMessageToolCalls(value: unknown[], messageId: string): AIToolCall[] {
  return value
    .map((toolCall, index) => normalizeMessageToolCall(toolCall, messageId, index))
    .filter(
      (toolCall): toolCall is AIToolCall => toolCall !== null && toolCall.name !== "send_comment"
    );
}

export function normalizeMessageToolCall(
  value: unknown,
  messageId: string,
  index: number
): AIToolCall | null {
  if (!value || typeof value !== "object") return null;
  const toolCall = value as Record<string, unknown>;
  const functionCall =
    toolCall.function && typeof toolCall.function === "object" && !Array.isArray(toolCall.function)
      ? (toolCall.function as Record<string, unknown>)
      : null;
  const id =
    typeof toolCall.id === "string" && toolCall.id.length > 0
      ? toolCall.id
      : `${messageId}:tool:${index}`;
  const name =
    typeof toolCall.name === "string" && toolCall.name.length > 0
      ? toolCall.name
      : typeof functionCall?.name === "string" && functionCall.name.length > 0
        ? functionCall.name
        : "tool";
  const rawArguments = toolCall.arguments ?? functionCall?.arguments;
  return {
    id,
    name,
    arguments: normalizeToolCallArguments(rawArguments),
    status: normalizeToolCallStatus(toolCall.status),
    approvalPolicy:
      typeof toolCall.approvalPolicy === "string" ? toolCall.approvalPolicy : undefined,
    assistantMessageId:
      typeof toolCall.assistantMessageId === "string" ? toolCall.assistantMessageId : undefined,
    result: toolCall.result,
    error: typeof toolCall.error === "string" ? toolCall.error : undefined,
  };
}

export function normalizeToolCallStatus(value: unknown): AIToolCall["status"] {
  if (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "awaiting_approval" ||
    value === "rejected"
  ) {
    return value;
  }
  return "completed";
}

export function runtimeToolCallToUI(toolCall: AIRunToolCall): AIToolCall {
  return {
    id: toolCall.toolCallId,
    runId: toolCall.runId,
    roundId: toolCall.roundId,
    position: toolCall.position,
    name: toolCall.toolName,
    arguments: toolCall.toolArgs,
    status: runtimeToolStatusToUI(toolCall.status),
    approvalPolicy: toolCall.approvalPolicy,
    assistantMessageId: toolCall.assistantMessageId,
    result: toolCall.result ?? undefined,
    error: toolCall.error ?? undefined,
  };
}

export function pendingQuestionToToolCall(
  question: AIConversationRuntimeSnapshot["runtime"]["pendingQuestions"][number],
  runtimeToolCall?: AIToolCall
): AIToolCall {
  return {
    id: question.toolCallId || question.id,
    name: "ask_question",
    runId: runtimeToolCall?.runId,
    roundId: runtimeToolCall?.roundId,
    position: runtimeToolCall?.position,
    arguments: { question: question.question },
    status: "awaiting_approval",
    result: question.answer ? { answer: question.answer } : undefined,
  };
}

export function runtimeToolStatusToUI(status: AIRunToolCall["status"]): AIToolCall["status"] {
  if (status === "pending_approval") return "awaiting_approval";
  if (status === "approved" || status === "running" || status === "created") return "running";
  if (status === "rejected") return "rejected";
  if (status === "failed" || status === "stopped") return "failed";
  return "completed";
}

export function attachRuntimeToolCallsToMessages(
  messages: AIMessage[],
  toolCalls: AIToolCall[],
  active: boolean,
  activeRunId: string | null
): AIMessage[] {
  if (toolCalls.length === 0 && !active) return messages;
  const nextMessages = [...messages];
  const unassignedToolCalls: AIToolCall[] = [];
  let activeRunLiveToolCallAttached = false;

  for (const toolCall of toolCalls) {
    const existingToolCallMessageIndex = nextMessages.findIndex((message) =>
      message.toolCalls?.some((existingToolCall) => existingToolCall.id === toolCall.id)
    );
    const belongsToActiveRun = Boolean(active && activeRunId && toolCall.runId === activeRunId);
    const liveActiveToolCall = belongsToActiveRun && isLiveToolCall(toolCall);
    if (existingToolCallMessageIndex !== -1) {
      const mergedToolCalls = mergeToolCalls(
        nextMessages[existingToolCallMessageIndex].toolCalls ?? [],
        [toolCall]
      );
      nextMessages[existingToolCallMessageIndex] = {
        ...nextMessages[existingToolCallMessageIndex],
        isStreaming: liveActiveToolCall
          ? true
          : belongsToActiveRun && !hasLiveActiveRunToolCall(mergedToolCalls, activeRunId)
            ? false
            : nextMessages[existingToolCallMessageIndex].isStreaming,
        toolCalls: mergedToolCalls,
      };
      if (liveActiveToolCall) activeRunLiveToolCallAttached = true;
      continue;
    }

    if (!toolCall.assistantMessageId) {
      unassignedToolCalls.push(toolCall);
      continue;
    }
    const targetIndex = nextMessages.findIndex(
      (message) => message.id === toolCall.assistantMessageId
    );
    if (targetIndex === -1 || nextMessages[targetIndex].role !== "assistant") {
      unassignedToolCalls.push(toolCall);
      continue;
    }
    if (liveActiveToolCall) activeRunLiveToolCallAttached = true;
    const mergedToolCalls = mergeToolCalls(nextMessages[targetIndex].toolCalls ?? [], [toolCall]);
    nextMessages[targetIndex] = {
      ...nextMessages[targetIndex],
      isStreaming: liveActiveToolCall
        ? true
        : belongsToActiveRun && !hasLiveActiveRunToolCall(mergedToolCalls, activeRunId)
          ? false
          : nextMessages[targetIndex].isStreaming,
      toolCalls: mergedToolCalls,
    };
  }

  if (unassignedToolCalls.length === 0) {
    if (
      active &&
      activeRunId &&
      !activeRunLiveToolCallAttached &&
      findActiveRuntimeAssistantIndex(nextMessages, activeRunId) === -1
    ) {
      const sequence = nextMessageSequence(nextMessages);
      nextMessages.push({
        id: `${activeRunId}:runtime`,
        role: "assistant",
        content: "",
        sequence,
        createdAt: nowIso(),
        isStreaming: true,
      });
    }
    return sortMessagesBySequence(nextMessages);
  }

  if (!active) {
    const sequence = nextMessageSequence(nextMessages);
    nextMessages.push({
      id: `toolcalls:${unassignedToolCalls.map((toolCall) => toolCall.id).join(":")}`,
      role: "assistant",
      content: "",
      sequence,
      createdAt: nowIso(),
      isStreaming: false,
      toolCalls: unassignedToolCalls,
    });
    return sortMessagesBySequence(nextMessages);
  }

  let targetIndex =
    active && activeRunId ? findActiveRuntimeAssistantIndex(nextMessages, activeRunId) : -1;
  if (targetIndex === -1 && active && activeRunId) {
    const sequence = nextMessageSequence(nextMessages);
    nextMessages.push({
      id: `${activeRunId}:runtime`,
      role: "assistant",
      content: "",
      sequence,
      createdAt: nowIso(),
      isStreaming: active,
    });
    targetIndex = nextMessages.length - 1;
  }
  if (targetIndex === -1) {
    targetIndex = findLastAssistantIndexAfterLastUser(nextMessages);
  }
  if (targetIndex === -1) {
    const sequence = nextMessageSequence(nextMessages);
    nextMessages.push({
      id: activeRunId ? `${activeRunId}:runtime` : generateId(),
      role: "assistant",
      content: "",
      sequence,
      createdAt: nowIso(),
      isStreaming: active,
    });
    targetIndex = nextMessages.length - 1;
  }

  nextMessages[targetIndex] = {
    ...nextMessages[targetIndex],
    isStreaming: active,
    toolCalls: mergeToolCalls(nextMessages[targetIndex].toolCalls ?? [], unassignedToolCalls),
  };
  return sortMessagesBySequence(nextMessages);
}

export function isLiveToolCall(toolCall: AIToolCall): boolean {
  return toolCall.status === "running" || toolCall.status === "awaiting_approval";
}

export function hasLiveActiveRunToolCall(
  toolCalls: AIToolCall[],
  activeRunId: string | null
): boolean {
  return toolCalls.some((toolCall) => toolCall.runId === activeRunId && isLiveToolCall(toolCall));
}

export function findActiveRuntimeAssistantIndex(
  messages: AIMessage[],
  activeRunId: string
): number {
  const runtimeIds = new Set([`${activeRunId}:draft`, `${activeRunId}:runtime`]);
  return messages.findIndex(
    (message) => message.role === "assistant" && runtimeIds.has(message.id)
  );
}

export function findActiveCommentIndex(messages: AIMessage[], activeRunId: string): number {
  return findLastIndex(
    messages,
    (message) => message.role === "assistant" && message.id.startsWith(`${activeRunId}:comment:`)
  );
}

export function mergeToolCalls(existing: AIToolCall[], incoming: AIToolCall[]): AIToolCall[] {
  const byId = new Map(existing.map((toolCall) => [toolCall.id, toolCall]));
  for (const toolCall of incoming) {
    const previous = byId.get(toolCall.id);
    byId.set(toolCall.id, {
      ...previous,
      ...toolCall,
      arguments: { ...(previous?.arguments ?? {}), ...toolCall.arguments },
    });
  }
  return [...byId.values()];
}

export function normalizeToolCallArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function patchRecentConversationFromSnapshot(
  conversations: AIConversationSummary[],
  snapshot: AIConversationRuntimeSnapshot
): AIConversationSummary[] {
  const existing = conversations.find(
    (conversation) => conversation.id === snapshot.conversation.id
  );
  const nextConversation: AIConversationSummary = {
    id: snapshot.conversation.id,
    title: snapshot.conversation.title,
    createdAt: snapshot.conversation.createdAt,
    updatedAt: snapshot.conversation.updatedAt,
    lastUserMessageAt:
      snapshot.conversation.lastUserMessageAt ??
      snapshotLastUserMessageAt(snapshot.messages) ??
      existing?.lastUserMessageAt ??
      snapshot.conversation.createdAt,
    folderId: snapshot.conversation.folderId ?? existing?.folderId ?? null,
    messageCount: snapshot.conversation.messageCount ?? snapshot.messages.length,
    status: snapshot.conversation.status ?? existing?.status ?? "active",
    blockReason: snapshot.conversation.blockReason ?? existing?.blockReason ?? null,
    activeRunStatus: snapshot.runtime.activeRun?.status ?? null,
    planStatus: snapshot.runtime.activePlan?.status ?? existing?.planStatus ?? null,
  };
  const found = Boolean(existing);
  const next = found
    ? conversations.map((conversation) =>
        conversation.id === nextConversation.id
          ? { ...conversation, ...nextConversation }
          : conversation
      )
    : [nextConversation, ...conversations];
  return sortConversationSummaries(next);
}

export function patchRecentConversationRunStatus(
  conversations: AIConversationSummary[],
  conversationId: string,
  activeRunStatus: AIConversationSummary["activeRunStatus"]
): AIConversationSummary[] {
  let changed = false;
  const nextConversations = conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    if (conversation.activeRunStatus === activeRunStatus) return conversation;
    changed = true;
    return { ...conversation, activeRunStatus };
  });
  return changed ? nextConversations : conversations;
}

export function sortConversationFolders(folders: AIConversationFolder[]): AIConversationFolder[] {
  return [...folders].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

export function sortConversationSummaries(
  conversations: AIConversationSummary[]
): AIConversationSummary[] {
  return [...conversations].sort((left, right) => {
    const rightTime = Date.parse(right.lastUserMessageAt ?? right.createdAt);
    const leftTime = Date.parse(left.lastUserMessageAt ?? left.createdAt);
    return rightTime - leftTime;
  });
}

export function snapshotLastUserMessageAt(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user") continue;
    return typeof record.createdAt === "string" ? record.createdAt : null;
  }
  return null;
}

export function findLastAssistantIndexAfterLastUser(messages: AIMessage[]): number {
  const lastUserIndex = findLastUserIndex(messages);
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    if (messages[index].role === "assistant") return index;
  }
  return -1;
}

export function findLastUserIndex(messages: AIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

export function nextMessageSequence(messages: AIMessage[]): number {
  return (
    messages.reduce(
      (max, message, index) =>
        Math.max(max, typeof message.sequence === "number" ? message.sequence : index),
      -1
    ) + 1
  );
}

export function sortMessagesBySequence(messages: AIMessage[]): AIMessage[] {
  return [...messages].sort((left, right) => {
    // A pending steer joins the transcript only at the run's next step, after everything the
    // run writes until then, so it stays below the live tool group and draft.
    if (Boolean(left.steerPending) !== Boolean(right.steerPending)) {
      return left.steerPending ? 1 : -1;
    }
    const leftSequence = typeof left.sequence === "number" ? left.sequence : messages.indexOf(left);
    const rightSequence =
      typeof right.sequence === "number" ? right.sequence : messages.indexOf(right);
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    return messages.indexOf(left) - messages.indexOf(right);
  });
}

export function isActiveRunStatus(status: string | null | undefined): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_approval" ||
    status === "waiting_for_answer" ||
    status === "waiting_for_credential" ||
    status === "waiting_for_setup"
  );
}
