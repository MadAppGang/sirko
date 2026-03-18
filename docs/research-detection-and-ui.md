# Research: Agent State Detection & Remote UI

Research conducted 2026-03-18. Findings from 6 parallel research agents analyzing Claude Code internals, existing projects, and monitoring techniques.

## Current Detection Approach (Sirko v1)

Sirko uses three weighted signals combined into a score:

| Signal | Weight (Claude Code) | Platform | Reliability |
|--------|---------------------|----------|-------------|
| Prompt regex (`❯`, `>`) | 0.45 | All | Medium — breaks on UI changes |
| Quiescence (output silence) | 0.20 | All | Medium — false positives on slow output |
| Wchan (kernel wait channel) | 0.35 | Linux only | High on Linux, broken on macOS |

Threshold: 0.60. On macOS max score is 0.65 (no wchan).

## Better Detection Signals Available

### 1. Claude Code Stop Hook (recommended for Phase 1)

Claude Code fires a `Stop` hook after every completed turn with `{session_id, transcript_path, cwd}`. Configure in `.claude/settings.json`. Zero false positives. Works while Claude Code runs normally in TUI mode.

### 2. JSONL Session Log Watching

Claude Code writes to `~/.claude/projects/{project-key}/{session-uuid}.jsonl`. The `system:stop_hook_summary` entry fires when a turn ends. Use `fs.watch()` — when this entry appears, Claude is waiting. Works alongside normal TUI.

### 3. Stream-JSON Events (for programmatic/headless mode)

`claude -p --output-format stream-json --verbose` emits structured events:

- `system:init` — session metadata, tools, model
- `assistant` — Claude messages (text, thinking, tool_use)
- `user` — tool results (stdout/stderr)
- `result:success` — final summary with cost and tokens
- `stream_event` (with `--include-partial-messages`) — raw API deltas

**Waiting signal**: `message_delta.stop_reason == "end_turn"` — authoritative.

**Tradeoff**: No TUI. User cannot interact visually. Only for automation.

### 4. Agent SDK

`@anthropic-ai/claude-agent-sdk` (v0.2.77) wraps stream-json as typed `AsyncGenerator<SDKMessage>`. Official Anthropic package.

## Claude Code Remote Access (Built-in)

Claude Code has first-party remote control:

```bash
claude --rc                    # start with remote control
/remote-control                # enable in-session
```

Architecture:
```
CLI (local) → WebSocket → wss://bridge.claudeusercontent.com → claude.ai/code (web/mobile)
```

- Uses CCR v2 protocol (Cloud Code Runner) with epoch-based sync
- Spawn mode: `--spawn=same-dir|worktree|session` for multiple concurrent sessions
- Mobile: `claude.ai/code?bridge=<bridgeId>` — web interface, not native iOS app
- Feature-flagged — not available to all accounts yet

## Existing UI Projects

| Project | Approach | Stack | Maturity |
|---------|----------|-------|----------|
| `@anthropic-ai/claude-agent-sdk` | Official SDK, typed events | Node.js/TS | Official |
| `@siteboon/claude-code-ui` | Full web UI | React + xterm + SQLite | 49 versions, active |
| `claude-code-web` | PTY bridge + ngrok | Node.js | Early |
| `claude-view` | JSONL log reader + search | Rust/Axum + React | Mature |
| `@forrestzhang107/claude-squad` | Multi-agent TUI | Ink/React | Active |

### For multi-agent (not just Claude Code)

Most projects above are Claude Code specific. For agent-agnostic monitoring:

- **tmux control mode** (Sirko's current approach) — works with any CLI tool
- **PTY bridge** (like `claude-code-web`) — wraps any terminal process
- **Web terminal** projects: `ttyd` (8k stars), `gotty` (18k stars) — expose any terminal over web

## Recommended Roadmap

### Phase 1: JSONL Log Watcher (small, high impact)

Add file watcher for `~/.claude/projects/*/session.jsonl`. When `stop_hook_summary` appears, emit `PaneAwaitingInput`. Works alongside existing tmux detection. Claude Code specific but most reliable signal.

### Phase 2: Stop Hook Integration

Configure Claude Code's Stop hook to notify Sirko directly (HTTP POST or named pipe). Replaces polling with push notification. Sub-millisecond detection latency.

### Phase 3: Agent SDK for New Sessions

Use `@anthropic-ai/claude-agent-sdk` to spawn Claude Code sessions programmatically. Get typed events, perfect state detection. For automated/headless agents only.

### Phase 4: Web Dashboard

Build React + xterm.js UI. For Claude Code sessions, render stream-json events. For other agents (Codex, Aider), use tmux capture-pane + WebSocket streaming. Pattern from `@siteboon/claude-code-ui`.

## Key Insight

The tmux-based approach remains correct for **multi-agent** support (Codex, Aider, any CLI). But for **Claude Code specifically**, the Stop hook / JSONL / stream-json signals are far more reliable than screen-scraping prompt patterns. The ideal system uses both: authoritative signals when available (Claude Code), heuristic signals as fallback (everything else).
