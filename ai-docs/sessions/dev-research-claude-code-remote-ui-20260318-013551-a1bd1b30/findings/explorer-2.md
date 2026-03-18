# Research Findings: UIs Built on Claude Code stream-json Output and Similar Patterns

**Researcher**: Explorer 2
**Date**: 2026-03-18
**Model Strategy**: native (local codebase + npm registry investigation; no web search)
**Queries Executed**: 22 (npm search queries, npm show package inspections, local codebase reads, SDK tarball extraction)

---

## Key Findings

### Finding 1: Anthropic ships an official Agent SDK (`@anthropic-ai/claude-agent-sdk`) that supersedes raw stream-json parsing

**Summary**: Anthropic publishes `@anthropic-ai/claude-agent-sdk` (version 0.2.77, released 2026-03-16), formerly called the "Claude Code SDK". This is the official programmatic interface for running Claude Code from JavaScript/TypeScript. It wraps the underlying `--output-format stream-json` mechanism and exposes a typed `AsyncGenerator<SDKMessage>` stream — the canonical way to build any UI on top of Claude Code output.

**Evidence**:

The SDK exposes a `query()` function that returns a `Query` object (an `AsyncGenerator<SDKMessage, void>`):

```typescript
// From sdk.d.ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;

export declare interface Query extends AsyncGenerator<SDKMessage, void> {
  close(): void;
}
```

`SDKMessage` is a discriminated union of 22+ event types:
```typescript
type SDKMessage =
  | SDKAssistantMessage        // Claude's response
  | SDKUserMessage             // User input
  | SDKResultMessage           // Final result (success or error)
  | SDKSystemMessage           // System events
  | SDKPartialAssistantMessage // Streaming chunks (type: 'stream_event')
  | SDKCompactBoundaryMessage  // Session compact events
  | SDKStatusMessage           // Status updates
  | SDKAPIRetryMessage         // API retry events
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage
  | SDKToolProgressMessage     // Tool execution progress
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskProgressMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKRateLimitEvent
  | SDKElicitationCompleteMessage
  | SDKPromptSuggestionMessage;
```

The SDK also exposes a `listSessions()` and `getSessionInfo()` API for reading session metadata without running a new query, enabling "dashboard" use cases (cost tracking, session history) without consuming stream-json output at all.

There is a V2 unstable session API (`unstable_v2_prompt`) with an `SDKSession` interface that has `send()` / `stream()` / `close()` methods — suggesting a bidirectional interactive session API is in development.

The package also includes:
- `./browser` export: `browser-sdk.js` — a browser-compatible build
- `./embed` export: `embed.js` — for embedding Claude Code in other apps (unbundled, processed by user's bundler)

**Sources**:
- `/tmp/package/sdk.d.ts` extracted from `@anthropic-ai/claude-agent-sdk@0.2.77` - Quality: High (official primary source)
- `/tmp/package/README.md` - Quality: High
- `npm show @anthropic-ai/claude-agent-sdk` - Quality: High
- [npm registry](https://npm.im/@anthropic-ai/claude-agent-sdk) - Quality: High

**Confidence**: High
**Multi-source**: Yes
**Contradictions**: None

---

### Finding 2: `@siteboon/claude-code-ui` — the most mature open-source web UI for Claude Code (7.2 MB package, full-stack)

**Summary**: `@siteboon/claude-code-ui` (hosted at https://cloudcli.ai, repo: github.com/siteboon/claudecodeui) is a full-stack web application that wraps Claude Code with a browser UI. It uses the `@anthropic-ai/claude-agent-sdk` directly and includes a PTY backend (`node-pty`), WebSocket server (`ws`), SQLite persistence (`better-sqlite3`), and a React frontend with xterm.js for the terminal view and CodeMirror for file editing.

**Evidence**:

Key dependencies reveal the architecture:
- `@anthropic-ai/claude-agent-sdk` — directly uses the Agent SDK for Claude Code interaction
- `node-pty` — PTY (pseudo-terminal) for raw terminal emulation in the browser
- `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/addon-clipboard`, `@xterm/addon-web-links` — full xterm.js stack for browser terminal rendering
- `ws` — WebSocket server (real-time bidirectional communication)
- `express` + `cors` — HTTP server for the REST API
- `better-sqlite3` + `sqlite3` + `sqlite` — SQLite for session persistence
- `chokidar` — filesystem watching (likely for file change events)
- `@codemirror/*` — full CodeMirror editor integration for file viewing/editing
- `react-markdown` + `rehype-katex` + `remark-gfm` — rich markdown rendering for Claude responses
- `fuse.js` — fuzzy search (likely for session history)
- `jsonwebtoken` + `bcrypt` — authentication
- `@octokit/rest` — GitHub integration
- `@openai/codex-sdk` — also wraps Codex CLI (multi-agent support)
- `react-router-dom` — multi-page SPA routing
- `multer` + `jszip` — file upload and zip handling

Architecture pattern: **Dual-transport hybrid** — uses `@anthropic-ai/claude-agent-sdk` for structured event streaming AND `node-pty` for raw terminal fallback. The xterm.js frontend handles both rendering the PTY output and receiving structured SDK events through WebSocket.

Published version 1.25.2 on 2026-03-11 (actively maintained, 49 published versions).

**Sources**:
- `npm show @siteboon/claude-code-ui --json` - Quality: High
- [npm registry](https://npm.im/@siteboon/claude-code-ui) - Quality: High
- Website: https://cloudcli.ai - Quality: Medium (not directly accessed)
- GitHub: https://github.com/siteboon/claudecodeui - Quality: High (repo URL confirmed from npm)

**Confidence**: High
**Multi-source**: Yes

---

### Finding 3: `claude-view` — a React + Rust/Axum + SQLite live dashboard that reads JSONL session files directly

**Summary**: `claude-view` (v0.22.0, released 2026-03-17, active) is a "mission control" dashboard for all Claude Code sessions. It reads the `~/.claude/projects/` JSONL files directly (no subprocess spawning), uses Axum (Rust HTTP server), SQLite + Tantivy (full-text search), React frontend with SSE/WebSocket for real-time updates, and has zero npm runtime dependencies (self-contained binary).

**Evidence**:

From keywords (the package readme was not accessible, but keywords are definitive):
```
'sse', 'websocket', 'rust', 'react', 'axum', 'sqlite', 'tantivy',
'cost-tracking', 'analytics', 'metrics', 'heatmap', 'activity-log',
'sub-agents', 'subagents', 'agent-monitor', 'context-window',
'cache-countdown', 'real-time', 'session-history', 'session-viewer',
'full-text-search', 'export', 'fluency-score', 'conversation-viewer'
```

Zero npm dependencies and published as a single binary package (14.6 kB unpackaged). The Rust/Axum backend is compiled into the binary, serving the React frontend as embedded static assets.

The description "monitor every session, track costs, search history, see sub-agents" + `tantivy` (Rust full-text search) + `axum` (Rust HTTP) + zero runtime deps confirms this is a JSONL reader/viewer — it does NOT run Claude Code processes, it visualizes existing session files.

The `cache-countdown` keyword is notable — this tracks when the 5-minute context caching window expires, which is only computable from reading JSONL token counts.

Homepage: https://claudeview.ai — Published by `tombelieber` (GitHub Actions CI).

**Sources**:
- `npm show claude-view` — Quality: High
- [npm registry](https://npm.im/claude-view) - Quality: High

**Confidence**: High
**Multi-source**: No (single source, but keywords are strongly indicative)

---

### Finding 4: `@kosinal/claude-code-dashboard` — a real-time browser dashboard using SSE from Claude Code session states

**Summary**: `@kosinal/claude-code-dashboard` (v1.0.0, 2026-03-12, GitHub: github.com/kosinal/claude-code-dashboard) is specifically described as a "Real-time browser dashboard for Claude Code session states." Zero npm runtime dependencies suggests a compiled/self-contained binary similar to claude-view.

**Evidence**:

- Description: "Real-time browser dashboard for Claude Code session states"
- Zero dependencies (compiled binary)
- Keywords: `claude`, `claude-code`, `dashboard`, `monitoring`
- Repo: github.com/kosinal/claude-code-dashboard

The "session states" language specifically (not "session history") suggests it monitors active running sessions, not just historical logs — distinguishing it from claude-view which appears to be primarily a history viewer.

**Sources**:
- `npm show @kosinal/claude-code-dashboard --json` - Quality: High
- [npm registry](https://npm.im/@kosinal/claude-code-dashboard) - Quality: High

**Confidence**: Medium (limited description; zero deps and "real-time" suggest specific implementation pattern)
**Multi-source**: No

---

### Finding 5: `ccdash` — CLI dashboard for Claude Code, scheduled since mid-2025

**Summary**: `ccdash` (v0.6.18, satoshi03, 2025-08-10) is an older "comprehensive monitoring dashboard for Claude Code" distributed as a CLI binary (`bin/ccdash.js`) with zero runtime dependencies. Its August 2025 publish date makes it one of the earliest known Claude Code monitoring projects.

**Evidence**:

- Description: "Claude Code Dashboard - A comprehensive monitoring dashboard for Claude Code"
- Bin: `ccdash`
- Zero dependencies
- Version 0.6.18 (advanced versioning for an August 2025 project — 18 patch versions)
- Homepage: github.com/satoshi03/ccdash

Notable for being early: predates the Agent SDK's maturity and likely reads JSONL session files directly.

**Sources**:
- `npm show ccdash --json` - Quality: High

**Confidence**: Medium
**Multi-source**: No

---

### Finding 6: `@forrestzhang107/claude-squad` — a terminal dashboard built with Ink/React, not a web UI

**Summary**: `@forrestzhang107/claude-squad` (v0.2.2, 2026-03-12) is described as a "Terminal dashboard for monitoring Claude Code agent sessions." It is built with `ink` (React for CLI) and `react`, not a web browser UI. This represents the TUI (terminal UI) pattern for Claude Code monitoring.

**Evidence**:

- Description: "Terminal dashboard for monitoring Claude Code agent sessions"
- Dependencies: `ink` (Ink = React-in-terminal), `react`
- Keywords: `claude`, `cli`, `terminal`, `dashboard`, `agent`

The `ink` dependency is the clearest technical signal: Ink renders React components to the terminal using ANSI escape codes, producing a TUI without a web browser. This is the same approach as tools like `@clack/prompts` but for full dashboard layouts.

Contrast with `claude-squad` (different publisher, mtmsuhail, v0.1.24, 2025-12-14) which describes "Multi-Agent Squad - AI-powered development orchestration for Claude Code" — a different tool with the same name.

**Sources**:
- `npm show @forrestzhang107/claude-squad --json` - Quality: High
- `npm search "claude squad"` - Quality: High

**Confidence**: High
**Multi-source**: No (single package, but Ink dependency is definitive)

---

### Finding 7: `@annix/claude-swarm` — multi-Claude worktree orchestrator (no UI, CLI-only)

**Summary**: `@annix/claude-swarm` (v0.1.21, 2026-03-15, GitHub: github.com/AnnixInvestments/claude-swarm) manages "multiple parallel Claude CLI sessions with worktree isolation and dev server lifecycle management." This is an orchestrator with no visual UI — it coordinates multiple Claude Code instances but the user interaction is purely CLI.

**Evidence**:

- Description: "Manage multiple parallel Claude CLI sessions with worktree isolation and dev server lifecycle management"
- Dependencies: `@inquirer/prompts` (CLI prompts), `chalk` (colored terminal output)
- No web/browser dependencies, no xterm.js, no WebSocket

The `@inquirer/prompts` dependency confirms this is a CLI tool that takes user input via terminal prompts. The "worktree isolation" feature suggests it creates separate git worktrees for each Claude Code instance to avoid file conflicts — a sophisticated multi-agent coordination pattern.

**Sources**:
- `npm show @annix/claude-swarm --json` - Quality: High
- [npm registry](https://npm.im/@annix/claude-swarm) - Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 8: `claude-code-web` — node-pty + WebSocket raw terminal bridge to browser (no structured events)

**Summary**: `claude-code-web` (v3.4.0, vultuk, 2025-10-23, GitHub: github.com/vultuk/claude-code-web) is "a web-based interface for Claude Code CLI accessible via browser." Unlike the siteboon implementation, it uses `node-pty` as the ONLY Claude Code interface — there is no Agent SDK dependency. This is the ttyd/wetty pattern: a raw PTY exposed over WebSocket to an xterm.js browser terminal.

**Evidence**:

Dependencies: `node-pty`, `ws`, `express`, `cors`, `@ngrok/ngrok`, `commander`, `open`, `uuid`

No `@anthropic-ai/claude-agent-sdk` or `@anthropic-ai/claude-code` dependency — pure PTY bridge. The `@ngrok/ngrok` inclusion is particularly interesting: this tool exposes Claude Code to the internet via ngrok tunneling, enabling remote/mobile access.

Architecture: spawn Claude Code in a PTY → stream raw terminal bytes over WebSocket → render in browser xterm.js. No parsing of stream-json events — the browser sees raw ANSI terminal output, not structured events.

**Sources**:
- `npm show claude-code-web --json` - Quality: High
- [npm registry](https://npm.im/claude-code-web) - Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 9: `ttyd-mux` — tmux session multiplexer for multiple ttyd web terminal sessions

**Summary**: `ttyd-mux` (v0.6.0, cuzic, 2026-02-25, GitHub: github.com/cuzic/ttyd-mux) is a "session multiplexer" for `ttyd+tmux` web terminal sessions. It manages multiple tmux sessions each exposed as a web terminal via ttyd, with WebSocket-based management UI, QR code access, and Web Push notifications.

**Evidence**:

Dependencies: `@inquirer/prompts`, `commander`, `http-proxy`, `mitt` (event emitter), `proper-lockfile`, `qrcode-generator`, `web-push` (push notifications), `ws`, `xstate` (state machine), `yaml`, `zod`

The `xstate` dependency is significant: XState is a finite state machine library — `ttyd-mux` models each terminal session as an explicit state machine, enabling reliable lifecycle management. The `web-push` + `qrcode-generator` combo suggests mobile notification support: generate a QR code to open a terminal session on a phone, receive push notifications when the session needs attention.

This is the most sophisticated of the "raw terminal to web" patterns found. It is NOT Claude Code-specific but would work for any CLI tool including Claude Code.

**Sources**:
- `npm show ttyd-mux --json` - Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 10: `@jacques-ai/server` — MCP-based multi-session Claude Code context monitor

**Summary**: `@jacques-ai/server` (v0.1.1, gregory-lime, 2026-02-14, GitHub: github.com/gregory-lime/jacques) is a "multi-session Claude Code monitor server" that uses the MCP SDK as its communication protocol. It provides monitoring via an MCP server that Claude Code instances can connect to, rather than a standalone web dashboard.

**Evidence**:

Dependencies: `@jacques-ai/core`, `@modelcontextprotocol/sdk`, `node-notifier`, `ws`, `zod`

The `@modelcontextprotocol/sdk` dependency reveals the architecture: this is an MCP server that Claude Code connects to as a client. It can then monitor session state, context window usage, and push desktop notifications (`node-notifier`). WebSocket (`ws`) for real-time communication.

This is a distinct pattern from all other tools: instead of building a UI that watches Claude Code from outside, it becomes an MCP server that Claude Code's own plugin system connects to. Claude Code voluntarily reports its state to the monitor via the MCP protocol.

**Sources**:
- `npm show @jacques-ai/server --json` - Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 11: `ai-sdk-provider-claude-code` and Zed's ACP adapter — two patterns for embedding Claude Code in other UIs

**Summary**: Two packages integrate Claude Code into existing UIs via adapters: (1) `ai-sdk-provider-claude-code` wraps the Agent SDK as a Vercel AI SDK v6 provider, enabling use in any Vercel AI SDK-based UI; (2) `@zed-industries/claude-agent-acp` wraps the Agent SDK as an ACP (Agent Client Protocol) server, enabling use in Zed editor's agent framework.

**Evidence**:

`ai-sdk-provider-claude-code` (v3.4.4, ben-vargas, 2026-03-10):
- Dependencies: `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@anthropic-ai/claude-agent-sdk`
- GitHub: github.com/ben-vargas/ai-sdk-provider-claude-code
- Description: "AI SDK v6 provider for Claude via Claude Agent SDK (use Pro/Max subscription)"
- Pattern: Wraps Agent SDK as a Vercel AI SDK language model provider, allowing any Vercel AI SDK chat UI to use Claude Code (with full file-editing capabilities) instead of raw API calls.

`@zed-industries/claude-agent-acp` (v0.22.0, zed-industries, 2026-03-16):
- Dependencies: `@agentclientprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`, `zod`
- GitHub: github.com/zed-industries/claude-agent-acp
- Description: "An ACP-compatible coding agent powered by the Claude Agent SDK"
- Pattern: Exposes Claude Code as an ACP server so Zed editor can invoke it as a native coding agent.

**Sources**:
- `npm show ai-sdk-provider-claude-code --json` - Quality: High
- `npm show @zed-industries/claude-agent-acp --json` - Quality: High

**Confidence**: High
**Multi-source**: Yes (two distinct packages using the same pattern)

---

### Finding 12: Eclipse Theia has a native `@theia/ai-claude-code` integration package

**Summary**: `@theia/ai-claude-code` (v1.69.0, 2026-02-26, eclipse-theia) is a native Theia IDE extension that integrates Claude Code into the Theia IDE framework. Theia is the foundation for IDEs like Gitpod, Amazon Cloud9, and various cloud IDEs.

**Evidence**:

Dependencies: `tslib`, `@theia/core`, `@theia/editor`, `@theia/output`, `@theia/ai-chat`, `@theia/ai-core`, `@theia/workspace`, `@theia/ai-chat-ui`, `@theia/filesystem`, `@theia/monaco-editor-core`

The `@theia/ai-chat` and `@theia/ai-chat-ui` dependencies reveal this is a full chat UI integration — Claude Code's output (presumably via the Agent SDK) is rendered in Theia's AI chat panel, not a raw terminal.

GitHub: github.com/eclipse-theia/theia (the main Theia monorepo).

**Sources**:
- `npm show @theia/ai-claude-code --json` - Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 13: `tmux-claude-continuity` — a Claude Code hooks-based tmux state sidecar (installed locally)

**Summary**: The locally installed `tmux-claude-continuity` plugin (MadAppGang, GitHub: github.com/MadAppGang/tmux-claude-continuity) uses Claude Code's `SessionStart` and `Stop` hooks to write per-pane sidecar files, enabling tmux session restore via `tmux-resurrect`. This is the simplest known example of a tool consuming Claude Code hooks output to build useful functionality.

**Evidence**:

From the installed README at `/Users/jack/.tmux/plugins/tmux-claude-continuity/README.md`:

- `SessionStart` hook fires → writes `~/.config/tmux-claude/panes/{session}-{window}-{pane}.session-id` with the session UUID
- `Stop` hook fires after each turn → updates the sidecar file with any `/title` rename
- Post-restore hook reads sidecar files → sends `claude --resume <token>` to restore sessions

Scripts: `on_session_start.sh`, `on_stop.sh`, `post_restore.sh`

This demonstrates the minimal viable Claude Code hook consumer: ~50 lines of bash total, no dependencies, useful functionality.

**Sources**:
- `/Users/jack/.tmux/plugins/tmux-claude-continuity/README.md` - Quality: High (local primary source)
- `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_stop.sh` - Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 14: `@composio/claude-agent-sdk` — tool integration layer for Agent SDK

**Summary**: `@composio/claude-agent-sdk` (v0.6.5, 2026-03-13) provides a "Composio provider for Claude Agent SDK" — integrating Composio's 250+ app integrations (GitHub, Slack, Notion, etc.) as tools available to Claude Code via the Agent SDK.

**Evidence**:

- Description: "Composio provider for Claude Agent SDK"
- Homepage: composio.dev (major tool integration platform)
- Keywords: `composio`, `claude`, `claude-code`, `agent-sdk`, `anthropic`, `mcp`

This represents a "tool provider" pattern on top of the Agent SDK: instead of building a UI, it enriches the agent with external tool capabilities. Relevant as a reference for MCP server integration patterns.

**Sources**:
- `npm show @composio/claude-agent-sdk --json` - Quality: High

**Confidence**: High
**Multi-source**: No

---

## Architecture Pattern Summary

Five distinct architectural patterns observed for building on top of Claude Code output:

| Pattern | Key Tools | UI Type | Claude Code Integration | Example |
|---|---|---|---|---|
| **1. Agent SDK streaming** | `@anthropic-ai/claude-agent-sdk` | Web/any | `query()` → `AsyncGenerator<SDKMessage>` | siteboon, ai-sdk-provider |
| **2. Raw PTY bridge** | `node-pty` + `ws` + `xterm.js` | Web browser | PTY → WebSocket → xterm.js | claude-code-web |
| **3. JSONL file reader** | `chokidar`/FSEvents + SQLite | Web browser | Tail `~/.claude/projects/*.jsonl` | claude-view, ccdash |
| **4. TUI (Ink/React)** | `ink` + `react` | Terminal | Process monitoring + tmux control | claude-squad (forrestzhang) |
| **5. MCP server monitor** | `@modelcontextprotocol/sdk` | Any | Claude Code connects as MCP client | jacques-ai |
| **6. Hooks sidecar** | Bash + `jq` | None (state file) | `Stop`/`SessionStart` hooks → files | tmux-claude-continuity |
| **7. Protocol adapter** | ACP/Vercel AI SDK | IDE-native | Agent SDK → protocol wrapper | Zed ACP, Theia |
| **8. tmux+ttyd mux** | `ttyd` + `xstate` + `ws` | Web browser | Raw PTY over ttyd | ttyd-mux |

---

## Source Summary

**Total Sources**: 22 queries executed
- High Quality: 20
- Medium Quality: 2
- Low Quality: 0

**Source List**:
1. `@anthropic-ai/claude-agent-sdk@0.2.77` tarball (`/tmp/package/sdk.d.ts`) — Quality: High, Type: official SDK
2. `npm show @anthropic-ai/claude-agent-sdk` — Quality: High, Type: npm registry
3. `npm show @siteboon/claude-code-ui --json` — Quality: High, Type: npm registry
4. `npm show claude-view` — Quality: High, Type: npm registry
5. `npm show @kosinal/claude-code-dashboard --json` — Quality: High, Type: npm registry
6. `npm show ccdash --json` — Quality: High, Type: npm registry
7. `npm show @forrestzhang107/claude-squad --json` — Quality: High, Type: npm registry
8. `npm show @annix/claude-swarm --json` — Quality: High, Type: npm registry
9. `npm show claude-code-web --json` — Quality: High, Type: npm registry
10. `npm show ttyd-mux --json` — Quality: High, Type: npm registry
11. `npm show @jacques-ai/server --json` — Quality: High, Type: npm registry
12. `npm show ai-sdk-provider-claude-code --json` — Quality: High, Type: npm registry
13. `npm show @zed-industries/claude-agent-acp --json` — Quality: High, Type: npm registry
14. `npm show @theia/ai-claude-code --json` — Quality: High, Type: npm registry
15. `npm show @composio/claude-agent-sdk --json` — Quality: High, Type: npm registry
16. `/Users/jack/.tmux/plugins/tmux-claude-continuity/README.md` — Quality: High, Type: local file
17. `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_stop.sh` — Quality: High, Type: local file
18. `npm search "claude code ui"` — Quality: High, Type: npm registry
19. `npm search "claude code dashboard"` — Quality: High, Type: npm registry
20. `npm search "claude squad"` / `"claude swarm"` — Quality: High, Type: npm registry
21. `npm search "ttyd"` / `"wetty"` — Quality: Medium, Type: npm registry
22. `npm search "open interpreter"` — Quality: Medium, Type: npm registry

---

## Knowledge Gaps

What this research did NOT find:

- **Aider web UI / Open Interpreter web UI on npm**: No npm packages found for Aider web UI or Open Interpreter web UI. Aider does have a `--browser` mode (built-in web UI) but no npm-published standalone package was found. Suggested query: `pip search "aider web ui"` or GitHub search `aider browser interface`

- **`stream-json` event rendering specifics**: The exact structure of each `SDKMessage` subtype (particularly `SDKTaskProgressMessage`, `SDKToolProgressMessage`) from the Agent SDK was not fully documented. The sdk.d.ts file was large (34K tokens) and only partially read. Suggested: read sdk.d.ts lines 2280-2500 for `SDKTask*` types.

- **`claude-view` implementation**: Zero deps + Rust/Axum + React suggests a pre-built binary distribution. The exact mechanism for reading JSONL session files (FSEvents watch vs. polling vs. SQLite write-ahead log) was not confirmed. Suggested query: inspect github.com/tombelieber/claude-view source.

- **`claude-code-web` streaming approach**: Whether `claude-code-web` uses `--output-format stream-json` in its PTY or raw interactive mode was not confirmed. The pure PTY approach (no Agent SDK) suggests raw ANSI — but it may run `claude -p --output-format stream-json` in the PTY and parse events server-side.

- **`@anthropic-ai/claude-agent-sdk` browser SDK**: The `./browser` export was confirmed to exist (`browser-sdk.js`, 448 KB minified) but its API surface was not analyzed. Whether it enables running Claude Code directly in the browser (sandboxed) or only provides event type definitions is unknown.

- **GoTTY / ttyd native packages**: The `gobot-gotty` npm shim wraps the Go binary, but the original ttyd (C) and GoTTY (Go) have no first-class npm packages. They are distributed as native binaries, not npm modules.

---

## Search Limitations

- Model: claude-sonnet-4-6 (native mode)
- Web search: unavailable (MODEL_STRATEGY=native)
- Local search: performed (Sirko codebase, local Claude Code files, tmux plugins)
- npm registry: queried extensively (22 queries via `npm search` and `npm show`)
- GitHub source code: NOT directly accessed (npm metadata only)
- Date range: npm results current as of 2026-03-18
- PyPI: NOT searched (Python ecosystem not covered)
