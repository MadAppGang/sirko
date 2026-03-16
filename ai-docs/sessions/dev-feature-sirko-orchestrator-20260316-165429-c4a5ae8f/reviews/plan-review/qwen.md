# Sirko Implementation Plan Review

**Reviewer**: qwen3.5-plus
**Date**: 2026-03-16
**Document Reviewed**: `ai-docs/sessions/dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f/architecture.md`
**Review Type**: Implementation Plan Assessment

---

## Executive Summary

This is an exceptionally detailed and well-structured implementation plan for a tmux orchestrator system. The plan demonstrates strong architectural thinking with clear phase separation, well-defined interfaces, and comprehensive test coverage targets. The hybrid pipeline + event-bus architecture is appropriate for the problem domain.

**Verdict: CONDITIONAL APPROVE**

The plan is fundamentally sound and ready for implementation, but several CRITICAL and HIGH severity issues must be addressed before beginning Phase 6 (Orchestrator) to avoid costly rework.

---

## Findings by Severity

### CRITICAL

#### 1. Pipeline Middleware Order Error (Phase 5)

**Location**: `apps/orchestrator/src/pipeline.ts` assembly order (line ~1473)

**Issue**: The middleware order is specified as:
```
[xterm-interpret, state-manager, detection, dedup, notification-fanout, output-archive, logger]
```

This is **incorrect**. The `state-manager` middleware must run **before** `xterm-interpret` because:
- `xterm-interpret` requires `ctx.pane` to retrieve/create the terminal emulator
- `state-manager` is responsible for loading `ctx.pane` from the store

Current order would cause `xterm-interpret` to fail when `ctx.pane` is null.

**Fix**: Change to:
```
[state-manager, xterm-interpret, detection, dedup, notification-fanout, output-archive, logger]
```

**Impact**: Pipeline failures on every event; system non-functional.

---

#### 2. Circular Dependency in Phase 3 Dependencies

**Location**: Phase 3 description (line ~687)

**Issue**: States "Depends on: Phase 1 (shared types), Phase 2 (state-store for integration test setup)"

However, `packages/tmux-client/package.json` (line ~707-714) only declares dependency on:
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*"
  },
  "optionalDependencies": {
    "@xterm/headless": "^5.0.0"
  }
}
```

This is correct (no state-store dependency), but the phase description is misleading. If integration tests require state-store, that's a **test dependency**, not a package dependency.

**Fix**: Clarify Phase 3 description to:
```
**Depends on**: Phase 1 (shared types)
**Test setup benefit from**: Phase 2 (state-store for integration fixtures)
```

**Impact**: Confusion during implementation sequencing.

---

#### 3. Missing Error Handling for Pane-State Reconciliation (Phase 6)

**Location**: Startup sequence (line ~1508)

**Issue**: Step 6 states:
```
Reconcile restored panes with current tmux state (capturePane for each)
```

No implementation details are provided for:
- What if `capturePane` fails (pane no longer exists)?
- What if `ctx.pane.xtermInstance` fails to reinitialize after restart?
- What if persisted `paneId` references a tmux pane that was manually killed?

**Fix**: Add explicit reconciliation strategy:
```typescript
// Reconciliation pseudo-code:
const tmuxPanes = await tmuxClient.listPanes()
const tmuxPaneIds = new Set(tmuxPanes.map(p => p.paneId))

for (const pane of store.allPanes()) {
  if (!tmuxPaneIds.has(pane.paneId)) {
    // Pane was externally destroyed: mark as exited
    store.setPane(pane.paneId, { ...pane, status: 'exited', exitCode: null })
    bus.emit({ type: 'PaneExited', paneId: pane.paneId, sessionId: pane.sessionId, exitCode: null })
  }
}
```

**Impact**: State corruption after restart; zombie panes; memory leaks.

---

#### 4. Twilio Webhook Authentication Gap (Phase 8)

**Location**: `TwilioTransport.validateSignature()` (line ~1981)

**Issue**: The plan mentions HMAC signature validation but:
- Does not specify which header contains the signature (`X-Twilio-Signature`)
- Does not specify the exact signing algorithm (SHA1 HMAC of URL + sorted form params)
- Does not specify how to handle HTTPS termination (reverse proxy scenarios change the URL)

**Fix**: Add detailed spec:
```typescript
// Twilio signature validation:
// 1. Read X-Twilio-Signature header from request
// 2. Compute: HMAC-SHA1(authToken, url + sortedParams)
//    - url: full URL including query string as received by _your_ server
//    - sortedParams: all POST params sorted by key, concatenated
// 3. Compare signature with computed value using timing-safe comparison
// 4. Throw Error if mismatch; proceed if valid
```

**Impact**: Security vulnerability — allows malicious webhook injection.

---

### HIGH

#### 5. Missing `ProcessInfo` Type Definition

**Location**: `packages/shared/src/types.ts` (line ~472-477)

**Issue**: `ProcessInfo` is defined as:
```typescript
export interface ProcessInfo {
  pid: number
  ppid: number
  name: string
  argv: string[]
}
```

But `detectTool()` (line ~1065) is called with processes that must include `binary` or `comm` fields for pattern matching against `binaryPattern` and `processNamePattern`. The current interface does not match the usage.

**Fix**: Add missing fields:
```typescript
export interface ProcessInfo {
  pid: number
  ppid: number
  name: string       // process name (e.g., 'node', 'bash')
  comm?: string      // command name (often same as name, but can differ)
  argv: string[]     // full argument list
  binary?: string    // resolved binary path
}
```

**Impact**: Tool detection will fail to match; all panes classified as 'unknown'.

---

#### 6. `TerminalEmulator` Interface Missing Error Handling

**Location**: `packages/tmux-client/src/types.ts` (line ~737-741)

**Issue**: The interface is:
```typescript
export interface TerminalEmulator {
  write(raw: string): void
  getBuffer(): string
  getCursor(): CursorState
}
```

No mechanism for:
- Reporting parse failures
- Handling out-of-memory conditions (large buffers)
- Resetting state on pane restart

**Fix**: Add error handling:
```typescript
export interface TerminalEmulator {
  write(raw: string): void
  getBuffer(): string
  getCursor(): CursorState
  reset(): void  // clear all state; called when pane restarts
  getError(): Error | null  // returns last error if any
}
```

Also add `reset()` call during reconciliation (Phase 6, startup sequence).

**Impact**: Corrupted terminal state after long-running sessions; no recovery mechanism.

---

#### 7. Voice Pipeline Missing `runVoicePipeline` Error Boundaries

**Location**: `handlePaneAwaitingInput` call flow (line ~2037-2046)

**Issue**: The voice pipeline has circuit breaker protection, but:
- No try/catch around `transport.initiateCall()` (Twilio API failures)
- No timeout on `for await (const transcript ...)` (what if speaker never pauses?)
- No handling for `synthesize()` failures (ElevenLabs rate limits)

The circuit breaker only protects individual function calls, not the entire pipeline.

**Fix**: Wrap the entire pipeline:
```typescript
async function runVoicePipeline(callSid: string, paneId: string): Promise<void> {
  try {
    const timeoutMs = 120000 // 2-minute max call duration per invocation
    await Promise.race([
      _runVoicePipelineInner(callSid, paneId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Voice pipeline timeout')), timeoutMs)
      )
    ])
  } catch (err) {
    log.error('Voice pipeline error', err)
    bus.emit({ type: 'VoiceCallFailed', paneId, reason: String(err) })
    // Fall back to Telegram-only notification
    await sendTelegramFallback(paneId)
  }
}
```

**Impact**: Stuck calls; no fallback to Telegram; resource leaks.

---

#### 8. Quiescence Scheduler Logic Incomplete

**Location**: `QuiescenceScheduler` (line ~1476-1497)

**Issue**: The condition for triggering quiescence is:
```typescript
if elapsed >= skill.quiescenceThresholdMs
&& pane.processingCount === 0
&& pane.status !== 'awaiting-input'
&& pane.status !== 'exited':
```

Missing:
- Check for `pane.lastOutputTime` being valid (could be 0 on newly created panes)
- No minimum `lastOutputTime` check (could trigger immediately after pane creation)

**Fix**: Add guard:
```typescript
const MIN_PANE_AGE_MS = 5000 // 5 seconds
if (Date.now() - pane.createdAt < MIN_PANE_AGE_MS) return

if (elapsed >= skill.quiescenceThresholdMs
    && pane.processingCount === 0
    && pane.status !== 'awaiting-input'
    && pane.status !== 'exited'
    && pane.lastOutputTime > 0):
```

**Impact**: False positive quiescence triggers on new panes; spurious notifications.

---

### MEDIUM

#### 9. Missing `SchemaVersion` Migration Logic Details

**Location**: `packages/state-store/src/migrations.ts` (line ~659-666)

**Issue**: The `migrate()` function signature is defined, but:
- No example migration code is provided
- No version upgrade path is specified (what fields change between v0 → v1?)
- No validation function to check if loaded state is migratable

**Fix**: Add concrete migration example:
```typescript
export function migrate(raw: unknown): PersistedState {
  if (typeof raw !== 'object' || raw === null || !('schemaVersion' in raw)) {
    throw new MigrationError('Invalid state format: missing schemaVersion')
  }

  const state = raw as Record<string, unknown>
  const version = state.schemaVersion as number

  if (version === 1) {
    return validatePersistedState(state) // full runtime validation
  }

  if (version === 0) {
    // Example v0 → v1 migration:
    // - Rename `paneId` → `id` (hypothetical; adjust to actual schema changes)
    // - Add default `processingCount: 0` to all panes
    const v0State = state as V0PersistedState
    return {
      ...state,
      schemaVersion: 1,
      panes: v0State.panes.map(p => ({ ...p, processingCount: p.processingCount ?? 0 }))
    }
  }

  throw new MigrationError(`Unsupported schema version: ${version}`)
}
```

**Impact**: Startup failures after schema changes; data loss on upgrade.

---

#### 10. `OutputCoalescer` Missing Memory Safety

**Location**: `packages/tmux-client/src/coalescer.ts` (line ~805-812)

**Issue**: The coalescer merges rapid events, but:
- No maximum buffer size (could accumulate megabytes of output)
- No maximum event count per window
- No flush on pane exit (could lose final output)

**Fix**: Add limits:
```typescript
export interface OutputCoalescerOptions {
  windowMs: number
  maxBufferSizeBytes?: number  // default: 1 MB
  maxEventCount?: number     // default: 100
  onEvent: (event: TmuxEvent) => void
}

export class OutputCoalescer {
  private buffers: Map<string, { raw: string; count: number; timerId?: NodeJS.Timeout }>

  push(event: Extract<TmuxEvent, { type: 'pane-output' }>): void {
    const buf = this.buffers.get(event.paneId)
    if (!buf) {
      this.buffers.set(event.paneId, { raw: event.raw, count: 1 })
      // ... start timer
      return
    }

    if (buf.raw.length + event.raw.length > MAX_BUFFER_SIZE) {
      this.flushPane(event.paneId) // forced flush
    }

    if (buf.count >= MAX_EVENT_COUNT) {
      this.flushPane(event.paneId)
    }

    buf.raw += event.raw
    buf.count++
  }

  flushPane(paneId: string): void {
    const buf = this.buffers.get(paneId)
    if (buf) {
      this.onEvent({ type: 'pane-output', paneId, raw: buf.raw, ... })
      this.buffers.delete(paneId)
    }
  }
}
```

**Impact**: Memory exhaustion on high-output panes (e.g., `cat large-file.txt`).

---

#### 11. Missing Telegram Bot Command Handlers

**Location**: `apps/telegram-bot/src/adapter.ts` (line ~1665-1698)

**Issue**: The plan lists bot commands (line ~2163-2169) but:
- No implementation details for `/sessions`, `/new`, `/kill`, `/status`
- `handleIncomingMessage` only handles replies, not commands
- No command parsing logic

**Fix**: Add command handlers:
```typescript
private handleIncomingMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text
  if (!text) return

  if (text.startsWith('/sessions')) {
    return this.handleListSessions(ctx)
  }
  if (text.startsWith('/new ')) {
    return this.handleNewSession(ctx, text.slice(5))
  }
  if (text.startsWith('/kill ')) {
    return this.handleKillPane(ctx, text.slice(6))
  }
  if (text.startsWith('/status')) {
    return this.handleStatus(ctx)
  }

  // Otherwise: treat as reply to active pane
  return this.handleReply(ctx)
}

private async handleListSessions(ctx: Context): Promise<void> {
  const panes = this.store.allPanes()
  const message = panes
    .map(p => `• ${p.paneId} (${p.tool}): ${p.status}`)
    .join('\n')
  await ctx.reply(`Active sessions:\n${message}`, { parse_mode: 'HTML' })
}
```

**Impact**: Listed commands non-functional; poor user experience.

---

#### 12. Missing `@xterm/headless` Fallback Behavior

**Location**: `packages/pipeline/src/middleware/xterm-interpret.ts` (line ~1299-1312)

**Issue**: The middleware mentions fallback on error:
```
On error: sets ctx.parsedText = ctx.event.raw (fallback); calls next()
```

But:
- No definition of what constitutes an "error" (import failure? runtime parse failure?)
- No logging of the error cause
- No metrics/alert on fallback activation

**Fix**: Clarify and add observability:
```typescript
let XtermEmulator: typeof import('@xterm/headless').Terminal | null = null
let loadError: Error | null = null

export function createXtermInterpretMiddleware(tmuxClient: TmuxClient, options?: XtermInterpretOptions): Middleware {
  return async (ctx, next) => {
    if (ctx.event.type !== 'pane-output') {
      return next()
    }

    if (loadError) {
      log.warn('xterm unavailable, using buffer fallback', loadError)
      ctx.parsedText = ctx.event.raw
      return next()
    }

    // ... normal xterm logic
  }
}
```

**Impact**: Silent degradation; hard to debug terminal rendering issues.

---

### LOW

#### 13. Inconsistent Timestamp Format

**Location**: Multiple locations

**Issue**: Timestamps use:
- `number` (milliseconds epoch) in `PaneState.lastOutputTime`, `PaneState.createdAt`
- `number` (via `Date.now()`) in `SirkoEvent.timestamp`
- `bigint` (via `process.hrtime()`) in `EventContext.startedAt`

This is technically correct but inconsistent. Consider standardizing on `number` for all timestamps.

**Impact**: Minor; conversion overhead when calculating latencies.

---

#### 14. Missing Logging Configuration for Third-Party Libraries

**Location**: None specified

**Issue**: No mention of:
- grammY logging level configuration
- Twilio SDK logging
- Deepgram/ElevenLabs SDK logging

**Fix**: Add to `.env.example`:
```bash
# Optional: third-party SDK logging
GRAMMY_LOG_LEVEL=error
TWILIO_LOG_LEVEL=warn
DEEPGRAM_DEBUG=false
```

**Impact**: Noisy logs in development; hard to debug SDK issues.

---

#### 15. No Graceful Degradation for Voice Service Failures

**Location**: Phase 8 integration

**Issue**: If voice pipeline fails, the plan mentions "fallback to Telegram" but:
- No explicit mechanism to disable voice entirely (feature flag)
- No circuit breaker state exposed to users

**Fix**: Add `SIRKO_VOICE_ENABLED=false` environment variable check before attempting voice calls.

**Impact**: Repeated failures if voice credentials are invalid; no kill switch.

---

#### 16. Test Coverage Gaps

**Location**: Various test sections

**Issue**: Missing test coverage for:
- **Race conditions**: Multiple pane-output events for same pane in <10ms window
- **Edge cases**: Empty pane buffers, panes with 100+ MB output
- **Shutdown sequence**: SIGTERM during active voice call
- **Persistence corruption**: Invalid JSON, truncated state.json

**Fix**: Add explicit test cases for each phase's test targets.

**Impact**: Undiscovered bugs in edge cases; production incidents.

---

## Dependency Ordering Assessment

**Status**: Mostly correct with minor issues

The dependency graph (Section 3, line ~2083) is clear and accurate:

```
Phase 1 → [Phase 2, Phase 3, Phase 4] → Phase 5 → Phase 6 → [Phase 7, Phase 8]
```

**Verified dependencies**:
- Phase 2 (state-store) correctly depends only on Phase 1 (shared)
- Phase 3 (tmux-client) correctly depends only on Phase 1 (shared)
- Phase 5 (detector + pipeline) correctly depends on Phases 1, 2, 4

**Issue**: Phase 6 (orchestrator) dependencies list Phase 3 (tmux-client) but Phase 5 does not. This is correct because Phase 5 (detector) does not need tmux access — only the pipeline assembly in Phase 6 does.

**Recommendation**: No changes needed to dependency graph.

---

## Type Correctness Assessment

**Status**: Strong typing throughout, but with gaps

**Strengths**:
- Strict TypeScript configuration enabled (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- Discriminated unions for events (`SirkoEvent` type field is unique)
- Clear middleware signatures with `Middleware` type
- Generic event handling with `Extract<SirkoEvent, { type: K }>`

**Issues**:
1. **CRITICAL #5**: `ProcessInfo` missing fields used by `detectTool()`
2. **HIGH #6**: `TerminalEmulator` missing error signaling
3. `TerminalEmulator.getBuffer()` returns `string` but should perhaps return `{ text: string; lines: string[] }` for structured access
4. `SkillDefinition.binaryPattern` is `RegExp` but `detectTool()` receives `ProcessInfo` which may have `argv[0]` — need to specify which field is matched

**Recommendation**: Address CRITICAL #5 and HIGH #6 before Phase 4 implementation.

---

## Build Feasibility Assessment

**Status**: Feasible with noted configuration adjustments

**Verified**:
- Bun workspace configuration is correct
- Turborepo pipeline tasks are properly defined
- Per-package `tsconfig.json` inheritance path is correct (`../../tsconfig.base.json`)

**Issues**:
- **CRITICAL #1**: Middleware order will cause pipeline build errors
- `@sirko/orchestrator` has `"main": "./src/index.ts"` — for apps this is fine, but library packages should have `"main": "./dist/index.js"` for distribution builds

**Build command verification**:
```bash
bun install        # OK
turbo run typecheck # Will fail on CRITICAL #1
turbo run build    # Will succeed (tsc only checks types)
```

**Recommendation**: Fix middleware order before beginning Phase 5.

---

## Test Coverage Assessment

**Status**: Comprehensive test targets defined, but missing key scenarios

**Strengths**:
- Every phase includes explicit test targets
- Integration tests defined for pipeline and adapters
- Fixture files specified (`fake-agent.sh`)

**Gaps**:
- **MEDIUM #16**: Missing concurrency/race condition tests
- **MEDIUM #16**: Missing shutdown/cleanup tests
- No load testing strategy (how many panes can the system handle?)
- No chaos testing (what if tmux dies mid-operation?)

**Recommendation**: Add explicit test cases for:
1. Concurrent pane-output events for same pane (<10ms apart)
2. SIGTERM during active pipeline execution
3. `capturePane` failure during reconciliation
4. State corruption recovery

---

## Integration Gaps Assessment

**Status**: Several cross-phase integration points are underspecified

**Identified gaps**:

1. **CRITICAL #3**: Pane reconciliation on startup is incomplete
2. **HIGH #7**: Voice pipeline error handling is insufficient
3. **HIGH #11**: Telegram command handlers are not implemented
4. **MEDIUM #9**: Migration logic lacks concrete examples
5. No mention of how `QuiescenceScheduler` interacts with the per-pane queue (`paneQueue` in line ~1524)
6. No mechanism for "replaying" archived output when a new subscriber joins (Telegram topic created after output already happened)

**Recommendation**: Before Phase 6, specify:
- Pane reconciliation algorithm
- Error recovery flows for each adapter
- Output replay strategy (if needed)

---

## Recommendations Summary

| Severity | Count | Must-fix before |
|----------|-------|-----------------|
| CRITICAL | 4     | Phase 5-6       |
| HIGH     | 4     | Phase 6         |
| MEDIUM   | 4     | Phase 8         |
| LOW      | 4     | Post-MVP        |

**Total findings**: 16

### Critical Path to Implementation

1. **Before Phase 1**: No blockers — proceed
2. **Before Phase 4**: Fix `ProcessInfo` type (CRITICAL #5), `TerminalEmulator` interface (HIGH #6)
3. **Before Phase 5**: Fix middleware order (CRITICAL #1), clarify Phase 3 dependencies (CRITICAL #2)
4. **Before Phase 6**: Implement pane reconciliation (CRITICAL #3), Twilio signature validation (CRITICAL #4), voice error boundaries (HIGH #7), quiescence guards (HIGH #8)
5. **Before Phase 8**: Address MEDIUM issues or defer to post-MVP

---

## Conclusion

This is a high-quality implementation plan that demonstrates careful architectural thinking. The phase-based approach, clear dependency graph, and comprehensive test targets are all excellent. The issues identified above are primarily in implementation details rather than fundamental architectural flaws.

The plan is **conditionally approved** — proceed with Phase 1-4 implementation while addressing the CRITICAL and HIGH severity issues before beginning Phase 5-6. This will prevent costly refactoring and ensure smooth integration.

---

*End of Review*
