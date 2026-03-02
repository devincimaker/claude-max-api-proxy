# Hermes Streaming Compatibility Guide

This document explains what must be changed in Hermes so OpenAI-compatible
`/chat/completions` endpoints stream incremental progress (reasoning + tool-call
assembly) instead of waiting for one final response.

It is based on the working patch applied to:

- `/Users/devinci/.hermes/hermes-agent/run_agent.py`

## Why this patch is needed

By default, Hermes often uses non-stream chat completions (`stream=False`) and
only gets the final assistant message. That causes:

- Long silent waits (minutes) before output appears.
- No early visibility into reasoning/progress.
- Harder interruption when the model goes in a bad direction.

Streaming fixes this by consuming chunk deltas as they arrive and building a
final response object Hermes can process normally.

## Required Hermes changes

## 1) Add a runtime toggle for streamed chat completions

In `AIAgent.__init__`, add:

- constructor arg: `stream_chat_completions: Optional[bool] = None`
- env override: `HERMES_CHAT_STREAM=true|false`
- platform default: enable on CLI by default

Reference implementation pattern:

```python
env_stream_mode = os.getenv("HERMES_CHAT_STREAM", "").strip().lower()
if stream_chat_completions is not None:
    self.stream_chat_completions = bool(stream_chat_completions)
elif env_stream_mode in {"1", "true", "yes", "on"}:
    self.stream_chat_completions = True
elif env_stream_mode in {"0", "false", "no", "off"}:
    self.stream_chat_completions = False
else:
    self.stream_chat_completions = self.platform == "cli"
```

## 2) Add helper to extract reasoning from deltas

Implement a helper that reads reasoning from any provider-compatible delta field:

- `delta.reasoning`
- `delta.reasoning_content`
- `delta.reasoning_details[*].text|summary|content`

This avoids provider-specific breakage and keeps reasoning continuity.

## 3) Add helper to flush live reasoning buffer

Implement a helper that prints buffered reasoning progressively during stream:

- flush by newline first
- then flush fixed-size chunks (for long single-line deltas)
- force flush at stream end

This is what gives the user live "thinking" feedback instead of one big dump.

## 4) Add `_stream_chat_completions_call(self, api_kwargs)`

Create a streaming path that:

1. Copies kwargs and sets `stream=True`
2. Iterates over stream chunks
3. Aggregates:
   - `content` deltas
   - reasoning deltas
   - partial `tool_calls` (id, function name, function arguments)
4. Handles interrupt (`self._interrupt_requested`) by raising `InterruptedError`
5. Closes stream in `finally`
6. Synthesizes a final response object matching what Hermes expects from
   non-stream mode:
   - `response.choices[0].message.content`
   - `response.choices[0].message.reasoning`
   - `response.choices[0].message.tool_calls`
   - `response.choices[0].finish_reason`
   - `response.model`
   - `response.usage`

Critical detail for tool calls: arguments arrive fragmented across deltas. You
must concatenate by `tool_call.index`.

## 5) Route `_interruptible_api_call` through streaming path

In `_interruptible_api_call`, use:

- codex responses path unchanged
- else if `self.stream_chat_completions`: call `_stream_chat_completions_call`
- else fall back to normal `client.chat.completions.create(**api_kwargs)`

Reference flow:

```python
if self.api_mode == "codex_responses":
    result["response"] = self._run_codex_stream(api_kwargs)
elif self.stream_chat_completions:
    result["response"] = self._stream_chat_completions_call(api_kwargs)
else:
    result["response"] = self.client.chat.completions.create(**api_kwargs)
```

## 6) Quiet mode spinner behavior

If streaming is enabled in quiet mode, suppress the old generic thinking spinner
so live streamed reasoning is not hidden behind spinner noise.

Pattern:

```python
stream_in_quiet_mode = (
    self.api_mode == "chat_completions"
    and self.stream_chat_completions
    and self.quiet_mode
)
if self.quiet_mode and not stream_in_quiet_mode:
    # start spinner
```

## 7) Preserve compatibility with existing Hermes message pipeline

The synthesized streaming response should match the attributes Hermes already
uses later in the loop. Do not force downstream refactors.

Recommended shape for each synthesized tool call:

```python
SimpleNamespace(
    id=call_id,
    function=SimpleNamespace(name=function_name, arguments=function_args),
)
```

## 8) Handle duplicate reasoning fields

Some providers send both `reasoning` and `reasoning_content` with identical text.
Deduplicate before displaying/saving to avoid repeated lines.

## Validation checklist

Run these after patching Hermes:

1. Start proxy:
   - `node dist/server/standalone.js 3456`
2. Hermes custom endpoint config:
   - Base URL: `http://127.0.0.1:3456/v1`
   - API key: any non-empty string
   - Model: `claude-sonnet-4`
3. Force streamed mode:
   - `export HERMES_CHAT_STREAM=true`
4. Prompt:
   - `Use Bash to run 'echo hi' and then explain what happened.`
5. Confirm:
   - Live `🧠` reasoning lines appear while generation is in progress
   - Final answer still includes normal tool execution flow
   - Interrupt works during stream

## Known constraints

- Hermes still expects OpenAI-compatible `chat/completions`; native Anthropic
  `/v1/messages` is a separate integration.
- If the endpoint does not emit reasoning deltas, streaming still works for
  content, but "thinking" may appear minimal.
- Tool progress display depends on what the endpoint exposes. In this proxy,
  Claude internal tool activity is surfaced via streamed `reasoning` deltas.

## Fast reapply after Hermes upgrades

If Hermes updates overwrite your patch, re-apply in this order:

1. `__init__` streaming flag + env override
2. reasoning extraction helper
3. live reasoning buffer flush helper
4. `_stream_chat_completions_call`
5. `_interruptible_api_call` branch
6. quiet-mode spinner guard

Then rerun the validation checklist above.
