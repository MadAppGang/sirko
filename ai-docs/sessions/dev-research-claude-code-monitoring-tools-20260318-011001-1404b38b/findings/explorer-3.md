# Research Findings: Claude Code Internal Architecture for Programmatic State Detection

**Researcher**: Explorer 3
**Date**: 2026-03-18T01:10:00Z
**Model Strategy**: native (local investigation)
**Queries Executed**: 25+ local searches across codebase, config files, JSONL transcripts, and Claude Code binary

---

## Key Findings

### Finding 1: Claude Code Hooks System — 8 Hook Types, Stop Fires When Awaiting Input

**Summary**: Claude Code has 8 lifecycle hook types including a `Stop` hook that fires after every completed turn (when Claude finishes responding and is waiting for the user), and a `SubagentStop` hook that fires when a sub-agent completes.

**Evidence**:

The hooks system (confirmed from `/Users/jack/mag/claude-code/plugins/multimodel/skills/hooks-system/SKILL.md`) documents 8 hook types:

| Hook Type | When It Fires | Can Detect Waiting? |
|-----------|---------------|---------------------|
| `PreToolUse` | Before tool execution | No (fires during active work) |
| `PostToolUse` | After tool completion | No (fires during active work) |
| `UserPromptSubmit` | User submits prompt | No (fires at start of turn) |
| `SessionStart` | Session begins | No |
| **`Stop`** | **Main session turn ends** | **YES — fires when Claude is waiting for user input** |
| **`SubagentStop`** | **Sub-agent (Task) completes** | **YES — fires when spawned agent finishes** |
| `Notification` | System notification | Partial |
| `PermissionRequest` | Tool needs permission | No |

**The `Stop` hook is the primary mechanism for detecting when Claude Code is waiting for user input.** It fires after every completed Claude turn.

**Hook Input Format** (received via stdin as JSON):
```json
{
  "session_id": "test-session-123",
  "transcript_path": "/path/to/session.jsonl",
  "cwd": "/Users/jack/project"
}
```

Confirmed from: `/Users/jack/mag/claude-code/docs/plans/2026-02-28-dev-loop-e2e-tests.md`:
```bash
# Stop hook receives JSON on stdin with session_id, transcript_path, cwd
hook_input=$(jq -nc \
  --arg sid "test-session-${case_id}" \
  --arg tp "$transcript_file" \
  --arg cwd "$test_dir" \
  '{"session_id": $sid, "transcript_path": $tp, "cwd": $cwd}')
```

**Hook configuration** in `.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/on_stop.sh"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/validate.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Plugin hooks can also be registered via `plugin.json`:
- TypeScript handler: `"handler": "hooks/debug-capture.ts", "entry": "handlePreToolUse"`
- Shell command: `"type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/script.sh"`

**Limitations for Waiting State Detection**:
- `Stop` fires when Claude *finishes* a turn (i.e., just *entered* waiting state)
- No hook fires when Claude is *in the middle of* a turn (typing/processing)
- `PreToolUse` can block execution but does not signal waiting state
- Hook execution is synchronous — the hook must complete before Claude continues

**Sources**:
- `/Users/jack/mag/claude-code/plugins/multimodel/skills/hooks-system/SKILL.md` - Quality: High (local docs)
- `/Users/jack/mag/claude-code/plugins/multimodel/hooks/enforce-team-rules.sh` - Quality: High (production hook)
- `/Users/jack/mag/claude-code/plugins/agentdev/hooks/debug-capture.ts` - Quality: High (production hook)
- `/Users/jack/mag/claude-code/docs/plans/2026-02-28-dev-loop-e2e-tests.md` - Quality: High (design doc)
- `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_stop.sh` - Quality: High (production hook)

**Confidence**: High
**Multi-source**: Yes

---

### Finding 2: Claude Code JSONL Transcripts — Complete Session Log with Rich Event Types

**Summary**: Claude Code writes detailed JSONL transcripts to `~/.claude/projects/{project-key}/{session-id}.jsonl`. The format contains 7+ event types that can be tailed in real-time to monitor session state.

**Evidence**:

**File location**: `~/.claude/projects/{cwd-with-slashes-replaced-by-dashes}/{session-uuid}.jsonl`

For this project: `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/{uuid}.jsonl`

**Event Types** (confirmed from live session analysis):

| Type | Subtype | Meaning |
|------|---------|---------|
| `user` | (none) | User message or tool result |
| `assistant` | (none) | Claude response chunk |
| `progress` | `hook_progress` | Hook is executing |
| `progress` | `agent_progress` | Sub-agent progress |
| `progress` | `query_update` | Web search query |
| `progress` | `search_results_received` | Web search results |
| `system` | `stop_hook_summary` | **Turn ended — Claude is waiting** |
| `system` | `turn_duration` | Duration of completed turn |
| `system` | `hook_started` | Hook execution started |
| `queue-operation` | `enqueue`/`dequeue` | Message queue operations |
| `file-history-snapshot` | (none) | File state checkpoint |
| `last-prompt` | (none) | Last prompt display text |

**Key state detection insight**: The `system:stop_hook_summary` event is written to the JSONL immediately after each Claude turn completes (when Claude enters waiting state). Example:
```json
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 2,
  "hookInfos": [...],
  "preventedContinuation": false,
  "stopReason": "",
  "level": "suggestion",
  "timestamp": "2026-03-17T07:38:24.481Z",
  "sessionId": "b0a575aa-..."
}
```

Followed immediately by `system:turn_duration`:
```json
{
  "type": "system",
  "subtype": "turn_duration",
  "durationMs": 2136897,
  "timestamp": "2026-03-17T07:38:24.482Z"
}
```

**Assistant message structure** (stop_reason field reveals state):
- `stop_reason: "end_turn"` → Claude finished its response, now waiting
- `stop_reason: "tool_use"` → Claude invoked a tool (still active)
- `stop_reason: null` → Streaming chunk, not final

**Reliable waiting detection via JSONL tail**:
1. Tail the session JSONL file
2. Watch for `type: "system", subtype: "stop_hook_summary"` event
3. That signals Claude finished a turn and is now waiting for input

**Sources**:
- `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/b0a575aa-bf90-401b-99db-4730331e788f.jsonl` - Quality: High (live data)
- `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/0757314a-f48e-4717-b5cd-17f057c00891.jsonl` - Quality: High (live data)

**Confidence**: High
**Multi-source**: Yes

---

### Finding 3: Claude Code MCP Integration — State Detection via System:Init Event

**Summary**: Claude Code exposes a rich `system:init` event at session start via `--output-format stream-json` that lists all connected MCP servers and available tools. MCP servers themselves cannot directly detect Claude's waiting state, but they can be used as an IPC channel.

**Evidence**:

The `system:init` event (from live `--output-format stream-json --verbose` capture) contains:
```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/Users/jack/mag/magai/sirko",
  "session_id": "88d41e60-...",
  "tools": ["Task", "Bash", "Glob", ...],
  "mcp_servers": [
    {"name": "plugin:terminal:tmux", "status": "connected"},
    {"name": "plugin:code-analysis:claudemem", "status": "connected"}
  ],
  "model": "claude-sonnet-4-6",
  "permissionMode": "bypassPermissions",
  "claude_code_version": "2.1.77",
  "agents": [...],
  "skills": [...]
}
```

**MCP State Detection Capabilities**:
- MCP servers can expose tools that Claude calls (indirect channel)
- An MCP server like `plugin:terminal:tmux` can observe tmux pane output (used by Sirko)
- No official MCP API for querying Claude's internal state
- The `ht` (headless terminal) MCP server (`mcp__plugin_terminal_ht__*`) can take snapshots of terminal state — useful for detecting prompt

**MCP cannot** directly detect:
- Whether Claude is currently processing vs waiting
- Current turn state
- Active tool calls

**The `tmux` MCP server** (`plugin:terminal:tmux`) is the closest to state detection: `mcp__plugin_terminal_tmux__capture-pane` can capture the current terminal output, which combined with prompt pattern matching gives indirect state detection (this is what Sirko already does).

**Sources**:
- Live `stream-json` output from `claude -p --output-format stream-json --verbose` - Quality: High (primary source)
- `/Users/jack/.claude/settings.json` (MCP server list) - Quality: High

**Confidence**: High
**Multi-source**: No (single live test)

---

### Finding 4: Claude Code Programmatic Usage — `--print` Mode with JSON/stream-json Output

**Summary**: Claude Code v2.1.77 has a `--print` (`-p`) mode for non-interactive use with `--output-format json` (single result) or `--output-format stream-json` (streaming events). This is the official SDK-like interface for programmatic use.

**Evidence**:

**Key CLI flags** (`claude --help`):

```
-p, --print                       Print response and exit (non-interactive)
--output-format <format>          "text" | "json" | "stream-json" (--print only)
--include-partial-messages        Include partial chunks (stream-json only)
--input-format <format>           "text" | "stream-json" (--print only)
--no-session-persistence          Don't save session to disk
--session-id <uuid>               Use specific session ID (for resuming)
-c, --continue                    Continue most recent conversation
-r, --resume [value]              Resume by session ID
--max-budget-usd <amount>         Spending limit (--print only)
--fallback-model <model>          Fallback model when overloaded (--print only)
--replay-user-messages            Re-emit user messages on stdout (stream-json + stream-json)
```

**JSON output format** (single result, after completion):
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 2007,
  "num_turns": 1,
  "result": "A",
  "stop_reason": "end_turn",
  "session_id": "d1d736f0-...",
  "total_cost_usd": 0.097311,
  "usage": {...},
  "modelUsage": {...},
  "permission_denials": [],
  "fast_mode_state": "off",
  "uuid": "17ef2f75-..."
}
```

**Stream-JSON event sequence** (with `--verbose`):
1. `system:hook_started` × N (for each SessionStart hook)
2. `system:hook_response` × N (hook results)
3. `system:init` (session metadata, tools, MCP servers)
4. `assistant` (streaming message chunks, stop_reason=null while streaming)
5. `user` (tool results if tools invoked)
6. `assistant` (final message, stop_reason="end_turn")
7. `result:success` (final summary)

**No npm SDK package**: The Claude Code binary (`@anthropic-ai/claude-code@2.1.77`) is a compiled Mach-O binary (`/Users/jack/.local/share/claude/versions/2.1.77`), not a Node.js package with importable SDK. It only exposes the CLI interface.

The separate `@anthropic-ai/sdk@0.79.0` is the **Messages API** SDK, not the Claude Code SDK.

**Key insight for Sirko**: When running Claude Code with `-p --output-format stream-json`, the orchestrator can pipe Claude Code as a subprocess and parse events in real-time. The `result:success` event signals completion (waiting state).

**Sources**:
- `claude --help` output (version 2.1.77) - Quality: High (primary source)
- Live `claude -p --output-format json` test - Quality: High
- `npm show @anthropic-ai/claude-code --json` - Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 5: Sirko's Current Approach — Multi-Signal Weighted Detection

**Summary**: The Sirko project already implements a sophisticated multi-signal approach for detecting Claude Code's waiting state, combining 3 independent signals: terminal prompt pattern matching, OS-level wchan (wait channel), and quiescence (output silence time).

**Evidence**:

From `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts`:

```typescript
// Scoring formula:
// score = (S_prompt * skill.promptPatternWeight)
//       + (S_wchan  * skill.wchanWeight)
//       + (S_quiescence * skill.quiescenceWeight)
// awaiting = score >= skill.scoringThreshold
```

**Claude Code skill definition** (`/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts`):
```typescript
export const claudeCodeSkill: SkillDefinition = {
  name: 'claude-code',
  displayName: 'Claude Code',
  binaryPattern: /claude$/i,
  processNamePattern: /claude/i,
  promptPatterns: [/^>\s*$/m, /^❯[\s\u00a0]*$/m],  // Claude's input prompt
  promptPatternWeight: 0.45,
  quiescenceThresholdMs: 1800,
  quiescenceWeight: 0.20,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read', 'futex'],
  wchanWeight: 0.35,
  scoringThreshold: 0.60,
  inputSuffix: '\n',
}
```

**Signal 1 — Prompt Pattern** (weight: 0.45): Regex against terminal buffer, matches `>` or `❯` prompts

**Signal 2 — wchan** (weight: 0.35): OS wait channel via `ps -o wchan= -p <pid>` on macOS or `/proc/<pid>/wchan` on Linux. Values `pipe_read`, `read_events`, `wait_pipe_read`, `futex` indicate I/O wait.

**Signal 3 — Quiescence** (weight: 0.20): Time since last output > 1800ms. Lower confidence signal used as tiebreaker.

**Score threshold**: 0.60 — any two strong signals together pass the threshold.

**Opportunity**: The `Stop` hook (Finding 1) and `system:stop_hook_summary` JSONL events (Finding 2) provide a **cleaner, authoritative signal** that Claude Code itself fires. These could replace or supplement the current wchan + quiescence heuristics.

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts` - Quality: High (production code)
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts` - Quality: High (production code)
- `/Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts` - Quality: High (production code)
- `/Users/jack/mag/magai/sirko/apps/orchestrator/src/quiescence-scheduler.ts` - Quality: High (production code)

**Confidence**: High
**Multi-source**: Yes (all from sirko codebase)

---

### Finding 6: Multi-Agent Frameworks — Claudish, Magus Plugin System, Monitor Pattern

**Summary**: The local codebase contains two mature multi-agent frameworks: Claudish (proxy for non-Anthropic models) and Magus (plugin ecosystem). The monitor pattern in Magus uses debug log parsing + PID polling to track subagent state — a complementary approach to hooks.

**Evidence**:

**Claudish** (`/Users/jack/mag/claudish/`):
- Proxies any LLM as Claude Code replacement (OpenRouter, Gemini, OpenAI, etc.)
- Exposes MCP server mode where external models are tools inside Claude
- Detects agent spawning via `CLAUDISH_ACTIVE_MODEL_NAME` env var + `agent_type` field in SessionStart JSON
- Key for Sirko: each claudish subprocess is an independently detectable process

**Magus Monitor Pattern** (`/Users/jack/mag/claude-code/plugins/multimodel/scripts/monitor.ts`):
ProcessState tracking per sub-agent:
```
STARTING → ACTIVE → CALLING_API → TOOL_EXECUTING → COMPLETED
                                                  → STALLED
                                                  → ERRORED
```

State is inferred from debug log parsing (not hooks):
- Parses `[OpenRouter Request]`, `[Streaming] Usage data received`, etc.
- Polls `.pid` files to track process lifecycle
- Writes `monitor-status.json` periodically for orchestrator to read

**`monitor-status.json` schema** (per agent):
```typescript
interface ModelStatus {
  model_id: string;
  state: ProcessState;      // ACTIVE | CALLING_API | TOOL_EXECUTING | COMPLETED | ...
  turns_completed: number;
  tokens_so_far: number;
  tool_calls: string[];
  elapsed_seconds: number;
  last_activity_seconds_ago: number;
  pid: number | null;
  exit_code: number | null;
}
```

**Key pattern for Sirko**: The monitor writes state to a file; the orchestrator polls it. This file-based IPC pattern is complementary to the JSONL tail approach and could be used for Sirko's agent lifecycle management.

**Sources**:
- `/Users/jack/mag/claude-code/plugins/multimodel/scripts/monitor.ts` - Quality: High (production code)
- `/Users/jack/mag/claude-code/plugins/multimodel/scripts/lib/types.ts` - Quality: High
- `/Users/jack/mag/claudish/README.md` - Quality: High
- `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_session_start.sh` - Quality: High

**Confidence**: High
**Multi-source**: Yes

---

## Source Summary

**Total Sources**: 18
- High Quality: 18
- Medium Quality: 0
- Low Quality: 0

**Source List**:
1. `/Users/jack/mag/claude-code/plugins/multimodel/skills/hooks-system/SKILL.md` - Quality: High, Type: local docs
2. `/Users/jack/mag/claude-code/plugins/multimodel/hooks/enforce-team-rules.sh` - Quality: High, Type: production hook
3. `/Users/jack/mag/claude-code/plugins/agentdev/hooks/debug-capture.ts` - Quality: High, Type: production hook
4. `/Users/jack/mag/claude-code/docs/plans/2026-02-28-dev-loop-e2e-tests.md` - Quality: High, Type: design doc
5. `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_stop.sh` - Quality: High, Type: production hook
6. `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_session_start.sh` - Quality: High, Type: production hook
7. `/Users/jack/.claude/settings.json` - Quality: High, Type: production config
8. `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/b0a575aa-....jsonl` - Quality: High, Type: live session data
9. `claude --help` (v2.1.77) - Quality: High, Type: primary source
10. `claude -p --output-format json` (live test) - Quality: High, Type: primary source
11. `claude -p --output-format stream-json --verbose` (live test) - Quality: High, Type: primary source
12. `npm show @anthropic-ai/claude-code --json` - Quality: High, Type: primary source
13. `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts` - Quality: High, Type: production code
14. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts` - Quality: High, Type: production code
15. `/Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts` - Quality: High, Type: production code
16. `/Users/jack/mag/magai/sirko/apps/orchestrator/src/quiescence-scheduler.ts` - Quality: High, Type: production code
17. `/Users/jack/mag/claude-code/plugins/multimodel/scripts/monitor.ts` - Quality: High, Type: production code
18. `/Users/jack/mag/claudish/README.md` - Quality: High, Type: project docs

---

## Knowledge Gaps

What this research did NOT find:
- **`SubagentStop` hook input JSON schema**: The exact fields sent to `SubagentStop` hooks are not documented locally. The `Stop` hook receives `{session_id, transcript_path, cwd}` but `SubagentStop` fields are unknown. Suggested query: `SubagentStop hook input JSON schema fields`
- **`UserPromptSubmit` hook can modify context**: Documentation suggests it's read-only, but the actual output format that allows context injection was not fully verified. Suggested query: `UserPromptSubmit hook output schema additionalContext`
- **`PreToolUse` output format for blocking**: The `enforce-team-rules.sh` shows `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny"}}` written to fd3, but the full schema including `modifiedParameters` for input modification was not verified. Suggested query: `Claude Code PreToolUse hook output schema modifiedParameters`
- **External multi-agent frameworks (claude-swarm, claude-squad)**: No local examples found. These are GitHub projects not present locally. Suggested search: `github.com/anthropics/claude-code-sdk` or web search for `claude-swarm multi-agent 2025`

---

## Search Limitations

- Model: claude-sonnet-4-6
- Web search: unavailable (native mode, no MODEL_STRATEGY)
- Local search: performed extensively
- Date range: All local files up to 2026-03-18
- Query refinement: not needed (local sources were comprehensive)
- Live Claude Code binary tests: 3 executed (json, stream-json, stream-json with tool use)

---

## Synthesis Recommendations for Sirko

1. **Add Stop hook** to `.claude/settings.json` → write state file on turn completion → Sirko reads file to confirm waiting state (authoritative signal, no polling)

2. **Tail JSONL for `system:stop_hook_summary`** → real-time waiting state detection without modifying Claude Code settings

3. **Keep wchan + prompt pattern** as backup for cases where hooks are not configured or fail

4. **`stream-json --verbose` for subprocess mode** → if running Claude Code as a subprocess (`claude -p --output-format stream-json`), parse `result:success` events for turn completion

5. **`SubagentStop` hook** → write completion marker file per agent → Sirko reads to detect agent completion
