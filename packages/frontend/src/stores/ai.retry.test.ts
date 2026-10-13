import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rollbackConversationToMessage } from "@/services/ai-conversations";
import type { AIConversationRuntimeSnapshot, AIMessage, AIRunToolCall } from "@/types/ai";
import { aiWebSocketState, useAIStore } from "./ai";
import { projectConversationSnapshot } from "./ai.store-runtime";

vi.mock("@/services/ai-conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai-conversations")>()),
  rollbackConversationToMessage: vi.fn(),
}));

const CONVERSATION_ID = "0b6f3f9e-58f3-4f0e-9a51-3f1d2a0c1a10";
const USER_MESSAGE_ID = "6c1d7e52-1f0a-4b8e-8f52-0d9a1b2c3d4e";
const PROMPT = "Remove the unused images on every node";

function toolCall(toolCallId: string, assistantMessageId: string): AIRunToolCall {
  return {
    id: `row-${toolCallId}`,
    runId: "run-1",
    conversationId: CONVERSATION_ID,
    assistantMessageId,
    toolCallId,
    toolName: "list_docker_images",
    toolArgs: {},
    classification: "read",
    approvalPolicy: "auto_approved",
    requiredScopes: [],
    status: "completed",
    decision: null,
    result: null,
    error: null,
  };
}

// The stored transcript after a run used tools for several model calls and then failed on a provider 5xx.
function failedRunSnapshot(): AIConversationRuntimeSnapshot {
  return {
    conversation: {
      id: CONVERSATION_ID,
      title: "Image cleanup",
      createdAt: "2026-10-13T21:19:40.000Z",
      updatedAt: "2026-10-13T21:23:56.000Z",
      lastContext: null,
      discoveredToolsets: [],
      checkpoint: null,
    },
    messages: [
      {
        id: USER_MESSAGE_ID,
        sequence: 0,
        role: "user",
        content: PROMPT,
        clientCommandId: "command-1",
      },
      { id: "boundary-1", sequence: 1, role: "assistant", content: "", toolGroupBoundary: true },
      { id: "boundary-2", sequence: 2, role: "assistant", content: "", toolGroupBoundary: true },
      {
        id: "error-1",
        sequence: 3,
        role: "assistant",
        content: "**Error:** Anthropic returned a server error. Opfield tried 3 times.",
        localOnly: true,
        runError: true,
        runId: "run-1",
      },
    ],
    runtime: {
      activeRun: null,
      assistantDraftContent: null,
      assistantDraftVersion: null,
      pendingApprovals: [],
      pendingQuestion: null,
      pendingQuestions: [],
      toolCalls: [toolCall("call-1", "boundary-1"), toolCall("call-2", "boundary-2")],
      pendingInputs: [],
    },
  } as unknown as AIConversationRuntimeSnapshot;
}

// What the page holds right after the user sent the prompt: the optimistic message keyed by its command.
const optimisticUser: AIMessage = {
  id: "starting:command-1:user",
  role: "user",
  content: PROMPT,
  clientCommandId: "command-1",
  localOnly: true,
};

const send = vi.fn();

beforeEach(() => {
  aiWebSocketState.client = { send } as never;
  const projection = projectConversationSnapshot(failedRunSnapshot(), [optimisticUser]);
  useAIStore.setState({ ...projection, retryingMessageId: null });
});

afterEach(() => {
  aiWebSocketState.client = null;
  send.mockReset();
  vi.mocked(rollbackConversationToMessage).mockReset();
});

describe("Retry after a failed run", () => {
  it("keeps the optimistic key for rendering and remembers the stored id", () => {
    const state = useAIStore.getState();
    const user = state.messages.find((message) => message.role === "user");
    expect(user).toMatchObject({ id: "starting:command-1:user", serverId: USER_MESSAGE_ID });
    expect(state.isStreaming).toBe(false);
  });

  it("returns to the stored message and sends the prompt again", async () => {
    vi.mocked(rollbackConversationToMessage).mockResolvedValue({
      message: { id: USER_MESSAGE_ID, role: "user", content: PROMPT, attachments: [] },
      conversation: {
        id: CONVERSATION_ID,
        title: "Image cleanup",
        messages: [{ id: USER_MESSAGE_ID, sequence: 0, role: "user", content: PROMPT }],
        createdAt: "2026-10-13T21:19:40.000Z",
        updatedAt: "2026-10-13T21:24:10.000Z",
      },
    } as never);

    await useAIStore.getState().retryMessage("starting:command-1:user");

    expect(rollbackConversationToMessage).toHaveBeenCalledWith(CONVERSATION_ID, USER_MESSAGE_ID);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conversation.send_message",
        conversationId: CONVERSATION_ID,
        content: PROMPT,
      })
    );
    const state = useAIStore.getState();
    expect(state.isStreaming).toBe(true);
    expect(state.retryingMessageId).toBeNull();
    expect(state.messages.some((message) => message.content.startsWith("**Error:**"))).toBe(false);
  });

  it("reports a failed rollback instead of doing nothing", async () => {
    vi.mocked(rollbackConversationToMessage).mockRejectedValue(
      new Error("Conversation message not found")
    );

    await expect(useAIStore.getState().retryMessage("starting:command-1:user")).rejects.toThrow(
      "Conversation message not found"
    );
    expect(send).not.toHaveBeenCalled();
    expect(useAIStore.getState().retryingMessageId).toBeNull();
  });

  it("says why when the message is not stored yet", async () => {
    useAIStore.setState({ messages: [optimisticUser] });

    await expect(useAIStore.getState().retryMessage("starting:command-1:user")).rejects.toThrow(
      "not saved yet"
    );
    expect(rollbackConversationToMessage).not.toHaveBeenCalled();
  });

  it("says why while the assistant is still running", async () => {
    useAIStore.setState({ isStreaming: true });

    await expect(useAIStore.getState().retryMessage("starting:command-1:user")).rejects.toThrow(
      "still working"
    );
    expect(rollbackConversationToMessage).not.toHaveBeenCalled();
  });
});
