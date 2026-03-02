/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  extractThinkingContent,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type {
  ClaudeCliAssistant,
  ClaudeCliMessage,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
  ClaudeCliUser,
} from "../types/claude-cli.js";
import { extractTextDelta, extractThinkingDelta, isUserMessage } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    const activeToolCalls = new Map<number, {
      id: string;
      name: string;
      initialInput: Record<string, unknown>;
      inputChunks: string[];
      sawInputDelta: boolean;
    }>();

    const writeChunk = (text?: string, reasoning?: string): void => {
      if ((!text && !reasoning) || res.writableEnded) {
        return;
      }

      const chunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: lastModel,
        choices: [{
          index: 0,
          delta: {
            role: isFirst ? "assistant" : undefined,
            content: text || undefined,
            reasoning: reasoning || undefined,
            reasoning_content: reasoning || undefined,
          },
          finish_reason: null,
        }],
      };

      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      isFirst = false;
    };

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = extractTextDelta(event);
      const reasoning = extractThinkingDelta(event);

      writeChunk(text || undefined, reasoning || undefined);
    });

    // Surface Claude internal tool activity as reasoning so clients can display progress.
    subprocess.on("message", (message: ClaudeCliMessage) => {
      if (message.type === "stream_event") {
        const event = message.event;

        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use" &&
          typeof event.index === "number"
        ) {
          activeToolCalls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            initialInput: event.content_block.input || {},
            inputChunks: [],
            sawInputDelta: false,
          });
          writeChunk(undefined, `\n[claude tool:start] ${event.content_block.name} (${event.content_block.id})\n`);
          return;
        }

        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "input_json_delta" &&
          typeof event.index === "number"
        ) {
          const state = activeToolCalls.get(event.index);
          if (state) {
            state.inputChunks.push(event.delta.partial_json);
            if (!state.sawInputDelta && event.delta.partial_json.trim()) {
              state.sawInputDelta = true;
              writeChunk(undefined, `[claude tool:args] ${state.name} building input...\n`);
            }
          }
          return;
        }

        if (event.type === "content_block_stop" && typeof event.index === "number") {
          const state = activeToolCalls.get(event.index);
          if (state) {
            const renderedInput = renderToolInput(state.initialInput, state.inputChunks);
            writeChunk(undefined, `[claude tool:call] ${state.name} ${renderedInput}\n`);
            activeToolCalls.delete(event.index);
          }
        }
        return;
      }

      if (isUserMessage(message)) {
        for (const item of message.message.content) {
          const snippet = truncateToolText(item.content);
          const label = item.is_error ? "tool error" : "tool result";
          writeChunk(undefined, `[claude ${label}] ${item.tool_use_id}: ${snippet}\n`);
        }
      }
    });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (_result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        // Send final done chunk with finish_reason
        const doneChunk = createDoneChunk(requestId, lastModel);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    const reasoningParts: string[] = [];

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      const reasoning = extractThinkingContent(message);
      if (reasoning) {
        reasoningParts.push(reasoning);
      }

      for (const content of message.message.content) {
        if (content.type !== "tool_use") {
          continue;
        }
        reasoningParts.push(
          `[claude tool:call] ${content.name} ${safeJson(content.input)}`
        );
      }
    });

    subprocess.on("message", (message: ClaudeCliMessage) => {
      if (!isUserMessage(message)) {
        return;
      }

      appendUserToolResults(reasoningParts, message);
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        const combinedReasoning = reasoningParts.join("\n\n");
        res.json(cliResultToOpenai(finalResult, requestId, combinedReasoning));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function renderToolInput(
  initialInput: Record<string, unknown>,
  inputChunks: string[]
): string {
  const rawInput = inputChunks.join("");
  if (rawInput.trim()) {
    try {
      return JSON.stringify(JSON.parse(rawInput));
    } catch {
      return rawInput;
    }
  }
  return safeJson(initialInput);
}

function truncateToolText(value: string, maxLength: number = 280): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength)}...`;
}

function appendUserToolResults(target: string[], message: ClaudeCliUser): void {
  for (const content of message.message.content) {
    const label = content.is_error ? "tool error" : "tool result";
    target.push(`[claude ${label}] ${content.tool_use_id}: ${truncateToolText(content.content)}`);
  }
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-opus-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-sonnet-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-haiku-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
