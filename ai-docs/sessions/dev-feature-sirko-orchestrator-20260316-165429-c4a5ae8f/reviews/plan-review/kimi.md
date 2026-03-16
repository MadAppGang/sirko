# Sirko Implementation Plan Review

**Review Date**: 2026-03-16
**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Plan Source**: ai-docs/sessions/dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f/architecture.md
**Verdict**: **CONDITIONAL**

---

## Summary

The implementation plan is comprehensive and well-structured, covering 8 phases from monorepo scaffold through voice pipeline integration. The architecture follows good separation of concerns with clear package boundaries. However, several issues must be addressed before implementation proceeds, including critical gaps in error handling, type consistency, and integration edge cases.

---

## 1. Completeness

### CRITICAL

| Issue | Location | Description | Recommendation |
|-------|----------|-------------|----------------|
| Missing error handling strategy | Phase 6 (orchestrator) | No documented strategy for critical failures (state-store persist fails, tmux disconnects, disk full) | Define fallback behaviors: if persist fails, log error and continue with in-memory state only; if tmux disconnects, exponential backoff retry |
| Missing migration framework details | Phase 2 (state-store) | `migrations.ts` is mentioned but implementation pattern undefined | Specify incremental migration pattern: v0→v1, v1→v2 functions; store schemaVersion in state; validate after migration |
| Missing process supervision | Phase 6 | No strategy for handling hung pane processes | Add `SIRKO_PANE_TIMEOUT_MS` config; document SIGTERM escalation to SIGKILL after timeout |

### HIGH

| Issue | Location | Description | Recommendation |
|-------|----------|-------------|----------------|
| Missing deployment documentation | Section 6 | No containerization, systemd service, or deployment scripts | Add Dockerfile and docker-compose.yml templates; document environment requirements |
| Missing health check endpoint | Phase 8 (voice-server) | Only basic `/health` mentioned; no readiness/liveness probes | Define `/health/ready` (tmux connected, store loaded) and `/health/live` (process responding) |
| Missing log rotation | Section 5.2 | Logs append indefinitely with no cleanup strategy | Add `SIRKO_LOG_RETENTION_DAYS` (default 30); document rotation using logrotate or internal cleanup |

### MEDIUM

| Issue | Location | Description | Recommendation |
|-------|----------|-------------|----------------|
| No graceful degradation for optional deps | Phase 3, 5 | `@xterm/headless` and `strip-ansi` are optional but no fallback behavior defined | Document that BufferEmulator fallback must work without optional deps; add feature detection |
| Missing tmux server restart handling | Phase 3 | No documented behavior when tmux server restarts (pane IDs change) | Add session reconciliation on reconnect: match by session name + window index + pane index |
| Unbounded state growth | Phase 2 | Old exited panes accumulate in state.json forever | Add `SIRKO_STATE_RETENTION_DAYS` (default 7); prune exited panes older than threshold |

---

## 2. Dependency Ordering

### HIGH

| Issue | Description | Impact |
|-------|-------------|--------|
| Phase 3 claims no Phase 2 dependency | Section 2.3 states Phase 3 "Depends on: Phase 1 (shared types), Phase 2 (state-store for integration test setup)" but Phase 3 is tmux-client which shouldn't need state-store | Creates confusion about actual dependencies. Remove state-store from Phase 3 dependencies; integration tests can use tmpdir-based StateStore without formal dependency |
| Circular dependency risk | detector → tool-plugins; pipeline → detector; orchestrator → pipeline | Verified: no actual circular dependency exists, but visual dependency graph (Section 3) could be clearer about directionality |

### MEDIUM

| Issue | Description | Recommendation |
|-------|-------------|----------------|
| Phase 5 pipeline dependencies | Pipeline middleware needs detector engine but Phase 5 description doesn't emphasize this | Add explicit note: "Pipeline detection middleware requires DetectorEngine from Phase 5 detector package" |

---

## 3. Type Correctness

### CRITICAL

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| `PaneState.xtermInstance: unknown` | Section 2.1 | Using `unknown` prevents type-safe usage; TerminalEmulator interface is defined but not linked | Define `XtermInstance = TerminalEmulator \| null` in shared/types.ts; import TerminalEmulator interface from tmux-client types |
| Missing `sessionId` in TmuxEvent types | Phase 3 (parser.ts) | `window-add` and `window-close` events don't include sessionId in the type, but implementation shows it's populated | Update TmuxEvent type definitions to include `sessionId: string` for all relevant events |
| `SignalBreakdown.contribution` undefined semantics | Section 2.1 | Contribution field has no documented calculation formula | Define: `contribution = signalScore * weight / totalScore` or remove if unused |

### HIGH

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| `Platform` type too restrictive | Phase 5 (wchan.ts) | Only 'macos' \| 'linux' supported; what about WSL, FreeBSD, or unsupported platforms? | Add `'unknown'` to Platform union; implement graceful fallback when platform detection fails |
| `CursorState.visible` population unclear | Section 2.1 | No explanation how cursor visibility is determined from tmux/xterm | Document: xterm cursor visibility is tracked via DECSET/DECRST sequences (DECTCEM); BufferEmulator always returns `true` |

### MEDIUM

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| `ProcessingCount` not atomic | Phase 2 | No synchronization primitive for increment/decrement across async operations | Use Atomics or document that all state mutations happen on single event loop (no parallelism) |
| `SideEffect` union missing metadata | Phase 5 (context.ts) | No way to correlate side effects with original event | Add `correlationId: string` field to all SideEffect variants |

---

## 4. Build Feasibility

### CRITICAL

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| Turbo env var caching | Section 1.3 | `turbo.json` test task lists all env vars but this causes cache invalidation on every token change | Split test tasks: unit tests (no env) cached; integration tests (with env) uncached or use `--force` |
| Bun workspace source resolution | Section 1.6 | `"main": "./src/index.ts"` works for Bun but may fail for tools expecting compiled JS | Add note: production builds use `tsc` output in `dist/`; development uses source directly |
| Voice server port hardcoded | Phase 8 | Port 3000 is default but not configurable | Add `SIRKO_VOICE_HTTP_PORT` to env vars (already listed in Section 5.1) and use in Fastify setup |

### HIGH

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| Optional dependencies treated as required | Phase 3, 5 | `optionalDependencies` in npm still tries to install; Bun behavior differs | Document: users must manually install optional deps if needed; code must handle module resolution failures gracefully |
| No production build artifacts | Section 6 | No Docker image, no compiled bundle for distribution | Add Dockerfile using `oven/bun:slim` base; multi-stage build with `turbo run build` |
| Missing Node.js compatibility | Section 1.4 | `bun-types` is only types; if Bun-specific APIs used, won't run on Node | Audit all Bun-specific APIs (Bun.file, Bun.spawn) and document Node.js incompatibility or provide polyfills |

### MEDIUM

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| Turbo pipeline missing dev dependencies | Section 1.3 | `typecheck` depends on `^build` but per-package typecheck doesn't need build artifacts | Remove `dependsOn: ["^build"]` from typecheck task; keep for test task only |
| Test timeout not configured | Phase test files | Long-running integration tests may hang CI | Add `bunfig.toml` with default timeout or document `--timeout` flag usage |

---

## 5. Test Coverage

### CRITICAL

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| Voice pipeline tests require real APIs | Phase 8 | No mocking strategy defined for Deepgram, ElevenLabs | Create `MockVoiceTransport`, `MockTranscriptionService`, `MockSynthesisService` interfaces; tests use mocks |
| No tmux disconnection test | Phase 3 | Critical failure mode (tmux server dies) has no test coverage | Add test: simulate control-mode disconnect, verify reconnection with exponential backoff |
| Missing state corruption recovery test | Phase 2 | No test for corrupt JSON in state.json | Add test: write invalid JSON to state.json, verify load() starts fresh without throwing |

### HIGH

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| No concurrent pane stress test | Phase 6 | System behavior with 50+ panes undefined | Add integration test: spawn 50 mock panes, verify event ordering and no dropped events |
| No circuit breaker recovery test | Phase 8 | Circuit state transitions need verification | Add test: 3 failures → OPEN → wait 60s → HALF_OPEN → success → CLOSED |
| Missing Telegram API failure test | Phase 7 | No test for network failures, 5xx errors | Add test: mock grammy to throw, verify retry with backoff and eventual failure logging |

### MEDIUM

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| No quiescence scheduling accuracy test | Phase 6 | Timing-sensitive code needs verification | Add test: verify quiescence check runs at configured interval ±10% |
| Missing output archive rotation test | Phase 5 | Log file growth not tested | Add test: simulate 10MB of output, verify rotation or document no rotation needed |

---

## 6. Integration Gaps

### CRITICAL

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| `sendMessageDraft` availability | Phase 7 | Bot API 9.3+ feature may not be available; fallback undefined | Default to `edit` mode; add runtime feature detection: try sendMessageDraft, fall back to edit on error |
| Voice call conflicts with Telegram | Phase 7, 8 | No coordination to prevent duplicate notifications when both adapters are active | Add dedup key: `notification-${paneId}-${timestamp}` with 30-second window; first adapter to claim sends notification |
| Missing `InputDelivered` reset mechanism | Section 2.6 (integration test #4) | Documented test expects InputDelivered to reset dedup, but mechanism unclear | Verify: telegram-bot and voice-server must emit `InputDelivered` event after successful `sendKeys`; dedup middleware listens for this event |

### HIGH

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| No multi-instance coordination | Phase 6 | Running two orchestrators would cause duplicate Telegram topics, conflicting state writes | Document: only one orchestrator per tmux server; add lock file at `~/.sirko/lock` with PID |
| Webhook URL validation missing | Phase 8 | `TWILIO_WEBHOOK_BASE_URL` must be HTTPS for production but not validated | Add validation: reject http:// URLs unless `NODE_ENV=development` |
| Missing audio format negotiation | Phase 8 | Twilio uses μ-law 8kHz; no runtime format checking | Verify: TwilioTransport validates incoming audio format matches expected; throws descriptive error on mismatch |

### MEDIUM

| Issue | Location | Problem | Fix |
|-------|----------|---------|-----|
| No session name collision handling | Phase 3 | Creating session "main" when one exists causes tmux error | Document: orchestrator assumes it manages all tmux sessions; if colliding session exists, attach to it instead of creating |
| Missing call queue prioritization | Phase 8 | All voice calls have equal priority | Document: FIFO queue is acceptable for MVP; priority based on tool confidence is post-v1 |
| No voice pipeline interruption handling | Phase 8 | User hanging up mid-synthesis leaves orphaned audio stream | Add abort signal: `VoiceAdapter.stop()` cancels all active pipelines; TwilioTransport detects disconnect and aborts generators |

---

## Positive Findings

1. **Excellent phase granularity**: 25-35 minute phases are appropriately sized for focused implementation sessions
2. **Clear quality gates**: Each phase has explicit verification commands
3. **Good type safety**: Extensive use of discriminated unions (SirkoEvent, TmuxEvent, SideEffect)
4. **Thoughtful middleware pipeline**: Koa-style compose enables clean separation of concerns
5. **Comprehensive environment variable documentation**: Section 5.1 covers all configuration needs

---

## Recommendations Before Implementation

### Must Fix (Blocking)

1. **Define error handling strategy** for critical path failures (state persist, tmux disconnect)
2. **Fix type definition** for `PaneState.xtermInstance` to use proper TerminalEmulator type
3. **Document mock strategy** for voice pipeline external dependencies
4. **Add runtime feature detection** for `sendMessageDraft` with fallback
5. **Implement notification deduplication** mechanism between Telegram and voice adapters

### Should Fix (High Priority)

1. Add log rotation and state retention configuration
2. Define health check endpoints for orchestrator readiness
3. Create Dockerfile for deployment
4. Add tmux disconnection recovery test
5. Document multi-instance prevention strategy

### Could Fix (Nice to Have)

1. Add stress tests for concurrent pane handling
2. Implement session name collision resolution
3. Add performance benchmarks for detection pipeline

---

## Verdict: CONDITIONAL

The plan is **approved for implementation** once the following are addressed:

1. Add error handling strategy document (Section 2.6 append: "Error Handling and Recovery")
2. Fix `PaneState.xtermInstance` type and add missing `sessionId` to TmuxEvent types
3. Add mock interfaces for voice pipeline testing
4. Document notification deduplication mechanism between adapters
5. Add runtime feature detection for Telegram streaming modes

These changes can be made as amendments to the existing plan without requiring re-architecture.

---

*Review completed by: kimi-k2.5*
*Review date: 2026-03-16*
