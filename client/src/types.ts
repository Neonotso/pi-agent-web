// ── Pi RPC Types ────────────────────────────────────────────────────

export interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'bashExecution';
  content?: string | Array<TextContent | ToolCallContent | ThinkingContent>;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  stopped?: boolean;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

// ── RPC Command Types ───────────────────────────────────────────────

export interface RpcCommand {
  type: string;
  id?: string;
}

export interface PromptCommand extends RpcCommand {
  type: 'prompt';
  message: string;
  streamingBehavior?: 'steer' | 'followUp';
}

export interface AbortCommand extends RpcCommand {
  type: 'abort';
}

export interface GetStateCommand extends RpcCommand {
  type: 'get_state';
}

export interface GetMessagesCommand extends RpcCommand {
  type: 'get_messages';
}

export interface CompactCommand extends RpcCommand {
  type: 'compact';
  customInstructions?: string;
}

// ── RPC Response Types ──────────────────────────────────────────────

export interface RpcResponse {
  type: 'response';
  command: string;
  success: boolean;
  data?: any;
  error?: string;
  id?: string;
}

// ── WebSocket Message Types ─────────────────────────────────────────

export interface WsEvent {
  type: 'event';
  data: PiEvent;
  sessionId: string;
}

export interface WsText {
  type: 'text';
  data: string;
  sessionId: string;
}

export interface WsStderr {
  type: 'stderr';
  data: string;
  sessionId: string;
}

export interface WsError {
  type: 'error';
  data: string;
  sessionId: string;
}

export type WsMessage = WsEvent | WsText | WsStderr | WsError;

// ── Pi Event Types ──────────────────────────────────────────────────

export interface PiEvent {
  type: string;
  [key: string]: any;
}

export interface TextDeltaEvent extends PiEvent {
  type: 'message_update';
  assistantMessageEvent: {
    type: 'text_delta';
    delta: string;
    partial: any;
  };
  message: PiMessage;
}

// ── Session Types ───────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  name: string;
  active: boolean;
  messages: PiMessage[];
  createdAt: number;
}

// ── Chat Message Display Types ──────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  toolName?: string;
  toolCallId?: string;
  output?: string;
  isError?: boolean;
  timestamp: number;
  isStreaming?: boolean;
}

// ── Streaming Accumulator ───────────────────────────────────────────

export interface StreamingState {
  assistantMessageId: string | null;
  accumulatedText: string;
  toolCalls: ToolCallState[];
}

export interface ToolCallState {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}
