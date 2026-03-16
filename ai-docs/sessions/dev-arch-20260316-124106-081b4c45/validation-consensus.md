# Sirko Architecture — Multi-Model Validation Consensus

**Session**: dev-arch-20260316-124106-081b4c45
**Date**: 2026-03-16
**Models reviewed**: 5 of 7 (Gemini rate-limited, GLM errored)

## Model Verdicts

| Model | Verdict | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| Claude (internal) | CONDITIONAL | 2 | 3 | 4 | 4 |
| MiniMax M2.5 | CONDITIONAL | 1 | 3 | — | — |
| Kimi K2.5 | CONDITIONAL | 1 | 4 | 12 | — |
| GPT-5.4 | CONDITIONAL | 0 | 3 | — | — |
| Qwen 3.5 Plus | CONDITIONAL | 0 | 5 | 5 | 4 |

**Unanimous verdict: CONDITIONAL APPROVE** (all 5 models)

---

## Consensus Findings (issues raised by 3+ models)

### CRITICAL — Must address before implementation

#### 1. `sendMessageDraft` API existence unverified (4/5 models)
**Raised by**: Claude, MiniMax, Kimi, Qwen
**Issue**: The entire Telegram streaming strategy depends on Bot API 9.3+ `sendMessageDraft`, which may not exist in the public specification. No fallback is designed.
**Resolution**: Verify API availability. Design explicit fallback using `editMessageText` with rate-limit-aware throttling (~1 edit/3s per message). Document both paths in architecture.

#### 2. Dedup/pipeline race condition under concurrent pane events (3/5 models)
**Raised by**: Claude, Kimi, Qwen
**Issue**: Multiple concurrent `%output` events for the same pane could bypass deduplication. The quiescence scheduler can inject `QuiescenceCheck` while a pipeline run for the same pane is in-flight.
**Resolution**: Add per-pane processing lock (simple mutex using Bun's single-threaded model — a `Map<PaneId, Promise>` that serializes pipeline runs per pane). Document the concurrency invariant.

### HIGH — Should address before implementation

#### 3. No backpressure / queueing strategy (4/5 models)
**Raised by**: MiniMax, Kimi, GPT, Qwen
**Issue**: No defined backpressure for: tmux output bursts, pipeline processing queue, EventBus subscriber delivery, Telegram rate limiting. Bursty output from 10+ panes could overwhelm the single-threaded pipeline.
**Resolution**: Add architecture section on backpressure. Key mechanisms: per-pane output coalescing (batch rapid `%output` events), bounded EventBus queue per subscriber, Telegram rate-limit queue (already partially described in FR-TG-09).

#### 4. Runtime topology ambiguity — single vs multi-process (3/5 models)
**Raised by**: MiniMax, GPT, Claude
**Issue**: The monorepo has `apps/orchestrator`, `apps/telegram-bot`, `apps/voice-server` as separate packages, but the EventBus is in-process. Unclear if these are separate processes or a single process with imported packages.
**Resolution**: Explicitly document: **single process** for v1. The `apps/` packages are entry points but v1 runs a single `apps/orchestrator` process that imports telegram-bot and voice-server as libraries. The EventBus is in-process by design.

#### 5. `@xterm/headless` Bun compatibility + fallback gap (3/5 models)
**Raised by**: Claude, Kimi, Qwen
**Issue**: If `@xterm/headless` doesn't work under Bun, the named fallback (`strip-ansi`) cannot maintain a screen buffer, degrading prompt pattern detection.
**Resolution**: Early spike (Phase 1, Week 1) to validate Bun compatibility. Design `TerminalEmulator` interface with two implementations: `XtermEmulator` (full) and `BufferEmulator` (line-buffer + strip-ansi, degraded but functional). Skill prompt patterns must work against the degraded interface.

#### 6. Voice pipeline 500-800ms latency target may be unrealistic (3/5 models)
**Raised by**: MiniMax, Qwen, GPT
**Issue**: The target assumes optimal network conditions and perfect streaming pipelining. Real-world expectation is 1-1.5s.
**Resolution**: Revise to "target 800ms, acceptable up to 1.5s." Add early latency benchmarking spike in Phase 4 (Week 7). Document latency budget breakdown per stage.

#### 7. No circuit breaker for external API failures (3/5 models)
**Raised by**: Kimi, GPT, Qwen
**Issue**: Deepgram, ElevenLabs, or Telegram API outages could cause cascading failures across the system.
**Resolution**: Add circuit breaker per external dependency (simple state machine: closed → open → half-open). On voice pipeline failure, fall back to Telegram-only notification. On Telegram failure, queue messages with bounded buffer.

### MEDIUM — Address during implementation

- **PID staleness** (Claude): `PaneState.pid` set at registration points to shell, not agent. Need periodic PID refresh or foreground-process walk.
- **State schema migration** (Claude, Qwen): No versioned schema for persisted JSON state. Add `schemaVersion` field.
- **Graceful shutdown** (Qwen): No strategy for in-flight pipeline runs, open voice calls, or pending Telegram messages during shutdown.
- **Detection calibration** (Qwen): No documented process for empirically tuning quiescence thresholds per tool.
- **LiveKit SDK Bun compatibility** (Claude, MiniMax): Production voice transport may require Node.js if LiveKit SDK has native dependencies.

---

## Action Items (Pre-Implementation)

| # | Action | Severity | Owner |
|---|---|---|---|
| 1 | Verify `sendMessageDraft` existence; design `editMessageText` fallback | CRITICAL | Phase 1 spike |
| 2 | Add per-pane pipeline serialization to prevent dedup races | CRITICAL | Architecture update |
| 3 | Add "Runtime Topology" section (single-process for v1) | HIGH | Architecture update |
| 4 | Add "Backpressure & Queueing" section | HIGH | Architecture update |
| 5 | Define `TerminalEmulator` interface + degraded fallback | HIGH | Architecture update |
| 6 | Revise voice latency target to 800ms-1.5s | HIGH | Architecture update |
| 7 | Add circuit breaker pattern per external dependency | HIGH | Architecture update |
| 8 | Add `@xterm/headless` Bun compatibility spike to Phase 1 | HIGH | Implementation plan |
| 9 | Add `schemaVersion` to persisted state | MEDIUM | Implementation |
| 10 | Design graceful shutdown strategy | MEDIUM | Implementation |

---

## Overall Assessment

The architecture is **well-designed and comprehensive** — all 5 models praised the hybrid Pipeline/EventBus pattern, type-driven design, and extensibility model. The unanimous CONDITIONAL verdict reflects a handful of addressable gaps, not fundamental design flaws. The two CRITICAL items (`sendMessageDraft` verification and dedup race) are straightforward to resolve. The HIGH items are mostly about adding explicit documentation for decisions that are implicitly correct (single-process, backpressure) or adjusting optimistic targets (voice latency).

**Recommendation**: Update the architecture document with the 7 action items marked HIGH+, then proceed to implementation.
