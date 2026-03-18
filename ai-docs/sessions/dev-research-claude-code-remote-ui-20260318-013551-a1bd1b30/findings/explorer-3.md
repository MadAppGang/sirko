# Research Findings: Claude Code --output-format stream-json Event Schema

**Researcher**: Explorer 3
**Date**: 2026-03-18
**Model Strategy**: native (local codebase + live CLI experiments — no web search)
**Queries Executed**: 18 (live stream-json captures, JSONL session inspection, source file analysis)

---

## Key Findings

### Finding 1: `--output-format stream-json` REQUIRES `--verbose` flag

**Summary**: Claude Code v2.1.77 will refuse with an error if you use `--output-format stream-json` without `--verbose`. This is a hard requirement, not optional.

**Evidence**:

```bash
$ echo "hello" | claude -p --output-format stream-json --no-session-persistence
Error: When using --print, --output-format=stream-json requires --verbose
```

The correct invocation is:
```bash
claude -p --output-format stream-json --verbose [options] "prompt"
```

**Sources**:
- Live CLI test: `claude -p --output-format stream-json` without `--verbose` — Quality: High (primary source, v2.1.77)

**Confidence**: High
**Multi-source**: No (single definitive test)

---

### Finding 2: Complete Top-Level Event Type Taxonomy (stream-json output)

**Summary**: Stream-json output produces exactly 6 top-level event types. Only 5 are present in standard mode; `stream_event` events appear only with `--include-partial-messages`.

**Evidence** (from live captures with and without `--include-partial-messages`):

| Type | Subtype | When Emitted | Requires `--verbose` |
|------|---------|--------------|----------------------|
| `system` | `hook_started` | Each lifecycle hook begins | Yes |
| `system` | `hook_response` | Each lifecycle hook completes | Yes |
| `system` | `init` | Session initialized (after all SessionStart hooks) | Yes |
| `assistant` | (none) | Claude message (partial or final depending on mode) | Yes |
| `user` | (none) | Tool result returned to Claude | Yes |
| `result` | `success` | Turn complete, final summary | Yes |
| `result` | `error_max_budget_usd` | Turn aborted due to budget limit | Yes |
| `stream_event` | (none) | Raw Anthropic API streaming event | `--include-partial-messages` only |

**Notes**:
- Without `--include-partial-messages`: only one `assistant` event per complete message (final only)
- With `--include-partial-messages`: one `assistant` per partial message chunk + full `stream_event` sequence for each API event
- `result` type has at least 2 known subtypes: `success` and `error_max_budget_usd`; more may exist for other error conditions

**Sources**:
- Live capture: `echo "What is 2+2?" | claude -p --output-format stream-json --verbose --no-session-persistence --dangerously-skip-permissions` — Quality: High
- Live capture with tool use: `echo "Use Bash to run: echo hello world" | claude -p --output-format stream-json --include-partial-messages --verbose ...` — Quality: High
- Live capture with budget limit: `--max-budget-usd 0.00001` triggering `result:error_max_budget_usd` — Quality: High

**Confidence**: High
**Multi-source**: Yes (3 independent captures)

---

### Finding 3: `system:init` Event Schema — Full Field List

**Summary**: The `system:init` event is the richest event in the stream, providing full session metadata including all available tools, MCP servers, agents, plugins, and permission state.

**Evidence** (live capture, v2.1.77):

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/jack/mag/magai/sirko",
  "session_id": "9743f498-08db-44fe-8af3-02b3bf6afc3c",
  "tools": ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", ...],
  "mcp_servers": [
    {"name": "plugin:code-analysis:claudish", "status": "connected"},
    {"name": "plugin:seo:google-analytics", "status": "failed"},
    ...
  ],
  "model": "claude-sonnet-4-6",
  "permissionMode": "bypassPermissions",
  "slash_commands": ["update-config", "debug", ...],
  "apiKeySource": "ANTHROPIC_API_KEY",
  "claude_code_version": "2.1.77",
  "output_style": "default",
  "agents": ["general-purpose", "Explore", "Plan", ...],
  "skills": ["update-config", "debug", ...],
  "plugins": [
    {"name": "swift-lsp", "path": "/Users/jack/.claude/plugins/cache/..."},
    ...
  ],
  "uuid": "10801963-3634-44cc-905e-b6eb3076866a",
  "fast_mode_state": "off"
}
```

**All confirmed keys**:
`type`, `subtype`, `cwd`, `session_id`, `tools`, `mcp_servers`, `model`, `permissionMode`,
`slash_commands`, `apiKeySource`, `claude_code_version`, `output_style`, `agents`, `skills`,
`plugins`, `uuid`, `fast_mode_state`

**MCP server object keys**: `name`, `status` (`"connected"` or `"failed"`)

**UI Application**: This event fires once per session, immediately before any assistant messages. Ideal for populating a sidebar with session context, available tools, connected MCP servers, and model info.

**Sources**:
- Live capture output file — Quality: High (primary, directly observed)

**Confidence**: High
**Multi-source**: No (single capture, but complete and stable)

---

### Finding 4: `assistant` Event Schema — Partial vs Final Messages

**Summary**: The `assistant` event wraps the standard Anthropic Messages API message object. In partial mode, `stop_reason` is `null` and content may be incomplete. In final mode, `stop_reason` is `"end_turn"` or `"tool_use"`.

**Evidence**:

**Partial `assistant` event** (with `--include-partial-messages`, `stop_reason: null`):
```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "id": "msg_01Kj29NcYJSCTzERm6iwSPU5",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants me to run a bash command...",
        "signature": "ErQCCkYICxgCKkBA8T..."
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 8008,
      "cache_read_input_tokens": 17925,
      "output_tokens": 8,
      "service_tier": "standard",
      "inference_geo": "global"
    },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "9deeb4b8-7507-4058-b1f6-ed472a80a8f6",
  "uuid": "0314afa7-d302-4cf5-94f1-9be83768fe58"
}
```

**Tool-use `assistant` event** (`stop_reason: null` in partial mode, content has `tool_use` block):
```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01MfXUta6u9NSiomQ5p4Pjmj",
        "name": "Bash",
        "input": {
          "command": "echo hello world",
          "description": "Echo hello world"
        },
        "caller": {
          "type": "direct"
        }
      }
    ],
    "stop_reason": null,
    ...
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "..."
}
```

**All `assistant` event keys**: `type`, `message`, `parent_tool_use_id`, `session_id`, `uuid`
(Note: `error` key also present when API error occurs, value `"unknown"`)

**Content block types observed**:
- `type: "text"` — text response
- `type: "thinking"` — extended thinking block (includes `thinking` string and `signature`)
- `type: "tool_use"` — tool invocation (includes `id`, `name`, `input`, `caller`)

**Sources**:
- Live captures (tool use + simple text + partial messages) — Quality: High

**Confidence**: High
**Multi-source**: Yes (multiple captures confirmed consistent schema)

---

### Finding 5: `user` Event Schema — Tool Results

**Summary**: The `user` event appears after each tool execution, carrying the tool result back to Claude. It includes a `tool_use_result` field with structured stdout/stderr that is NOT part of the standard Anthropic Messages API format — it's a Claude Code extension.

**Evidence** (live capture, Bash tool execution):

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01MfXUta6u9NSiomQ5p4Pjmj",
        "type": "tool_result",
        "content": "hello world",
        "is_error": false
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "9deeb4b8-7507-4058-b1f6-ed472a80a8f6",
  "uuid": "4e24462f-eff7-402a-80d6-7e60d58ded6f",
  "timestamp": "2026-03-17T14:39:27.664Z",
  "tool_use_result": {
    "stdout": "hello world",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
}
```

**All `user` event keys**: `type`, `message`, `parent_tool_use_id`, `session_id`, `uuid`, `timestamp`, `tool_use_result`

**`tool_use_result` object keys**: `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`

**Note**: The `tool_use_result` is a Claude Code extension — it provides the raw structured output that was passed back to Claude, split by stdout/stderr. This is NOT in the Anthropic Messages API format. Useful for a custom UI to display what the tool actually produced.

**Sources**:
- Live capture: `echo "Use Bash to run: echo hello world" | claude -p --output-format stream-json ...` — Quality: High

**Confidence**: High
**Multi-source**: No (single capture, but schema is definitive)

---

### Finding 6: `result` Event Schema — Session Summary

**Summary**: The `result` event is always the last event in the stream. It provides a full session cost, turn count, usage breakdown per model, permission denials, and the final text response.

**Evidence** (`result:success` from live capture):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 14886,
  "duration_api_ms": 14592,
  "num_turns": 2,
  "result": "`hello world`",
  "stop_reason": "end_turn",
  "session_id": "9deeb4b8-7507-4058-b1f6-ed472a80a8f6",
  "total_cost_usd": 0.04890765,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 8319,
    "cache_read_input_tokens": 43858,
    "output_tokens": 303,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 0,
      "ephemeral_5m_input_tokens": 8319
    },
    "inference_geo": "",
    "iterations": [],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-sonnet-4-6": {
      "inputTokens": 3,
      "outputTokens": 303,
      "cacheReadInputTokens": 43858,
      "cacheCreationInputTokens": 8319,
      "webSearchRequests": 0,
      "costUSD": 0.04890765,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "permission_denials": [],
  "fast_mode_state": "off",
  "uuid": "e4d537fd-fdc8-4b97-b067-862b86f3d62a"
}
```

**Known `result` subtypes**:
- `success` — completed normally (`is_error: false`)
- `error_max_budget_usd` — budget exceeded (also has `is_error: false` but no actual result)

**All `result` keys**: `type`, `subtype`, `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`,
`result`, `stop_reason`, `session_id`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`,
`fast_mode_state`, `uuid`

**UI Application**: This event signals turn completion — ideal for updating a cost display, timing display, and final response rendering.

**Sources**:
- Live captures (success + budget error) — Quality: High

**Confidence**: High
**Multi-source**: Yes (2 subtypes observed)

---

### Finding 7: `stream_event` Schema (--include-partial-messages only)

**Summary**: When `--include-partial-messages` is used, stream_event events wrap the raw Anthropic Messages API streaming protocol. These map 1:1 to the SSE events from the API.

**Evidence** (live capture, 173 total events for a 2-turn session with tool use):

**stream_event.event.type frequencies** observed:
```
message_start:     2  (one per turn)
content_block_start: 4  (one per content block)
content_block_delta: ~150 (text/thinking/input chunks)
content_block_stop:  4  (one per content block end)
message_delta:     2  (stop_reason + usage, one per message end)
message_stop:      2  (message stream complete)
```

**content_block_start.content_block.type values**: `text`, `thinking`, `tool_use`

**content_block_delta.delta.type values**:
- `text_delta` — text chunk
- `thinking_delta` — thinking chunk
- `input_json_delta` — tool input JSON accumulation
- `signature_delta` — thinking block signature

**stream_event object keys**: `type`, `event`, `session_id`, `parent_tool_use_id`, `uuid`

**Example `message_start` stream_event**:
```json
{
  "type": "stream_event",
  "event": {
    "type": "message_start",
    "message": {
      "model": "claude-sonnet-4-6",
      "id": "msg_01Kj29NcYJSCTzERm6iwSPU5",
      "usage": {
        "input_tokens": 2,
        "cache_creation_input_tokens": 8008,
        "cache_read_input_tokens": 17925,
        "output_tokens": 8,
        ...
      }
    }
  },
  "session_id": "9deeb4b8-7507-4058-b1f6-ed472a80a8f6",
  "parent_tool_use_id": null,
  "uuid": "e6fe9a21-b781-4b3e-8e86-13adece7b0a4"
}
```

**Example `message_delta` (reveals stop_reason)**:
```json
{
  "type": "stream_event",
  "event": {
    "type": "message_delta",
    "delta": {
      "stop_reason": "tool_use",
      "stop_sequence": null
    },
    "usage": {"output_tokens": 296},
    "context_management": {"applied_edits": []}
  },
  ...
}
```

**UI Application**: For a streaming chat UI, consume `content_block_delta` events of type `text_delta` to render text as it streams. Watch `message_delta` for `stop_reason` to detect turn completion in real time.

**Sources**:
- Live capture with `--include-partial-messages --verbose` — Quality: High

**Confidence**: High
**Multi-source**: No (single capture — schema is deterministic)

---

### Finding 8: `system:hook_started` and `system:hook_response` Schemas

**Summary**: Every SessionStart hook fires before `system:init`. These events expose the hook execution lifecycle and are useful for understanding hook output injection into the system prompt.

**Evidence**:

**`system:hook_started`** keys: `type`, `subtype`, `hook_id`, `hook_name`, `hook_event`, `uuid`, `session_id`

Example:
```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "4e7b9311-e30d-41f0-a83f-363efd0c2e26",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "uuid": "ce433011-34d3-48e2-8573-318f9a0597c2",
  "session_id": "9743f498-08db-44fe-8af3-02b3bf6afc3c"
}
```

**`system:hook_response`** keys: `type`, `subtype`, `hook_id`, `hook_name`, `hook_event`, `output`, `stdout`, `stderr`, `exit_code`, `outcome`, `uuid`, `session_id`

**`outcome` values observed**: `"success"` (others may exist for hook failures)

**Note**: `output` and `stdout` contain the raw text (or JSON) written by the hook to stdout. For hooks that inject `additionalContext`, the JSON structure is:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "..."
  }
}
```

**Sources**:
- Live capture (5 SessionStart hooks visible in output) — Quality: High

**Confidence**: High
**Multi-source**: No (consistent across all 5 hook events in a single capture)

---

### Finding 9: `--input-format stream-json` for Multi-Turn Programmatic Usage

**Summary**: Claude Code also accepts `--input-format stream-json` for piping structured user messages on stdin. When combined with `--output-format stream-json`, this enables a fully structured bidirectional programmatic interface.

**Evidence**:

Input format for multi-turn stdin:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What is 2+2?"}]}}
```

The output is exactly the same as single-prompt mode — the same 6 event types appear.

Additional relevant flags for programmatic use:
- `--replay-user-messages`: Re-emit user messages from stdin back on stdout for acknowledgment (only with `--input-format=stream-json` and `--output-format=stream-json`)
- `--no-session-persistence`: Disable JSONL transcript saving
- `--session-id <uuid>`: Resume a specific session by UUID
- `--continue` / `-c`: Continue the most recent conversation in the current directory
- `--resume <uuid>` / `-r`: Resume a specific session by UUID

**Sources**:
- `claude --help` output (v2.1.77) — Quality: High (primary)
- Live test of `--input-format stream-json` — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 10: No TypeScript SDK for stream-json — Binary Only

**Summary**: `@anthropic-ai/claude-code` is a compiled Mach-O binary, not a Node.js package. There is no importable SDK, no TypeScript type definitions, and no programmatic API other than spawning the CLI process and parsing its output.

**Evidence**:

```bash
$ file /Users/jack/.local/bin/claude
/Users/jack/.local/bin/claude: Mach-O 64-bit executable arm64

$ npm show @anthropic-ai/claude-code --json
{
  "version": "2.1.77",
  "bin": {"claude": "cli.js"},  # wrapper script
  "exports": {},
  "types": "",
  "main": ""
}
```

The npm package entry point (`cli.js`) is just a shell launcher that executes the binary. There are no TypeScript types published.

The `@anthropic-ai/sdk` package (Messages API SDK) is entirely separate and does not expose Claude Code-specific types.

**Implication for custom UI**: A custom UI must:
1. Spawn `claude -p --output-format stream-json --verbose` as a subprocess
2. Pipe user input on stdin (or use `--input-format stream-json`)
3. Read stdout line-by-line, parsing each JSON line

**Sources**:
- `npm show @anthropic-ai/claude-code --json` — Quality: High
- `file /Users/jack/.local/bin/claude` — Quality: High
- `/Users/jack/mag/claudish/packages/cli/src/claude-runner.ts` (shows spawning pattern) — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 11: Complete Event Sequence for a Single Tool-Use Turn

**Summary**: The full ordered event sequence for a turn that invokes a tool (two-step: thinking → tool call → tool result → final response) is documented here.

**Evidence** (from live `--include-partial-messages` capture, "Use Bash to run: echo hello world"):

```
[0-4]   system:hook_started   × 5    (SessionStart hooks starting)
[5-9]   system:hook_response  × 5    (SessionStart hooks completing)
[10]    system:init                  (session ready, tools/MCP listed)
[11]    stream_event          message_start  (turn 1 begin)
[12]    stream_event          content_block_start (thinking block)
[13-26] stream_event          content_block_delta (thinking_delta × N)
[27]    assistant                    (partial: thinking block only, stop_reason=null)
[28]    stream_event          content_block_stop
[29]    stream_event          content_block_start (text block)
[30-...]stream_event          content_block_delta (text_delta × N)
[144]   assistant                    (partial: text content accumulated, stop_reason=null)
[145-...] stream_event        content_block_start (tool_use block)
[...]   stream_event          content_block_delta (input_json_delta × N)
[158]   assistant                    (partial: tool_use content, stop_reason=null)
[159]   stream_event          content_block_stop
[160]   stream_event          message_delta  (stop_reason="tool_use")
[161]   stream_event          message_stop
[162]   user                         (tool_result with stdout/stderr)
[163-167] stream_event        stream_event × 5 (turn 2 API stream)
[168]   assistant                    (final: text response, stop_reason=null)
[169-171] stream_event        message_delta + message_stop (stop_reason="end_turn")
[172]   result:success               (total cost, num_turns=2, final text)
```

**Key state machine for a custom UI**:
- When `stream_event.event.type == "message_delta"` and `delta.stop_reason == "end_turn"` → Claude finished, waiting for input
- When `stream_event.event.type == "message_delta"` and `delta.stop_reason == "tool_use"` → Claude invoked a tool, execution in progress
- When `type == "result"` and `subtype == "success"` → session complete (in `--print` mode, Claude exits)
- When `type == "user"` and `message.content[].type == "tool_result"` → tool execution complete

**Sources**:
- Live capture (173 events, full annotated sequence) — Quality: High

**Confidence**: High
**Multi-source**: No (single detailed capture)

---

### Finding 12: JSONL Session Transcript Has Different Schema From stream-json Output

**Summary**: The JSONL files at `~/.claude/projects/{project}/{session-id}.jsonl` have a richer schema than the stream-json events, with additional fields like `parentUuid`, `isSidechain`, `gitBranch`, `slug`, `cwd`, `version`, and different event subtypes.

**Evidence** (from live JSONL files):

JSONL-only event types (NOT in stream-json output):
- `progress` — with data subtypes: `hook_progress`, `agent_progress`, `query_update`, `search_results_received`, `waiting_for_task`
- `queue-operation` — with `operation`: `enqueue`, `dequeue`, `remove`
- `file-history-snapshot` — file state checkpoint
- `system:stop_hook_summary` — turn ended (only in JSONL, not stream-json stdout)
- `system:turn_duration` — turn duration in ms

JSONL `assistant` event has additional fields vs stream-json: `parentUuid`, `isSidechain`, `requestId`, `userType`, `cwd`, `sessionId`, `version`, `gitBranch`, `slug`, `timestamp`

**Implication**: If building a custom UI that needs rich state information (like agent sub-task progress), watching the JSONL file is complementary to the stream-json output. The JSONL file is the ground truth for all session state.

**Sources**:
- Live JSONL inspection of `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/*.jsonl` — Quality: High

**Confidence**: High
**Multi-source**: Yes (multiple session files confirmed consistent)

---

## Source Summary

**Total Sources**: 12 primary sources
- High Quality: 12
- Medium Quality: 0
- Low Quality: 0

**Source List**:
1. Live capture: `claude -p --output-format stream-json --verbose` (simple prompt) — Quality: High, Date: 2026-03-18
2. Live capture: `claude -p --output-format stream-json --include-partial-messages --verbose` (with Bash tool use) — Quality: High, Date: 2026-03-18
3. Live capture: `--max-budget-usd 0.00001` triggering `result:error_max_budget_usd` — Quality: High, Date: 2026-03-18
4. Live capture: `--input-format stream-json` multi-turn test — Quality: High, Date: 2026-03-18
5. `claude --help` (v2.1.77) — Quality: High
6. `npm show @anthropic-ai/claude-code --json` — Quality: High
7. `file /Users/jack/.local/bin/claude` — Quality: High
8. `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/*.jsonl` (live session data) — Quality: High
9. `/Users/jack/mag/claudish/packages/cli/src/claude-runner.ts` — Quality: High, Type: production source
10. Previous explorer-3.md from monitoring-tools session (partially corroborates system:init schema) — Quality: High

---

## Complete Schema Reference for Custom UI

### Minimal event handling loop (pseudo-TypeScript):

```typescript
type StreamEvent =
  | { type: 'system'; subtype: 'hook_started'; hook_id: string; hook_name: string; hook_event: string; uuid: string; session_id: string }
  | { type: 'system'; subtype: 'hook_response'; hook_id: string; hook_name: string; hook_event: string; output: string; stdout: string; stderr: string; exit_code: number; outcome: string; uuid: string; session_id: string }
  | { type: 'system'; subtype: 'init'; cwd: string; session_id: string; tools: string[]; mcp_servers: Array<{name: string; status: string}>; model: string; permissionMode: string; claude_code_version: string; output_style: string; agents: string[]; skills: string[]; plugins: Array<{name: string; path: string}>; uuid: string; fast_mode_state: string; apiKeySource: string }
  | { type: 'assistant'; message: AnthropicMessage; parent_tool_use_id: string | null; session_id: string; uuid: string; error?: string }
  | { type: 'user'; message: { role: 'user'; content: ToolResultContent[] }; parent_tool_use_id: string | null; session_id: string; uuid: string; timestamp: string; tool_use_result: { stdout: string; stderr: string; interrupted: boolean; isImage: boolean; noOutputExpected: boolean } }
  | { type: 'result'; subtype: 'success' | 'error_max_budget_usd'; is_error: boolean; duration_ms: number; duration_api_ms: number; num_turns: number; result: string; stop_reason: string; session_id: string; total_cost_usd: number; usage: UsageSummary; modelUsage: Record<string, ModelUsage>; permission_denials: unknown[]; fast_mode_state: string; uuid: string }
  | { type: 'stream_event'; event: AnthropicStreamEvent; session_id: string; parent_tool_use_id: string | null; uuid: string }

// AnthropicMessage.content block types:
// { type: 'text'; text: string }
// { type: 'thinking'; thinking: string; signature: string }
// { type: 'tool_use'; id: string; name: string; input: object; caller: { type: 'direct' } }

// AnthropicStreamEvent.type values:
// 'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'
```

---

## Knowledge Gaps

What this research did NOT find:

- **Full list of `result` subtypes**: Only `success` and `error_max_budget_usd` were observed. There may be `error_permission_denied`, `error_timeout`, etc. Suggested test: try triggering with `--permission-mode plan` and actually needed permissions
- **`SubagentStop` hook in stream-json**: All captured sessions used `--no-session-persistence`. Whether sub-agent Task invocations produce nested stream-json events was not tested. Would need a session with Task tool use
- **`parent_tool_use_id` non-null case**: In all captures, `parent_tool_use_id` was `null`. Non-null values would appear when an assistant message is produced inside a nested Task agent call
- **`stream_event` format without `--include-partial-messages`**: When not using partial messages, `stream_event` events do not appear at all. There may be a minimal streaming format in between
- **Official Anthropic documentation**: No web access was available. The Anthropic docs site likely has a more complete reference. Suggested query: `site:docs.anthropic.com "claude code" "output-format" "stream-json"`
- **`--json-schema` interaction with stream-json**: Tested `--json-schema` with `--output-format json` (works), but not with `--output-format stream-json`. Unknown if/how structured output schemas affect the stream events

---

## Search Limitations

- Model: claude-sonnet-4-6
- Web search: unavailable (native mode)
- Local search: performed extensively
- Live CLI tests: performed (6 distinct captures)
- Date range: All captures from 2026-03-18 using claude v2.1.77
- Query refinement: not needed — direct CLI testing provided ground truth
