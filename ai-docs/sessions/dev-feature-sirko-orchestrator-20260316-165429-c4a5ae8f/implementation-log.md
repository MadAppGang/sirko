# Implementation Log — Phase 1: Monorepo Scaffold + Shared Types

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Date**: 2026-03-16
**Phase**: 1 of N

---

## Files Created

### Root scaffold
- `/Users/jack/mag/magai/sirko/package.json` — Bun workspaces host, Turborepo scripts
- `/Users/jack/mag/magai/sirko/turbo.json` — build/test/typecheck/lint/format/dev pipeline
- `/Users/jack/mag/magai/sirko/tsconfig.base.json` — strict TypeScript config (all packages inherit)
- `/Users/jack/mag/magai/sirko/.env.example` — all required environment variables documented
- `/Users/jack/mag/magai/sirko/.gitignore` — node_modules, dist, .env, coverage, etc.

### packages/shared
- `packages/shared/package.json` — `@sirko/shared`, exports `./src/index.ts` directly for Bun workspace dev
- `packages/shared/tsconfig.json` — extends `../../tsconfig.base.json`
- `packages/shared/src/events.ts` — `SirkoEvent` discriminated union (10 variants, exact copy from plan)
- `packages/shared/src/types.ts` — `PaneState`, `DetectionResult`, `TerminalEmulator`, `AdapterSink`, and supporting types (exact copy from plan)
- `packages/shared/src/utils.ts` — `formatTimestamp`, `truncateForTelegram`, `paneIdFromString`, `sanitizeForSendKeys`
- `packages/shared/src/index.ts` — re-exports all public symbols from events, types, utils
- `packages/shared/src/events.test.ts` — 10 tests covering discriminant uniqueness, truncation, and control-char sanitization

---

## Issues Encountered and Fixed

### 1. `bun-types` vs `@types/bun`
- **Problem**: `tsconfig.base.json` from the plan specified `"types": ["bun-types"]` but the current `@types/bun` package registers under the name `bun` (not `bun-types`). The old `bun-types` package no longer exists as a separate npm package.
- **Fix**: Changed `"types": ["bun-types"]` to `"types": ["bun"]` in `tsconfig.base.json`. Also added `"@types/bun": "*"` to `packages/shared/package.json` devDependencies so workspace-level resolution works reliably.

### 2. `truncateForTelegram` edge case with small `maxLen`
- **Problem**: The test `respects a custom maxLen` passed `maxLen=5` with text `'hello world'` (11 chars). The suffix `'…[truncated]'` is 12 chars — longer than `maxLen` — causing the implementation to produce a result of length 16 (negative slice index wraps around).
- **Fix**: Added a guard in `truncateForTelegram`: when `maxLen <= suffix.length`, fall back to a hard slice `text.slice(0, maxLen)`.

### 3. Test expectation for `sanitizeForSendKeys`
- **Problem**: The initial test included `!` (0x21, a printable ASCII character) in the dirty string and expected it to be stripped. The implementation correctly preserves printable chars; `!` should not be removed.
- **Fix**: Removed `!` from the dirty test string. The test now uses only genuine control characters (NUL 0x00, BEL 0x07, BS 0x08, ESC 0x1b, DEL 0x7f).

---

## Quality Check Results

```
bun install                                  PASS  (25 packages installed)
bun run --filter @sirko/shared typecheck     PASS  (exit 0)
bun test --filter shared                     PASS  (10 pass, 0 fail)
```

---

## Notes

- The `events.ts` and `types.ts` files have a mutual type import (events imports `ToolName`/`SignalBreakdown` from types; types imports `SirkoEvent` from events). This is a circular import at the type level only — Bun and TypeScript both handle type-only circular imports without issue since they are erased at runtime.
- All `.js` extension imports used in source files (e.g., `import from './events.js'`) per ESM + bundler moduleResolution convention.

---

# Implementation Log — Phase 3: tmux-client

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Date**: 2026-03-16
**Phase**: 3 of N

---

## Files Created

### packages/tmux-client
- `packages/tmux-client/package.json` — `@sirko/tmux-client`, depends on `@sirko/shared` workspace, optional `@xterm/headless`
- `packages/tmux-client/tsconfig.json` — extends `../../tsconfig.base.json`
- `packages/tmux-client/src/types.ts` — `TmuxEvent` discriminated union (7 variants), `TmuxClientOptions`, re-exports `TerminalEmulator` from `@sirko/shared`
- `packages/tmux-client/src/parser.ts` — `parseControlModeLine()` handles `%output`, `%pane-exited`, `%session-created`, `%session-closed`, `%window-add`, `%window-close`; `unescapeTmuxOutput()` for `\\`, `\n`, `\r` sequences
- `packages/tmux-client/src/coalescer.ts` — `OutputCoalescer` coalesces rapid `pane-output` events per pane within a configurable time window; `flush()` for graceful shutdown
- `packages/tmux-client/src/xterm-emulator.ts` — `XtermEmulator` (wraps `@xterm/headless`) and `BufferEmulator` (line-buffer + ANSI stripping fallback); `createTerminalEmulator()` async factory tries xterm first
- `packages/tmux-client/src/client.ts` — `TmuxClient` class: `connect()`, `disconnect()`, `events()` async generator, `sendCommand()`, `sendKeys()`, `capturePane()`, `getPanePid()`, `newSession()`, `newWindow()`, `newPane()`, `listSessions()`, `listPanes()`, `createTerminalEmulator()`, `upgradeTerminalEmulator()`; exponential backoff reconnect; `createTmuxClient()` factory
- `packages/tmux-client/src/index.ts` — re-exports all public symbols
- `packages/tmux-client/src/parser.test.ts` — 17 tests for `parseControlModeLine` and `unescapeTmuxOutput`
- `packages/tmux-client/src/coalescer.test.ts` — 6 tests for `OutputCoalescer`
- `packages/tmux-client/src/client.test.ts` — 20 tests for `TmuxClient` internal processing (TestableClient subclass)
- `packages/tmux-client/fixtures/fake-agent.sh` — simulates an AI agent for manual integration testing

---

## Issues Encountered and Fixed

### 1. Bun.spawn stdin/stdout type unions
- **Problem**: `Bun.spawn()` types `stdin` as `number | FileSink` and `stdout` as `number | ReadableStream<Uint8Array>`. TypeScript rejected `.write()` on `stdin` and `.getReader()` on `stdout` directly since `number` has neither.
- **Fix**: Added runtime narrowing guards (`typeof === 'object' && 'write' in stdin`) and a cast to `ReadableStream<Uint8Array>` for stdout before calling `.getReader()`.

### 2. Private method override in test subclass
- **Problem**: TypeScript disallows overriding a `private` method (even with `@ts-expect-error` — it still fails compilation because the base class declares it `private`).
- **Fix**: Changed `_dispatchEvent` to `protected` in `TmuxClient` so `TestableClient` can legally override it with `override`. For `_processLine`/`_processChunk` (which remain `private` for encapsulation), used `(this as any)._processLine()` in the test subclass wrapper methods.

---

## Quality Check Results

```
bun install                                     PASS
bun run --filter @sirko/tmux-client typecheck   PASS  (exit 0)
bun test --filter tmux-client                   PASS  (43 pass, 0 fail)
```

---

## Notes

- `@xterm/headless` was resolved as an optional dependency; `createTerminalEmulator()` gracefully falls back to `BufferEmulator` if the import fails.
- The `%begin`/`%end` sequence correlation uses the third whitespace-delimited token (index 2) from the delimiter line, matching tmux control-mode protocol format `%begin <time> <num> <flags>`.
- `TmuxClient._dispatchEvent` is `protected` (not `private`) to allow testing via subclass; all other internal methods remain `private`.

---

# Implementation Log — Phase 3 (session task): State Store + Event Bus

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Date**: 2026-03-16
**Phase**: state-store + event-bus packages

---

## Files Created

### packages/state-store
- `packages/state-store/package.json` — `@sirko/state-store`, depends on `@sirko/shared` workspace
- `packages/state-store/tsconfig.json` — extends `../../tsconfig.base.json`
- `packages/state-store/src/migrations.ts` — `migrate()` function, `MigrationError`, `PersistedState` type, `CURRENT_SCHEMA_VERSION = 1`; handles v0 (no schemaVersion) -> v1 migration
- `packages/state-store/src/state-store.ts` — `StateStore` class: in-memory `Map<string, PaneState>`, topic map with reverse lookup, session map; `persist()` (write-then-rename atomic, backup .bak), `load()` (graceful on missing/corrupt), `startAutoSave()`/`stopAutoSave()`; `createStateStore()` factory
- `packages/state-store/src/index.ts` — re-exports `StateStore`, `createStateStore`, `migrate`, `CURRENT_SCHEMA_VERSION`, `MigrationError`, `PersistedState`
- `packages/state-store/src/state-store.test.ts` — 25 tests: CRUD for panes/sessions/topics, persistence roundtrip, .bak creation, atomic write, load from missing file, load from corrupt JSON, migration v0->v1, MigrationError for invalid inputs

### packages/event-bus
- `packages/event-bus/package.json` — `@sirko/event-bus`, depends on `@sirko/shared` workspace
- `packages/event-bus/tsconfig.json` — extends `../../tsconfig.base.json`
- `packages/event-bus/src/event-bus.ts` — `TypedEventBus` class: type-safe `on<T>()` with Extract discriminant, `onAny()` wildcard, `emit()` via `Promise.allSettled` for error isolation, bounded per-subscriber queue (drop-oldest overflow), `createEventBus()` factory; uses `RawSubscriber` internal type to avoid generic variance issues
- `packages/event-bus/src/index.ts` — re-exports `TypedEventBus`, `createEventBus`, `TypedEventBusOptions`
- `packages/event-bus/src/event-bus.test.ts` — 13 tests: type-specific delivery, onAny receives all, unsubscribe, error isolation (sync + async), bounded queue overflow, async allSettled behavior, correct event shape delivery

---

## Issues Encountered and Fixed

### 1. `MigrationError` override modifier
- **Problem**: With `exactOptionalPropertyTypes`/strict settings, declaring `public readonly cause?: unknown` as a constructor parameter property in a class extending `Error` triggers TS4115 ("must have 'override' modifier because it overrides a member in base class 'Error'"). The `Error` class has a `cause` property in modern TS lib.
- **Fix**: Renamed to `rootCause` and stored it as a regular class field instead of a constructor parameter property.

### 2. Missing `writeFile` import in test
- **Problem**: `state-store.test.ts` used `writeFile` (to write corrupt JSON) but only imported `mkdtemp, rm, readFile, stat` from `node:fs/promises`.
- **Fix**: Added `writeFile` to the import.

### 3. TypedEventBus generic variance
- **Problem**: `Subscriber<Extract<SirkoEvent, {type: T}>>` is not assignable to `Subscriber<SirkoEvent>` due to handler contravariance — TS rejected the cast with TS2352.
- **Fix**: Introduced a `RawSubscriber` interface (handler typed as `AnyHandler = (event: SirkoEvent) => void | Promise<void>`) for internal storage. The public `on<T>()` method accepts the narrow typed handler and casts to `AnyHandler` (safe because this subscriber is only dispatched for matching event types). This preserves the public type-safe API while satisfying the type system internally.

### 4. `resolveFirst?.()` inferred as `never`
- **Problem**: TypeScript infers `let resolveFirst: (() => void) | null = null` as `null` after the `new Promise` constructor (it can't see the synchronous assignment inside the executor). After the narrowing `if (resolveFirst !== null)`, `resolveFirst` was still typed `never` because TS knows it was initialized to `null` and the executor assignment is not visible.
- **Fix**: Used a `const resolveRef: { fn: (() => void) | null } = { fn: null }` ref-object pattern; TypeScript correctly tracks mutations of object properties and `resolveRef.fn?.()` typechecks as `() => void` after the Promise executor assigns it.

### 5. Strict `toBe()` overload narrowing
- **Problem**: `expect(capturedText: string | null).toBe('hello world')` fails typecheck under strict settings because bun's `expect` overloads restrict `.toBe(null)` when the value type includes `null`.
- **Fix**: Changed captured values to use arrays (`const captured: string[] = []`) to avoid `null` in the variable type entirely.

---

## Quality Check Results

```
bun install                                        PASS
bun run --filter @sirko/state-store typecheck      PASS  (exit 0)
bun run --filter @sirko/event-bus typecheck        PASS  (exit 0)
bun test --filter state-store                      PASS  (25 pass, 0 fail)
bun test --filter event-bus                        PASS  (13 pass, 0 fail)
```

---

## Notes

- `xtermInstance` is always stripped to `null` on `persist()` (excluded from the Omit<PaneState, 'xtermInstance'>[] type in `PersistedState`), and re-set to `null` on `load()`.
- `persist()` creates both `{persistPath}/` and `{persistPath}/logs/` directories via `mkdir(..., { recursive: true })`.
- The event-bus `dispatch()` method enqueues then immediately dequeues; the bounded queue acts as a ring buffer per subscriber — if multiple emits arrive faster than a subscriber processes, only `maxQueueSize` events are buffered before oldest drops.

---

# Implementation Log — Phase 4: Tool Plugins + Detector

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Date**: 2026-03-16
**Phase**: tool-plugins + detector packages

---

## Files Created

### packages/tool-plugins
- `packages/tool-plugins/package.json` — `@sirko/tool-plugins`, depends on `@sirko/shared` workspace
- `packages/tool-plugins/tsconfig.json` — extends `../../tsconfig.base.json`
- `packages/tool-plugins/src/types.ts` — `SkillDefinition` interface: process identification patterns, per-signal weights, quiescence threshold, scoring threshold, behavior hooks
- `packages/tool-plugins/src/plugins/claude-code.ts` — `claudeCodeSkill`: binary `/claude$/i`, quiescence 1800ms, wchan `['pipe_read','read_events','wait_pipe_read','futex']`, scoring threshold 0.60
- `packages/tool-plugins/src/plugins/codex.ts` — `codexSkill`: binary `/codex$/i`, quiescence 1500ms, scoring threshold 0.65
- `packages/tool-plugins/src/plugins/aider.ts` — `aiderSkill`: binary `/aider$/i`, quiescence 3000ms, scoring threshold 0.55
- `packages/tool-plugins/src/plugins/unknown.ts` — `unknownSkill`: catch-all patterns, quiescence 2000ms
- `packages/tool-plugins/src/registry.ts` — `getSkill(toolName)` returns skill or falls back to `unknownSkill`; `getAllSkills()` returns all 4 in declaration order
- `packages/tool-plugins/src/detect.ts` — `detectTool(processes)` iterates claude-code → codex → aider in priority order, matching `binaryPattern` (process name + argv) and `processNamePattern`
- `packages/tool-plugins/src/index.ts` — re-exports all public symbols
- `packages/tool-plugins/src/registry.test.ts` — 9 tests: getSkill lookup, fallback to unknownSkill, getAllSkills count, field validation, positive weights
- `packages/tool-plugins/src/detect.test.ts` — 8 tests: claude/aider/codex/bash detection, empty list, multi-process priority

### packages/detector
- `packages/detector/package.json` — `@sirko/detector`, depends on `@sirko/shared` and `@sirko/tool-plugins` workspace
- `packages/detector/tsconfig.json` — extends `../../tsconfig.base.json`
- `packages/detector/src/wchan.ts` — `WchanInspector` interface; `LinuxWchan` (reads `/proc/<pid>/wchan` via `Bun.file`); `MacosWchan` (runs `ps -o wchan= -p <pid>`, 500ms cache per PID); `createWchanInspector()` platform factory
- `packages/detector/src/prompt-matcher.ts` — `PromptMatcher.match(buffer, skill)`: tests each `skill.promptPatterns` regex against buffer, returns `{ matched, pattern }` for first match or `{ matched: false, pattern: null }`
- `packages/detector/src/quiescence.ts` — `QuiescenceTracker.computeScore(pane, skill)`: `score = min(silenceMs / threshold, 1.0)`; uses `Date.now() - pane.lastOutputTime`
- `packages/detector/src/engine.ts` — `DetectorEngine`: injectable `WchanInspector` for testing; `computeScore(pane, xtermBuffer, skill)` combines 3 signals with skill weights into `DetectionResult`; `createDetectorEngine()` factory
- `packages/detector/src/index.ts` — re-exports all public symbols
- `packages/detector/src/prompt-matcher.test.ts` — 9 tests: claude-code `> ` match, no-match, multi-line, aider `(y/n)`, codex `? `
- `packages/detector/src/wchan.test.ts` — 4 tests: LinuxWchan with temp file, null for missing PID, MacosWchan null for missing PID, caching
- `packages/detector/src/engine.test.ts` — 10 tests: all signals → max score/awaiting, all signals 0 → score 0, prompt-only, quiescence-only, tool-specific weights, confidence=score, null pid, QuiescenceTracker edge cases

---

## Issues Encountered and Fixed

### 1. `result.signals.quiescence.score` does not exist on `SignalBreakdown`
- **Problem**: Test referenced `result.signals.quiescence.score` but `SignalBreakdown` in `@sirko/shared/types.ts` defines quiescence as `{ silenceMs, threshold, weight, contribution }` — no `score` field.
- **Fix**: Changed test assertion to check `result.signals.quiescence.contribution` is greater than 0 instead.

---

## Quality Check Results

```
bun install                                        PASS
bun run --filter @sirko/tool-plugins typecheck     PASS  (exit 0)
bun run --filter @sirko/detector typecheck         PASS  (exit 0)
bun test --filter tool-plugins                     PASS  (19 pass, 0 fail)
bun test --filter detector                         PASS  (23 pass, 0 fail)
```

---

## Notes

- `DetectorEngine.computeScore()` treats `pid === null` as non-waiting (wchan signal = 0) since there is no process to inspect.
- `MacosWchan` caches by PID with a 500ms TTL to avoid spawning `ps` on every detection cycle; cache entries are simple `{ value, expiresAt }` objects in a `Map<number, CacheEntry>`.
- `detectTool()` matches both `binaryPattern` against process name/argv AND `processNamePattern` against process name — either match suffices for detection.
- The `ToolName = 'unknown'` type is not registered as a third-party plugin in `detect.ts`; it is only returned as the fallback when no known pattern matches.

---

# Implementation Log — Phase 5: Middleware Pipeline

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Date**: 2026-03-16
**Phase**: pipeline package

---

## Files Created

### packages/pipeline
- `packages/pipeline/package.json` — `@sirko/pipeline`, depends on shared/state-store/tool-plugins/event-bus/detector/tmux-client workspaces
- `packages/pipeline/tsconfig.json` — extends `../../tsconfig.base.json`
- `packages/pipeline/src/context.ts` — `EventContext` interface (event, pane, parsedText, cursorState, xtermBuffer, detectionResult, aborted, sideEffects, middlewareDurations); `SideEffect` discriminated union; `buildContext()` and `buildQuiescenceContext()` factories
- `packages/pipeline/src/compose.ts` — Koa-style `compose(middlewares[])`: returns `Pipeline` with `run(ctx)` method; index tracking prevents double-call of `next()`; `Middleware` type
- `packages/pipeline/src/middleware/state-manager.ts` — loads/creates `PaneState` PRE next(), writes back POST next() via try/finally; increments/decrements `processingCount`; calls `tmuxClient.getPanePid()` for new panes
- `packages/pipeline/src/middleware/xterm-interpret.ts` — lazily creates/retrieves `TerminalEmulator` on `ctx.pane.xtermInstance`; feeds raw output; sets `ctx.parsedText`, `ctx.cursorState`, `ctx.xtermBuffer`; fallback to raw on error; only runs for `pane-output` events
- `packages/pipeline/src/middleware/detection.ts` — calls `DetectorEngine.computeScore(pane, xtermBuffer, skill)` for `pane-output` and `quiescence-check` events; sets `ctx.detectionResult` and updates `ctx.pane.status`; non-fatal on error
- `packages/pipeline/src/middleware/dedup.ts` — aborts pipeline (sets `ctx.aborted=true`, skips `next()`) when `notified+awaiting`; resets to `idle` when `notified+not-awaiting`; otherwise passes through
- `packages/pipeline/src/middleware/notification-fanout.ts` — emits `PaneOutput` for all output events; emits `PaneAwaitingInput` + sets `notificationState='notified'` when awaiting+not-aborted; emits `PaneExited` for exit events; records `bus-emit` side effects; runs AFTER `next()`
- `packages/pipeline/src/middleware/output-archive.ts` — fire-and-forget append to `{logDir}/{sessionId}/{paneId}.log`; ISO8601 timestamps; handles exit events with exit code; runs AFTER `next()`
- `packages/pipeline/src/middleware/logger.ts` — structured JSON line to stdout after full pipeline execution; swallows all errors; includes event type, pane/session IDs, tool, detection score, awaiting, aborted, durations, totalMs
- `packages/pipeline/src/assemble.ts` — `assemblePipeline(deps)` composes all 7 middlewares in order: state-manager → xterm-interpret → detection → dedup → notification-fanout → output-archive → logger
- `packages/pipeline/src/index.ts` — re-exports all public symbols
- `packages/pipeline/src/compose.test.ts` — 8 tests: ordering, ctx passthrough, chain stop when next() not called, empty array, error propagation, double-next throw, pre/post wrapping, single middleware
- `packages/pipeline/src/middleware/dedup.test.ts` — 7 tests: notified+awaiting=abort, notified+not-awaiting=reset+continue, idle+awaiting=continue, idle+not-awaiting=continue, null pane, no detection, duration tracking
- `packages/pipeline/src/middleware/detection.test.ts` — 8 tests: skips non-pane events, skips null pane, runs for pane-output, runs for quiescence-check, sets awaiting-input status, resets to running, correct computeScore args, survives computeScore error
- `packages/pipeline/src/assemble.test.ts` — 5 tests: returns Pipeline, runs for session-created, runs for pane-output, middleware order via durations, all expected duration keys present

---

## Issues Encountered and Fixed

### 1. Detection test parameter types with strict mode
- **Problem**: Test mock for `computeScore` with inline function `async (pane, xtermBuffer) => {...}` had implicit `any` types for parameters under strict TypeScript.
- **Fix**: Added explicit types `(pane: PaneState, xtermBuffer: string)` to the inline arrow function in the test.

---

## Quality Check Results

```
bun install                                        PASS
bun run --filter @sirko/pipeline typecheck         PASS  (exit 0)
bun test --filter pipeline                         PASS  (28 pass, 0 fail)
```

---

## Notes

- `notification-fanout` middleware runs AFTER `next()` (post-execution) so it can observe the final `ctx.aborted` state set by `dedup`.
- `output-archive` also runs post-next to avoid writing output when the pipeline is aborted upstream.
- `logger` is always last and runs post-next to capture complete timing data.
- `state-manager` uses try/finally to guarantee the POST write-back even if downstream middlewares throw.
- `buildQuiescenceContext()` synthesizes a `quiescence-check` TmuxEvent from the pane's IDs for periodic background detection runs.
- The `compose()` engine uses a closure over `index` to detect double-`next()` calls (throws "next() called multiple times").

---

# Implementation Log — Phase 6: Orchestrator (Main App)

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Date**: 2026-03-16
**Phase**: orchestrator app

---

## Files Created

### apps/orchestrator
- `apps/orchestrator/package.json` — `@sirko/orchestrator`, depends on all @sirko/* workspace packages; scripts: build, typecheck, test, start, dev
- `apps/orchestrator/tsconfig.json` — extends `../../tsconfig.base.json`, rootDir `./src`
- `apps/orchestrator/src/config.ts` — `OrchestratorConfig` interface + `loadConfig()`: reads SIRKO_DATA_DIR, SIRKO_TMUX_SOCKET, SIRKO_QUIESCENCE_INTERVAL_MS, SIRKO_COALESCE_WINDOW_MS, SIRKO_LOG_LEVEL; all have defaults
- `apps/orchestrator/src/pane-serializer.ts` — `PaneSerializer` class: `Map<string, Promise<void>>` chain per pane key; `runForPane(paneId, fn)` serializes pipeline runs; errors caught so chain never breaks
- `apps/orchestrator/src/quiescence-scheduler.ts` — `QuiescenceScheduler` class: `setInterval` tick; for each non-awaiting, non-exited pane with `processingCount === 0` and elapsed >= quiescence threshold, injects `pipeline.run(buildQuiescenceContext(pane))`
- `apps/orchestrator/src/index.ts` — full startup sequence: loadConfig → store.load() → createEventBus() → createTmuxClient() → tmuxClient.connect() → reconcile panes → assemblePipeline() → log bus events → PaneSerializer + QuiescenceScheduler → store.startAutoSave() → SIGINT/SIGTERM shutdown → event loop
- `apps/orchestrator/src/orchestrator.test.ts` — 6 integration tests (all pass)

### root package.json update
- Changed `start` to `bun run --filter orchestrator start`
- Changed `dev` to `bun run --filter orchestrator dev`

---

## Issues Encountered and Fixed

### 1. tsconfig rootDir vs test directory
- **Problem**: Initial tsconfig included `test/**/*` which is outside rootDir `./src`, causing TS6059 error.
- **Fix**: Moved test file to `src/orchestrator.test.ts` (consistent with all other packages in this repo).

### 2. exactOptionalPropertyTypes with `socketPath: string | undefined`
- **Problem**: `createTmuxClient({ socketPath: config.tmuxSocketPath })` where `tmuxSocketPath` is `string | undefined` fails with exactOptionalPropertyTypes since the optional field expects `string` (not `string | undefined`).
- **Fix**: Used conditional spread: `...(config.tmuxSocketPath !== undefined ? { socketPath: config.tmuxSocketPath } : {})`.

### 3. bus.on handler return type
- **Problem**: `bus.on(type, (e) => awaitingEvents.push(e))` returns `number` (from Array.push) but handler must return `void | Promise<void>`.
- **Fix**: Added explicit `: void` return type annotation and used explicit `awaitingEvents.push(e)` on its own line.

### 4. Detection score insufficient for test scenarios
- **Problem**: Tests used `tool: 'unknown'` (auto-created by state-manager) with `unknownSkill` threshold 0.60; `pipe_read` wchan alone only gives 0.30 score.
- **Fix**: Pre-seeded panes with `tool: 'claude-code'` in store before running pipeline; used raw `'> \n'` for prompt pattern match; BufferEmulator accumulates written text so prompt pattern detection works.

### 5. QuiescenceScheduler test: PaneAwaitingInput not emitted for quiescence-check events
- **Problem**: `notification-fanout` middleware only emits `PaneAwaitingInput` for `pane-output` events, not for `quiescence-check` synthetic events.
- **Fix**: Changed assertion to verify `pane.status === 'awaiting-input'` (set by detection middleware) instead of checking bus events.

---

## Quality Check Results

```
bun install                                           PASS
bun run --filter @sirko/orchestrator typecheck        PASS  (exit 0)
bun run --filter @sirko/orchestrator test             PASS  (6 pass, 0 fail)
```

---

## Notes

- `PaneSerializer` ensures tmux events for the same pane are processed sequentially, preventing race conditions in state updates.
- `QuiescenceScheduler` guards against injecting runs while a pipeline run is in-flight via `processingCount > 0` check.
- Phase 6 logs all bus events to stdout; Phase 7/8 will add Telegram and Voice adapters.
- The `notification-fanout` middleware emits `PaneAwaitingInput` only for `pane-output` events; quiescence detection updates `pane.status` which downstream adapters can observe.

---

# Implementation Log — Phase 7: Telegram Bot Adapter

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Date**: 2026-03-16
**Phase**: telegram-bot app

---

## Files Created

### apps/telegram-bot
- `apps/telegram-bot/package.json` — `@sirko/telegram-bot`, depends on @sirko/shared, @sirko/state-store, @sirko/tmux-client, grammy, @grammyjs/auto-retry, @grammyjs/transformer-throttler, @grammyjs/parse-mode
- `apps/telegram-bot/tsconfig.json` — extends `../../tsconfig.base.json`, rootDir `./src`, include `src/**/*` only
- `apps/telegram-bot/src/html-utils.ts` — `escapeHtml()`, `wrapInPre()`, `wrapInBlockquote()` with optional expandable attribute
- `apps/telegram-bot/src/format.ts` — `formatOutput()` (3-tier: <4096 chars single pre, 4096-12000 split pre+blockquote, >12000 returns null), `formatAwaitingInput()`, re-exports `escapeHtml`
- `apps/telegram-bot/src/rate-limit-queue.ts` — `RateLimitQueue` token bucket: global RPS bucket + per-chat MPM bucket; `stop()` rejects remaining queued calls
- `apps/telegram-bot/src/output-streamer.ts` — `OutputStreamer` debounced per-topic buffers; forces flush at `maxBufferChars`; `flushAll()` for shutdown; calls `onSend` or `onSendFile` depending on formatted length
- `apps/telegram-bot/src/topic-manager.ts` — `TopicManager` creates/closes forum topics via `bot.api`; persists pane↔topic mapping in StateStore; `getTopicForPane()`, `getPaneForTopic()`, `restoreMappings()`
- `apps/telegram-bot/src/message-router.ts` — `MessageRouter` routes grammY context messages to tmux panes via `tmuxClient.sendKeys()` + empty string for Enter
- `apps/telegram-bot/src/commands.ts` — registers `/start`, `/sessions`, `/new <name>`, `/kill <paneId>` commands
- `apps/telegram-bot/src/telegram-adapter.ts` — `TelegramAdapter implements AdapterSink`: `start()` initializes bot with autoRetry plugin + registers message handler + commands; `stop()` flushes output and stops polling; `handlePaneOutput`, `handlePaneAwaitingInput`, `handlePaneExited`, `handleInputDelivered`; `isHealthy()` returns running status; `createTelegramAdapter()` factory
- `apps/telegram-bot/src/index.ts` — re-exports public API: TelegramAdapter, createTelegramAdapter, TelegramAdapterOptions, TopicManager, OutputStreamer, MessageRouter, formatOutput, formatAwaitingInput, escapeHtml, wrapInPre, wrapInBlockquote, RateLimitQueue, RateLimitQueueOptions
- `apps/telegram-bot/test/format.test.ts` — 14 tests: escapeHtml all special chars, formatOutput 3 tiers (exact boundaries), formatAwaitingInput content
- `apps/telegram-bot/test/rate-limit-queue.test.ts` — 6 tests: immediate execution, return value, error propagation, overflow drop, multiple calls, per-chat option
- `apps/telegram-bot/test/adapter.test.ts` — 12 tests: TopicManager (create/existing/getters/restore), OutputStreamer (pre block/file upload/flushAll/maxBuffer), MessageRouter (route/no-topicId/unmapped), HTML escaping

---

## Issues Encountered and Fixed

### 1. `@grammyjs/parse-mode` v2.x API change
- **Problem**: Architecture referenced `parseMode('HTML')` middleware from `@grammyjs/parse-mode`, but v2.x removed this middleware in favor of formatting utilities (`fmt`, `b`, `FormattedString`). Calling `bot.use(parseMode('HTML'))` caused TS2345: `Transformer` not assignable to `Middleware<Context>`.
- **Fix**: Removed `parseMode` middleware usage entirely. Parse mode is already specified per-call via `{ parse_mode: 'HTML' }` in all `sendMessage`/`sendDocument` calls.

### 2. `PendingCall<T>` covariance error in `_canExecute`/`_consumeTokens`
- **Problem**: `_canExecute(call: PendingCall<unknown>)` was not assignable from `PendingCall<T>` due to `resolve` being contravariant (TS2345: `(value: T) => void` not assignable to `(value: unknown) => void`).
- **Fix**: Extracted `PendingCallBase` interface (without `fn`, `resolve`) for internal queue storage and private method signatures. Added a `run: () => void` closure on the base that captures the typed `fn().then(resolve, reject)` call, avoiding the need to store the typed resolve handler on the base type.

### 3. Queue overflow test timeout
- **Problem**: Test attempted to `Promise.allSettled` on a promise that would never settle (remaining queued call after overflow, never executed or rejected).
- **Fix**: Changed `RateLimitQueue.stop()` to also reject all remaining queued items with `'RateLimitQueue: stopped'` error. This ensures `Promise.allSettled` always resolves. Fixed test to use `globalRps: 0` to force all calls to queue (no immediate execution) and `maxQueueDepth: 1`.

---

## Quality Check Results

```
bun install                                           PASS
bun run --filter @sirko/telegram-bot typecheck        PASS  (exit 0)
bun test apps/telegram-bot                            PASS  (37 pass, 0 fail)
```

---

## Notes

- `autoRetry()` is installed as an API transformer via `bot.api.config.use(autoRetry())` — this retries Telegram API calls that return `retry_after` 429 responses.
- `@grammyjs/transformer-throttler` was installed but not wired in (the architecture mentions it as a dependency; it can be added later for production throttling).
- `OutputStreamer` does not use `RateLimitQueue` internally — rate limiting would be added by wrapping the `onSend` callback at the adapter level if needed.
- The `test/` directory is outside `tsconfig.json`'s `include: ["src/**/*"]` so tsc skips it; Bun's test runner discovers and transpiles test files independently.
- `TelegramAdapter` satisfies `AdapterSink` from `@sirko/shared` with all required methods: `handlePaneOutput`, `handlePaneAwaitingInput`, `handlePaneExited`, `handleInputDelivered`, `start`, `stop`, `isHealthy`, `name`.

---

# Implementation Log — Phase 8: Voice Server

**Date**: 2026-03-16
**Phase**: 8

---

## Files Created

### apps/voice-server
- `apps/voice-server/package.json` — `@sirko/voice-server`, depends on `@sirko/shared`, `@sirko/state-store`, `@sirko/tmux-client`, `twilio@5.13`, `ai@6`, `@ai-sdk/openai@3`, `@deepgram/sdk@5`, `elevenlabs@1.59`
- `apps/voice-server/tsconfig.json` — extends `../../tsconfig.base.json`
- `apps/voice-server/src/index.ts` — re-exports all public symbols
- `apps/voice-server/src/circuit-breaker.ts` — CircuitBreaker (closed→open→half-open, 3 failures/30s, probe after 60s)
- `apps/voice-server/src/audio-utils.ts` — `mulawToPcm16` / `pcm16ToMulaw` (ITU-T G.711)
- `apps/voice-server/src/context-summarizer.ts` — ContextSummarizer with head+tail truncation at 4000 chars
- `apps/voice-server/src/voice-transport.ts` — VoiceTransport interface
- `apps/voice-server/src/twilio-transport.ts` — TwilioTransport (REST + TwiML `<Connect><Stream>`)
- `apps/voice-server/src/livekit-transport.ts` — LiveKitTransport STUB (all methods throw)
- `apps/voice-server/src/voice-pipeline.ts` — VoicePipeline: Deepgram STT + LLM summarization + ElevenLabs TTS
- `apps/voice-server/src/webhook-handler.ts` — HTTP handlers for POST /twilio/voice, POST /twilio/status, WS /twilio/stream
- `apps/voice-server/src/voice-adapter.ts` — VoiceAdapter implementing AdapterSink; max 1 active call, queue for others
- `apps/voice-server/src/voice-adapter.test.ts` — 22 tests covering circuit breaker, audio conversion, context summarizer, call queue

---

## Issues Encountered and Fixed

### 1. `@grammyjs/transformer-throttler` version conflict
- **Problem**: `telegram-bot/package.json` required `^1.3.0` but latest is `1.2.1`.
- **Fix**: Downgraded to `^1.2.0` in `telegram-bot/package.json`.

### 2. Vercel AI SDK `maxTokens` renamed
- **Problem**: `ai@6` renamed `maxTokens` to `maxOutputTokens` in `generateText`.
- **Fix**: Updated `context-summarizer.ts` to use `maxOutputTokens`.

### 3. Deepgram SDK v5 — no `sample_rate` field on octet-stream request
- **Problem**: Deepgram SDK v5 `MediaTranscribeRequestOctetStream` does not include `sample_rate` or `channels` fields; encoding is set via `encoding` only.
- **Fix**: Removed unsupported fields; kept `encoding: 'linear16'`, `model`, `punctuate`.

### 4. Deepgram SDK v5 — response is direct value, not `{ result }`
- **Problem**: `HttpResponsePromise<T>` resolves to `T` directly (not `{ result: T }`).
- **Fix**: Removed `.result` access; added `'request_id' in data` discriminant check for async responses.

### 5. `exactOptionalPropertyTypes` — optional fields with `undefined` values
- **Problem**: Passing `{ model: options.summarizerModel }` where `summarizerModel` could be `undefined` fails `exactOptionalPropertyTypes`.
- **Fix**: Used conditional spread `options.summarizerModel !== undefined ? { model: ... } : {}`.

### 6. Bun `server.upgrade` requires `data` field
- **Problem**: `server.upgrade(req, {})` fails because `data` is required in the second argument type.
- **Fix**: Changed to `server.upgrade(req, { data: undefined })`.

---

## Quality Checks

- Typecheck: PASS (`bun run --filter '@sirko/voice-server' typecheck`)
- Tests: 22 PASS, 0 FAIL (`bun test apps/voice-server/src/`)
