# Research Findings: Claude Code Orchestration and Monitoring Tools

**Researcher**: Explorer 1
**Date**: 2026-03-18
**Model Strategy**: native (local codebase investigation only; no web search available)
**Queries Executed**: 8 local searches across codebase source files

---

## Key Findings

### Finding 1: Sirko is itself a Claude Code orchestrator using tmux control-mode

**Summary**: The Sirko project in this repository is a tmux-based orchestrator that monitors Claude Code (and other CLI agents) by consuming tmux's control-mode protocol stream, interpreting terminal output, and using a weighted multi-signal detection engine to determine when an agent is waiting for input.

**Evidence**: Sirko connects to tmux using `tmux -C` (control mode), which emits structured protocol events (`%output`, `%begin`, `%end`, `%pane-exited`, etc.) over stdio. These are consumed by a `TmuxClient` class that runs an async read loop over the control-mode stream. When pane output arrives, it passes through an ordered middleware pipeline: state-manager → xterm-interpret → detection → dedup → notification-fanout → output-archive → logger.

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts` — Quality: High (primary source)
- `/Users/jack/mag/magai/sirko/apps/orchestrator/src/orchestrator.ts` — Quality: High (primary source)
- `/Users/jack/mag/magai/sirko/packages/pipeline/src/assemble.ts` — Quality: High (primary source)

**Confidence**: High
**Multi-source**: Yes (corroborated across 3 files)

---

### Finding 2: Three-signal weighted scoring is the detection mechanism (not log-file or API watching)

**Summary**: Sirko detects idle/waiting state using a weighted combination of three signals: (1) terminal prompt pattern matching via regex against the xterm buffer, (2) process wait-channel inspection (`/proc/<pid>/wchan` on Linux, `ps -o wchan=` on macOS), and (3) output quiescence (elapsed time since last `%output` event). No log-file watching or Claude Code API hooks are used.

**Evidence**:

Signal weights and thresholds for Claude Code (from `claude-code.ts`):
- `promptPatterns: [/^>\s*$/m, /^❯[\s\u00a0]*$/m]` — matches Claude Code's `>` and `❯` prompts
- `promptPatternWeight: 0.45` — prompt match contributes 45% of score
- `quiescenceThresholdMs: 1800` — 1.8 seconds of silence
- `quiescenceWeight: 0.20` — quiescence contributes 20%
- `wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read', 'futex']`
- `wchanWeight: 0.35` — kernel wait-channel contributes 35%
- `scoringThreshold: 0.60` — combined score must reach 0.60 to classify as "awaiting input"

The `DetectorEngine.computeScore()` method aggregates all three signals into a final `DetectionResult` with an `awaiting: boolean` field.

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/detector/src/quiescence.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/detector/src/prompt-matcher.ts` — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 3: tmux control-mode (`tmux -C`) is the dominant approach for output monitoring

**Summary**: Using tmux in control mode (flag `-C`) is how Sirko avoids polling. Control mode gives a structured event stream over stdio — the orchestrator spawns `tmux -L <socket> -C new-session ...` and reads `%output <pane>`, `%begin`, `%end`, and other notifications as lines. This eliminates the need to repeatedly run `capture-pane`.

**Evidence**: The `TmuxClient._spawn()` method shows the exact invocation:
```
tmux -L <socketName> -C new-session -A -s sirko-bot
```
The `_processLine()` method handles the protocol: `%begin`/`%end` delimit command response blocks (FIFO-queued), and other lines are parsed as notification events via `parseControlModeLine()`. Pane output events are coalesced over a 50ms window before dispatch (via `OutputCoalescer`) to handle burst output without saturating the pipeline.

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/coalescer.ts` — Quality: High (file exists, not read)
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/parser.ts` — Quality: High (file exists, not read)

**Confidence**: High
**Multi-source**: Yes

---

### Finding 4: A QuiescenceScheduler polls state for panes that have gone silent (no output events)

**Summary**: Because tmux control mode only emits `%output` when there IS output, a separate `QuiescenceScheduler` runs on an interval (`setInterval`) to detect panes that have been silent past their quiescence threshold but never received a "waiting" output event to trigger detection.

**Evidence**: `QuiescenceScheduler.tick()` checks all panes where:
- `status !== 'awaiting-input'` and `status !== 'exited'`
- `processingCount === 0`
- `Date.now() - pane.lastOutputTime >= skill.quiescenceThresholdMs`

When these conditions are met, it injects a synthetic `quiescence-check` context into the pipeline, which runs detection and can emit a `PaneAwaitingInput` event via the event bus.

**Sources**:
- `/Users/jack/mag/magai/sirko/apps/orchestrator/src/quiescence-scheduler.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/pipeline/src/middleware/detection.ts` — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 5: Three CLI tools are supported with distinct prompt signatures (Claude Code, Codex, Aider)

**Summary**: The `tool-plugins` package provides a plugin/skill registry with per-tool configurations. Each tool has its own binary detection regex, prompt patterns, signal weights, and scoring threshold. Detection of which tool is running in a pane uses process inspection (binary name + argv matching).

**Evidence**:

| Tool | Prompt Patterns | Score Threshold | Quiescence Ms |
|---|---|---|---|
| Claude Code | `/^>\s*$/m`, `/^❯[\s\u00a0]*$/m` | 0.60 | 1800 |
| Codex CLI | `/^\? /m`, `/Continue\?/i`, `/Proceed\?/i` | 0.65 | 1500 |
| Aider | `/^> /m`, `/\(y\/n\)/i`, `/\[Yes\]/i`, `/\[No\]/i` | 0.55 | 3000 |

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/codex.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/aider.ts` — Quality: High
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/detect.ts` — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 6: Process wait-channel inspection is cross-platform (Linux /proc, macOS ps)

**Summary**: To inspect the kernel wait-channel (wchan) of the Claude Code process, Sirko uses `/proc/<pid>/wchan` on Linux and `ps -o wchan= -p <pid>` on macOS. The macOS implementation caches results for 500ms to reduce subprocess spawn overhead.

**Evidence**: `createWchanInspector()` returns `LinuxWchan` on Linux and `MacosWchan` on macOS. The macOS variant uses `Bun.spawn()` to run `ps` and maintains a `Map<number, CacheEntry>` with TTL-based eviction (stale entries evicted after 30s). For Claude Code, the expected wait values are `['pipe_read', 'read_events', 'wait_pipe_read', 'futex']`.

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts` — Quality: High

**Confidence**: High
**Multi-source**: No (single definitive implementation file)

---

### Finding 7: Architecture was validated comparing three patterns — event-driven, actor-model, and pipeline/middleware

**Summary**: The architecture session documents evaluated three patterns for the orchestrator. The final implementation uses a hybrid: Pipeline/Middleware for core event processing (Alternative C from the architecture doc) combined with an EventBus for adapter fan-out (from Alternative A). The architecture documents note that "polling" approaches (periodic `capture-pane`) were not evaluated as viable — tmux control mode was the assumed baseline.

**Evidence**: The `ai-docs/sessions/dev-arch-20260316-124106-081b4c45/alternatives.md` describes all three alternatives in detail with pros/cons. The chosen approach was validated by 5 AI models (unanimous conditional approval per the memory file). The architecture doc explicitly describes the three signals (wchan, quiescence, prompt pattern) for detecting agent state — no mention of JSONL session log parsing, API hooks, or log-file watching as alternatives.

**Sources**:
- `/Users/jack/mag/magai/sirko/ai-docs/sessions/dev-arch-20260316-124106-081b4c45/alternatives.md` — Quality: High
- `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/memory/project_sirko_architecture.md` — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 8: No evidence of JSONL session log parsing or Claude Code API hooks in this codebase

**Summary**: Sirko does not use Claude Code's JSONL session logs (typically in `~/.claude/projects/`) for state detection. It also does not use any Claude Code API hooks, subprocess interception, or pty injection. All detection happens through tmux control-mode output + wchan + quiescence signals.

**Evidence**: A search across all TypeScript source files for terms like `jsonl`, `session_log`, `claude/projects`, or API hooks returned no results. The entire detection path runs through the `DetectorEngine` which reads only the xterm buffer, pane state timestamps, and OS process wait-channel.

**Sources**:
- Grep search across `/Users/jack/mag/magai/sirko/packages/**/*.ts` — Quality: High (absence of evidence)
- `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts` — Quality: High

**Confidence**: High
**Multi-source**: No (single search, confirmed by architecture documents)

---

## Source Summary

**Total Sources**: 14 distinct files examined
- High Quality: 14
- Medium Quality: 0
- Low Quality: 0

All sources are primary source code and architecture documentation within this repository.

**Source List**:
1. `/Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts` — Quality: High, Type: source
2. `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts` — Quality: High, Type: source
3. `/Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts` — Quality: High, Type: source
4. `/Users/jack/mag/magai/sirko/packages/detector/src/quiescence.ts` — Quality: High, Type: source
5. `/Users/jack/mag/magai/sirko/packages/detector/src/prompt-matcher.ts` — Quality: High, Type: source
6. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts` — Quality: High, Type: source
7. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/codex.ts` — Quality: High, Type: source
8. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/aider.ts` — Quality: High, Type: source
9. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/detect.ts` — Quality: High, Type: source
10. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/types.ts` — Quality: High, Type: source
11. `/Users/jack/mag/magai/sirko/packages/pipeline/src/assemble.ts` — Quality: High, Type: source
12. `/Users/jack/mag/magai/sirko/packages/pipeline/src/middleware/detection.ts` — Quality: High, Type: source
13. `/Users/jack/mag/magai/sirko/apps/orchestrator/src/orchestrator.ts` — Quality: High, Type: source
14. `/Users/jack/mag/magai/sirko/apps/orchestrator/src/quiescence-scheduler.ts` — Quality: High, Type: source
15. `/Users/jack/mag/magai/sirko/ai-docs/sessions/dev-arch-20260316-124106-081b4c45/alternatives.md` — Quality: High, Type: architecture docs
16. `/Users/jack/mag/magai/sirko/ai-docs/sessions/dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f/requirements.md` — Quality: High, Type: requirements docs
17. `/Users/jack/.claude/projects/-Users-jack-mag-magai-sirko/memory/project_sirko_architecture.md` — Quality: High, Type: memory

---

## Knowledge Gaps

What this research did NOT find:

- **External projects (claude-crew, claude-swarm, etc.)**: No web search was available. Cannot confirm whether these named projects exist, what approaches they use, or how they compare to Sirko. Suggested query: `"claude-crew" OR "claude-swarm" site:github.com`, `"claude code" tmux orchestrator site:github.com`

- **Claude Code's own JSONL log format**: This codebase does not parse JSONL logs. The format of `~/.claude/projects/` session logs and whether they expose useful state signals (e.g., "waiting_for_input" fields) is unknown from local sources. Suggested query: `"claude code" JSONL session log format site:github.com anthropics`

- **Whether other open-source tools parse Claude Code's ANSI output differently**: Sirko uses regex patterns `/^>\s*$/m` and `/^❯[\s\u00a0]*$/m` for Claude Code prompt detection. Whether these are comprehensive or whether other approaches exist (e.g., watching for specific color codes, OSC sequences) is unknown. Suggested query: `"claude code" prompt detection terminal monitoring`

- **Claude Code's `--output-format stream-json` flag**: Claude Code may support a structured JSON output mode that would be far more reliable for state detection than screen-scraping. Whether this exists and how it works is not documented in this codebase. Suggested query: `claude code CLI --output-format stream-json site:docs.anthropic.com`

---

## Search Limitations

- Model: claude-sonnet-4-6 (native, no web search)
- Web search: unavailable
- Local search: performed (all packages, apps, ai-docs examined)
- Date range: codebase as of 2026-03-18 (recent git history shows project started 2026-03-16)
- External projects researched: none (web search required)
- Query refinement: not needed for local sources; all relevant files located
