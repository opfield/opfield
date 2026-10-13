import { isQuestionAwaitingAnswer } from "@/lib/ai-question-state";
import type {
  AIMessageAttachment,
  AIMessage as AIMessageType,
  AIResourceReference,
} from "@/types/ai";
import { AIActivityIndicator, AIMessage } from "./AIMessage";

interface AIMessageListProps {
  messages: AIMessageType[];
  assistantMaxWidthClass?: string;
  onApprove?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
  onAnswer?: (toolCallId: string, answer: string) => void;
  onEditUserMessage?: (
    messageId: string,
    content: string,
    attachments: AIMessageAttachment[]
  ) => void;
  onRetryUserMessage?: (messageId: string) => void;
  /** The user message a Retry is resending; its error line shows the retry in progress. */
  retryingMessageId?: string | null;
  retryDisabled?: boolean;
  editUserMessageDisabled?: boolean;
  resourceReferences?: AIResourceReference[];
  isStreaming?: boolean;
}

const NO_RESOURCE_REFERENCES: AIResourceReference[] = [];
export function AIMessageList({
  messages,
  assistantMaxWidthClass,
  onApprove,
  onReject,
  onAnswer,
  onEditUserMessage,
  onRetryUserMessage,
  retryingMessageId = null,
  retryDisabled,
  editUserMessageDisabled,
  resourceReferences = NO_RESOURCE_REFERENCES,
  isStreaming = false,
}: AIMessageListProps) {
  const visibleMessages = collapseConsecutiveModelChanges(messages);
  const groups = groupAssistantTurns(visibleMessages);
  const retryTargets = buildRetryTargets(visibleMessages);
  const activityLabel = runActivityLabel(visibleMessages, isStreaming);
  const lastGroup = groups.at(-1);

  const renderMessage = (message: AIMessageType, index: number) => (
    <AIMessage
      key={messageKey(message, index)}
      message={message}
      assistantMaxWidthClass={assistantMaxWidthClass}
      onApprove={onApprove}
      onReject={onReject}
      onAnswer={onAnswer}
      onEditUserMessage={onEditUserMessage}
      onRetry={
        onRetryUserMessage && retryTargets.has(message)
          ? () => onRetryUserMessage(retryTargets.get(message)!)
          : undefined
      }
      retrying={retryingMessageId !== null && retryTargets.get(message) === retryingMessageId}
      retryDisabled={retryDisabled || retryingMessageId !== null}
      editUserMessageDisabled={editUserMessageDisabled}
      resourceReferences={resourceReferences}
      suppressActivityIndicator
    />
  );
  const activityRow = activityLabel ? (
    <div
      key="ai-run-activity"
      className={`${assistantMaxWidthClass ?? "max-w-[95%]"} min-h-7`}
      data-testid="ai-run-activity"
    >
      <AIActivityIndicator label={activityLabel} />
    </div>
  ) : null;

  // A group keeps one element type for its whole life. Wrapping a bare message only while the
  // activity row shows remounted it when the reply text started, which replayed its animations.
  return (
    <>
      {groups.map((group) =>
        isWrappedGroup(group) ? (
          <div key={messageKey(group[0], 0)} className="space-y-1">
            {group.map(renderMessage)}
            {group === lastGroup && activityRow}
          </div>
        ) : (
          renderMessage(group[0], 0)
        )
      )}
      {lastGroup && !isWrappedGroup(lastGroup) && activityRow}
    </>
  );
}

/** Assistant turns always get a wrapper, so the activity row can join and leave without a remount. */
function isWrappedGroup(group: AIMessageType[]): boolean {
  return group.length > 1 || (group[0].role === "assistant" && !group[0].conversationStatus);
}

function runActivityLabel(messages: AIMessageType[], isStreaming: boolean): string | null {
  if (!isStreaming) return null;
  const toolCalls = messages.flatMap((message) => message.toolCalls ?? []);
  if (toolCalls.some(isQuestionAwaitingAnswer)) {
    return "Waiting for response";
  }
  if (
    toolCalls.some(
      (toolCall) => toolCall.name !== "ask_question" && toolCall.status === "awaiting_approval"
    )
  ) {
    return "Waiting for approval";
  }
  if (
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.isStreaming &&
        /^\*\*Error:\*\*/i.test(message.content.trim())
    )
  ) {
    return "Retrying";
  }
  const finalTextStarted = messages.some(
    (message) =>
      message.role === "assistant" &&
      message.isStreaming &&
      /:(?:runtime|draft)$/.test(message.id) &&
      message.content.trim().length > 0
  );
  return finalTextStarted ? null : "Thinking";
}

function collapseConsecutiveModelChanges(messages: AIMessageType[]): AIMessageType[] {
  return messages.filter((message, index) => {
    if (!message.modelChange) return true;

    let nextIndex = index + 1;
    while (nextIndex < messages.length && messages[nextIndex].conversationStatus) {
      nextIndex += 1;
    }
    if (messages[nextIndex]?.modelChange) return false;

    let firstChange = message.modelChange;
    let previousIndex = index - 1;
    while (previousIndex >= 0) {
      const previousMessage = messages[previousIndex];
      if (previousMessage.conversationStatus) {
        previousIndex -= 1;
        continue;
      }
      if (!previousMessage.modelChange) break;
      firstChange = previousMessage.modelChange;
      previousIndex -= 1;
    }

    if (firstChange.fromModel === message.modelChange.toModel) return false;

    return true;
  });
}

function buildRetryTargets(messages: AIMessageType[]): Map<AIMessageType, string> {
  const targets = new Map<AIMessageType, string>();
  let lastUserMessageId: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      lastUserMessageId = message.id;
      continue;
    }
    if (lastUserMessageId && message.localOnly && /^\s*\*\*Error:\*\*/i.test(message.content)) {
      targets.set(message, lastUserMessageId);
    }
  }
  return targets;
}

function groupAssistantTurns(messages: AIMessageType[]): AIMessageType[][] {
  const groups: AIMessageType[][] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.conversationStatus) {
      groups.push([message]);
      continue;
    }

    const assistantTurn: AIMessageType[] = [];
    while (index < messages.length) {
      const next = messages[index];
      if (next.role !== "assistant" || next.conversationStatus) break;
      if (!isAssistantToolOnlyMessage(next)) {
        assistantTurn.push(next);
        index += 1;
        continue;
      }

      const toolMessages = [next];
      while (index + 1 < messages.length && isAssistantToolOnlyMessage(messages[index + 1])) {
        toolMessages.push(messages[index + 1]);
        index += 1;
      }
      assistantTurn.push(mergeToolOnlyMessages(toolMessages));
      index += 1;
    }
    index -= 1;
    groups.push(assistantTurn);
  }

  return groups;
}

function mergeToolOnlyMessages(messages: AIMessageType[]): AIMessageType {
  if (messages.length === 1) return messages[0];

  const toolCalls: NonNullable<AIMessageType["toolCalls"]> = [];
  const seenToolCallIds = new Set<string>();
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (seenToolCallIds.has(toolCall.id)) continue;
      seenToolCallIds.add(toolCall.id);
      toolCalls.push(toolCall);
    }
  }

  return {
    ...messages[0],
    toolCalls,
    isStreaming: messages.some((message) => message.isStreaming),
    localOnly: messages.every((message) => message.localOnly),
  };
}

function isAssistantToolOnlyMessage(message: AIMessageType): boolean {
  return (
    message.role === "assistant" &&
    !message.content.trim() &&
    !message.attachments?.length &&
    !!message.toolCalls?.length
  );
}

function messageKey(message: AIMessageType, index: number): string {
  return message.id || `${message.role}-${index}`;
}
