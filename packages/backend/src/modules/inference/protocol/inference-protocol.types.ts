export type InferenceProtocol = 'responses' | 'chat_completions' | 'messages';
export type InferenceRole = 'system' | 'developer' | 'user' | 'assistant';
export type InferenceMessagePhase = 'commentary' | 'final_answer';

export type InferenceContentPart =
  | { type: 'text'; text: string; cacheControl?: unknown }
  | { type: 'image'; source: Record<string, unknown> }
  | { type: 'file'; source: Record<string, unknown>; cacheControl?: unknown }
  | {
      type: 'reasoning';
      id?: string;
      text: string;
      signature?: string;
      redactedData?: string;
      cacheControl?: unknown;
    }
  | {
      type: 'tool_call';
      id: string;
      callId: string;
      name: string;
      namespace?: string;
      arguments: string;
      custom?: boolean;
      cacheControl?: unknown;
    }
  | {
      type: 'tool_result';
      callId: string;
      output: string;
      isError?: boolean;
      custom?: boolean;
      cacheControl?: unknown;
    }
  | { type: 'hosted'; raw: Record<string, unknown> }
  | { type: 'compaction'; encryptedContent: string };

export interface InferenceMessage {
  role: InferenceRole;
  content: InferenceContentPart[];
  phase?: InferenceMessagePhase;
}

export interface InferenceTool {
  type: 'function' | 'custom' | 'hosted';
  name: string;
  namespace?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface InferenceRequest {
  protocol: InferenceProtocol;
  model: string;
  responseModel?: string;
  messages: InferenceMessage[];
  tools: InferenceTool[];
  toolChoice?: unknown;
  stream: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  reasoningConfig?: Record<string, unknown>;
  previousResponseId?: string;
  promptCacheKey?: string;
  providerHeaders?: Record<string, string>;
  parallelToolCalls?: boolean;
  isCompaction: boolean;
  extensions: Record<string, unknown>;
}

export interface InferenceUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export type InferenceTerminalStatus = 'completed' | 'incomplete' | 'cancelled';

export type InferenceOutputItem =
  | {
      type: 'message';
      id: string;
      role: 'assistant';
      text: string;
      phase?: InferenceMessagePhase;
      annotations?: unknown[];
      refusal?: string;
      raw?: Record<string, unknown>;
    }
  | { type: 'reasoning'; id: string; text: string; signature?: string; redactedData?: string }
  | {
      type: 'function_call';
      id: string;
      callId: string;
      name: string;
      namespace?: string;
      arguments: string;
      custom?: boolean;
    }
  | { type: 'hosted'; id: string; raw: Record<string, unknown> }
  | { type: 'compaction'; id: string; encryptedContent: string };

export type InferenceStreamEvent =
  | { type: 'output_text.delta'; itemId: string; delta: string; phase?: InferenceMessagePhase }
  | { type: 'reasoning.delta'; itemId: string; delta: string; signature?: string }
  | {
      type: 'tool_call.delta';
      itemId: string;
      callId: string;
      name: string;
      namespace?: string;
      delta: string;
      custom?: boolean;
    }
  | { type: 'item.done'; item: InferenceOutputItem }
  | {
      type: 'completed';
      usage?: Partial<InferenceUsage>;
      finishReason?: string;
      stopSequence?: string;
      status?: InferenceTerminalStatus;
      incompleteReason?: string;
    }
  | { type: 'error'; code: string; message: string; retryable?: boolean; provider?: string };

export interface InferenceExecutionContext {
  requestId: string;
  userId: string;
  tokenId: string | null;
  affinityKey?: string;
  existingThread?: boolean;
  operation?: 'inference' | 'search';
  apiUnitCharge?: { priceKey: string; units: number };
  signal: AbortSignal;
}

export interface InferenceExecution {
  responseId: string;
  resolvedModel: string;
  events: AsyncIterable<InferenceStreamEvent>;
  affinityKey?: string;
}

export interface InferenceExecutor {
  execute(request: InferenceRequest, context: InferenceExecutionContext): Promise<InferenceExecution>;
}

export interface CollectedInferenceResponse {
  responseId: string;
  model: string;
  items: InferenceOutputItem[];
  usage: InferenceUsage;
  finishReason: string;
  stopSequence?: string;
  status: InferenceTerminalStatus | 'in_progress';
  incompleteReason?: string;
  affinityKey?: string;
}
