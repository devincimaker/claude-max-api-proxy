/**
 * Types for Claude Code CLI JSON streaming output
 * Based on research from PROTOCOL.md
 */

export interface ClaudeCliInit {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: unknown[];
  model: string;
  permissionMode: string;
  slash_commands: unknown[];
  skills: unknown[];
  plugins: unknown[];
  uuid: string;
}

export interface ClaudeCliHookStarted {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  session_id: string;
}

export interface ClaudeCliHookResponse {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  output: string;
  exit_code: number;
  outcome: "success" | "error";
}

export interface ClaudeCliAssistantTextContent {
  type: "text";
  text: string;
}

export interface ClaudeCliAssistantThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ClaudeCliAssistantRedactedThinkingContent {
  type: "redacted_thinking";
  data?: string;
}

export interface ClaudeCliAssistantToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: {
    type: string;
  };
}

export type ClaudeCliAssistantContent =
  | ClaudeCliAssistantTextContent
  | ClaudeCliAssistantThinkingContent
  | ClaudeCliAssistantRedactedThinkingContent
  | ClaudeCliAssistantToolUseContent;

export interface ClaudeCliAssistant {
  type: "assistant";
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: ClaudeCliAssistantContent[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id: string;
  uuid: string;
}

export interface ClaudeCliResult {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }>;
}

export interface ClaudeCliSystemMessage {
  type: "system";
  subtype: string;
  [key: string]: unknown;
}

export interface ClaudeCliStreamEvent {
  type: "stream_event";
  event: {
    type: "message_start" | "content_block_start" | "content_block_delta" | "content_block_stop" | "message_delta" | "message_stop";
    index?: number;
    delta?: {
      type: "text_delta";
      text: string;
    } | {
      type: "thinking_delta";
      thinking: string;
    } | {
      type: "summary_text_delta";
      text: string;
    } | {
      type: "input_json_delta";
      partial_json: string;
    } | {
      type: "signature_delta";
      signature: string;
    };
    content_block?: {
      type: "text";
      text: string;
    } | {
      type: "thinking";
      thinking: string;
      signature?: string;
    } | {
      type: "redacted_thinking";
      data?: string;
    } | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      caller?: {
        type: string;
      };
    };
    message?: {
      model: string;
      id: string;
      role: "assistant";
      content: ClaudeCliAssistantContent[];
      stop_reason: string | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
    };
  };
  session_id: string;
  uuid: string;
}

export interface ClaudeCliUserToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

export interface ClaudeCliUser {
  type: "user";
  message: {
    role: "user";
    content: ClaudeCliUserToolResultContent[];
  };
  session_id: string;
  uuid: string;
}

export type ClaudeCliMessage =
  | ClaudeCliInit
  | ClaudeCliHookStarted
  | ClaudeCliHookResponse
  | ClaudeCliAssistant
  | ClaudeCliUser
  | ClaudeCliResult
  | ClaudeCliStreamEvent
  | ClaudeCliSystemMessage;

export function isAssistantMessage(msg: ClaudeCliMessage): msg is ClaudeCliAssistant {
  return msg.type === "assistant";
}

export function isResultMessage(msg: ClaudeCliMessage): msg is ClaudeCliResult {
  return msg.type === "result";
}

export function isStreamEvent(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return msg.type === "stream_event";
}

export function isContentDelta(msg: ClaudeCliMessage): msg is ClaudeCliStreamEvent {
  return isStreamEvent(msg) && msg.event.type === "content_block_delta";
}

export function extractTextDelta(msg: ClaudeCliStreamEvent): string | null {
  const delta = msg.event.delta;
  if (!delta) return null;
  if (delta.type === "text_delta") return delta.text;
  return null;
}

export function extractThinkingDelta(msg: ClaudeCliStreamEvent): string | null {
  const delta = msg.event.delta;
  if (!delta) return null;
  if (delta.type === "thinking_delta") return delta.thinking;
  if (delta.type === "summary_text_delta") return delta.text;
  return null;
}

export function isSystemInit(msg: ClaudeCliMessage): msg is ClaudeCliInit {
  return msg.type === "system" && (msg as ClaudeCliSystemMessage).subtype === "init";
}

export function isUserMessage(msg: ClaudeCliMessage): msg is ClaudeCliUser {
  return msg.type === "user";
}
