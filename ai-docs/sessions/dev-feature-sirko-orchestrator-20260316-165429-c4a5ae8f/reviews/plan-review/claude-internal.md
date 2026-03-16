# Plan Review — Sirko Implementation Plan

**Reviewer**: Claude (internal architecture review)
**Plan**: `dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f/architecture.md`
**Reference architecture**: `dev-arch-20260316-124106-081b4c45/architecture.md`
**Review date**: 2026-03-16

---

## Summary Verdict

**CONDITIONAL**

The plan is thorough, internally consistent, and faithful to the validated architecture in most respects. It is implementable as written. The findings below are a mix of genuine gaps that will cause build or runtime failures if not addressed (CRITICAL/HIGH) and clarifications that will save time during implementation (MEDIUM/LOW). None of the CRITICAL/HIGH findings require a re-design — they are all narrow, localised fixes.

---

## Findings

---

### F-01 — CRITICAL: `buildContext` signature mismatch

**Location**: `packages/pipeline/src/context.ts` (plan, Phase 5) vs. `apps/orchestrator/src/index.ts` startup pseudocode (plan, Phase 6).

**Finding**: The plan defines `buildContext(event: TmuxEvent, pane: PaneState | null): EventContext` in `context.ts`, but the Phase 6 orchestrator pseudocode calls it as:

```typescript
pipeline.run(buildContext(event, ...))
```

with an ellipsis placeholder. Meanwhile the architecture doc (Section 4.2) specifies `buildContext(event: TmuxEvent, store: StateStore): EventContext`, which is different again — it takes a `StateStore` reference, not a pre-loaded `PaneState`.

There are now three incompatible signatures floating across documents:
1. Architecture doc Section 4.2: `buildContext(event, store)`
2. Plan `context.ts` spec: `buildContext(event, pane)`
3. Plan `index.ts` usage: `buildContext(event, ...)`

The `state-manager` middleware is supposed to do the state loading (PRE phase), which strongly implies `buildContext` should **not** take a `StateStore`. The plan's `context.ts` version (`buildContext(event, pane)`) is most consistent with the middleware design, but this conflict must be resolved explicitly in the spec before implementation starts. If an implementer picks the architecture-doc version they will need to pass `store` into `context.ts`, creating a hidden coupling between the pure context builder and the state layer.

**Required fix**: Lock the signature to `buildContext(event: TmuxEvent, pane: PaneState | null): EventContext` (plan version) and update the architecture doc reference in a footnote. The orchestrator call site becomes `buildContext(event, store.getPane(event.paneId ?? null))` — this is a one-liner that belongs in the orchestrator, not inside `buildContext`.

---

### F-02 — CRITICAL: `detector` package not listed as pipeline dependency — xterm types missing

**Location**: `packages/pipeline/package.json` dependency block (plan, Phase 5).

**Finding**: The plan correctly lists `@sirko/detector` as a dependency of `packages/pipeline`. However, `DetectorEngine` is constructed and used inside `packages/pipeline/src/middleware/detection.ts`, and its factory signature is `createDetectionMiddleware(engine: DetectorEngine)`. The type `DetectorEngine` is defined in `packages/detector`. This means `packages/pipeline` must import from `@sirko/detector` to type-check.

Cross-checking the plan's `packages/pipeline/package.json` block confirms `@sirko/detector` is present — this part is correct.

The gap is that `TerminalEmulator` (defined in `packages/tmux-client/src/types.ts`) is used inside `packages/pipeline/src/middleware/xterm-interpret.ts` as an interface the middleware relies on (it calls `pane.xtermInstance` and casts it). `packages/pipeline` does NOT list `@sirko/tmux-client` as a dependency — it only accepts `TmuxClient` as a constructor argument. However, `createXtermInterpretMiddleware` takes a `TmuxClient` parameter from `@sirko/tmux-client`. Without `@sirko/tmux-client` in `packages/pipeline`'s dependencies, the TypeScript compiler will error on the `TmuxClient` type reference.

**Required fix**: Add `@sirko/tmux-client` to `packages/pipeline`'s `dependencies` block. Alternatively, extract the `TerminalEmulator` interface into `@sirko/shared` so `pipeline` does not need to import from `tmux-client`. The latter is architecturally cleaner — `TerminalEmulator` has no tmux-specific semantics.

---

### F-03 — CRITICAL: `startedAt` type inconsistency — `number` vs `bigint`

**Location**: `packages/shared/src/types.ts` Phase 1 spec vs. `packages/pipeline/src/context.ts` Phase 5 spec.

**Finding**: The `EventContext` interface appears in two places with conflicting types for `startedAt`:

- Architecture doc Section 4.2: `readonly startedAt: number` (described as `hrtime.bigint()` — contradictory comment)
- Plan `context.ts` Phase 5 spec: `readonly startedAt: bigint`

`Bun.nanoseconds()` returns a `number`; `process.hrtime.bigint()` returns a `bigint`. The `middlewareDurations: Record<string, number>` field stores durations in milliseconds (numbers), so the computation `Number(ctx.startedAt)` would be needed if `startedAt` is `bigint`. This is fine but must be consistent.

The logger middleware emits `"totalMs": number` — if `startedAt` is `bigint`, the arithmetic must be explicit: `Number(process.hrtime.bigint() - ctx.startedAt) / 1_000_000`.

**Required fix**: Declare the canonical type (`bigint`, using `process.hrtime.bigint()`) in exactly one place — `packages/pipeline/src/context.ts` — and remove the conflicting `number` hint from the architecture doc reference. The `buildContext` implementation comment must use `process.hrtime.bigint()` explicitly, not `Date.now()`.

---

### F-04 — HIGH: Phase 3 depends on Phase 2 but Phase 2 has no `@xterm/headless` in its dependency list

**Location**: `packages/tmux-client/package.json` dependency block (plan, Phase 3).

**Finding**: The plan marks `@xterm/headless` as an `optionalDependency` of `packages/tmux-client`:

```json
"optionalDependencies": {
  "@xterm/headless": "^5.0.0"
}
```

The architecture specifies that `@xterm/headless` is used for the `XtermEmulator` inside the `xterm-interpret` middleware, which lives in `packages/pipeline` — NOT inside `packages/tmux-client`. The only thing `tmux-client` exports related to terminals is the `TerminalEmulator` interface and `createTerminalEmulator()`. Placing the `@xterm/headless` optional dep on `tmux-client` is therefore correct for the factory, but the plan also lists it as an optional dep on `packages/pipeline`.

The issue: if `@xterm/headless` is optional on both packages, and Bun resolves it as installed, but the Week 1 Bun compatibility spike reveals it is incompatible, both packages must fall back to `BufferEmulator`. The plan has no mechanism for the `pipeline` package to know whether `tmux-client`'s `createTerminalEmulator()` returned an `XtermEmulator` or a `BufferEmulator`. This is fine if the `TerminalEmulator` interface is opaque (it is), but the `xterm-interpret` middleware factory option `emulatorType?: 'xterm' | 'buffer'` suggests the middleware also needs to know.

More concretely: the Phase 3 quality gate (`turbo run typecheck --filter=@sirko/tmux-client`) will fail during the spike if `@xterm/headless` types are not available, even as an optional dep, because TypeScript will not be able to type-check the import. The plan needs to specify how to handle the optional import in TypeScript — either a try/catch dynamic `import()` or a `// @ts-ignore` with a comment, or guarding behind a feature flag.

**Required fix**: Add an explicit note to Phase 3 that the `XtermEmulator` wrapper must use a dynamic `import('@xterm/headless').catch(() => null)` pattern and fall back to `BufferEmulator` if the import rejects. This makes the optional dependency truly optional at runtime without TypeScript errors.

---

### F-05 — HIGH: `packages/detector` missing `quiescence.ts` exports used by `pipeline`

**Location**: `packages/detector/src/quiescence.ts` spec (plan, Phase 5).

**Finding**: The `detection.ts` middleware calls `engine.computeScore(pane, xtermBuffer, skill)`, which internally uses `QuiescenceTracker`. This is fine — it is encapsulated. However, the `QuiescenceScheduler` in `apps/orchestrator/src/scheduler.ts` also needs to call `buildQuiescenceContext(pane)`, which is defined in `packages/pipeline/src/context.ts`.

The `QuiescenceScheduler` imports from `@sirko/pipeline` (for `buildQuiescenceContext`) and from `@sirko/tool-plugins` (for `getSkill`). The plan's `apps/orchestrator/package.json` lists both as dependencies, so the imports work.

The actual gap: `QuiescenceTracker` is described in the architecture doc as being "called by the scheduler in the orchestrator" (Section 1.4: "QuiescenceTracker class — manages per-pane quiescence timers, called by the scheduler"). But the plan's `QuiescenceScheduler` does NOT import or call `QuiescenceTracker` directly — it does the elapsed-time check inline and then calls `pipeline.run(buildQuiescenceContext(pane))`. This is a design divergence from the architecture doc.

Both approaches work, but the architecture doc description of `QuiescenceTracker` as a standalone class implies it was intended to be called by the scheduler, with the `computeScore` result used to decide whether to fire. The plan instead has the scheduler make the decision (elapsed >= threshold) and then injects a synthetic event into the pipeline where `DetectorEngine` runs the full three-signal evaluation.

The plan's approach is actually more correct — the scheduler should not bypass the pipeline. However, the `QuiescenceTracker.computeScore()` method is described in the plan as taking `(pane, skill)` and returning a quiescence score independently. If the scheduler fires AND the pipeline runs AND `DetectorEngine.computeScore()` runs `QuiescenceTracker.computeScore()` internally, the quiescence signal is computed twice for every scheduler tick. This is harmless but wasteful.

**Required fix**: Clarify in `packages/detector/src/quiescence.ts` that `QuiescenceTracker` is only called by `DetectorEngine.computeScore()` — not by the scheduler directly. The scheduler's responsibility is solely to inject the synthetic event. The `QuiescenceTracker` class should not be exported from `packages/detector/src/index.ts` as a public API unless it is intended to be used externally.

---

### F-06 — HIGH: Missing `tmux-client` dependency in `apps/voice-server`

**Location**: `apps/voice-server/package.json` (plan, Phase 8).

**Finding**: `VoiceAdapter` constructor signature is:

```typescript
constructor(
  options: VoiceAdapterOptions,
  store: StateStore,
  bus: EventBus,
  tmuxClient: TmuxClient
)
```

`TmuxClient` is typed in `@sirko/tmux-client`. But the plan's `apps/voice-server/package.json` dependencies block does NOT include `@sirko/tmux-client`:

```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@sirko/event-bus": "workspace:*",
    "@sirko/state-store": "workspace:*",
    "@sirko/voice-pipeline": "workspace:*",
    "twilio": "^5.3.0",
    "livekit-server-sdk": "^2.6.0",
    "fastify": "^5.1.0"
  }
}
```

`@sirko/tmux-client` is missing. The `VoiceAdapter.runVoicePipeline()` calls `tmuxClient.sendKeys(paneId, sanitized)`, which requires the `TmuxClient` type. Without the dependency declaration, TypeScript compilation will fail for `apps/voice-server` with a "cannot find module '@sirko/tmux-client'" error.

**Required fix**: Add `"@sirko/tmux-client": "workspace:*"` to `apps/voice-server/package.json` dependencies.

---

### F-07 — HIGH: `SkillDefinition` field name divergence between architecture doc and plan

**Location**: `packages/tool-plugins/src/types.ts` (plan Phase 4) vs. architecture doc Section 4.4.

**Finding**: The architecture doc (Section 4.4) uses `preInputDelay?: number` and `outputStreamingDelay?: number`. The plan (Phase 4) uses `preInputDelayMs?: number` and `outputStreamingDelayMs?: number`. These are different field names — a breaking inconsistency if other code references one name expecting the other.

Additionally, the `claudeCodeSkill` concrete definition in the plan does not include `preInputDelayMs` or `outputStreamingDelayMs` (they are omitted, implying `undefined`), while the aider and codex skills also omit them. This is fine since they are optional. But the architecture doc's example mentions these fields, and if any consumer uses `skill.preInputDelay` (the arch doc name), it will be `undefined` at runtime when the actual field is `skill.preInputDelayMs`.

The architecture doc also has `inputSuffix?: string` and the plan has the same — this one is consistent.

**Required fix**: Standardise on the `Ms` suffix variants (`preInputDelayMs`, `outputStreamingDelayMs`) throughout all documents. Update any architecture doc references to use the `Ms` suffix. This is the plan's version and it is more explicit.

---

### F-08 — HIGH: `TELEGRAM_STREAMING_MODE` env var not in `OrchestratorConfig`

**Location**: `apps/orchestrator/src/config.ts` (plan, Phase 6) and configuration table (plan, Section 5.1).

**Finding**: The plan's `OrchestratorConfig` interface (Phase 6) defines:

```typescript
export interface OrchestratorConfig {
  dataDir: string
  logDir: string
  tmuxSocketPath: string | undefined
  quiescenceCheckIntervalMs: number
  outputCoalesceWindowMs: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}
```

The configuration table in Section 5.1 lists `TELEGRAM_STREAMING_MODE` (`draft` | `edit`) and `SIRKO_VOICE_HTTP_PORT` as environment variables, but neither appears in `OrchestratorConfig`. Since these variables are consumed by the Telegram adapter and voice server respectively, they could live in their own adapter-specific config structs rather than the `OrchestratorConfig`. However, the plan does not define such structs for the adapter configs — `TelegramAdapterOptions` and `VoiceAdapterOptions` do not have `streamingMode` or `httpPort` fields either.

`SIRKO_VOICE_HTTP_PORT` is referenced in the quality gate curl command (`http://localhost:3000`) but never mapped to a config field. Hardcoding port 3000 inside `VoiceAdapter.start()` without reading from env is a reliability issue in any environment that already has port 3000 occupied.

**Required fix**: Add `streamingMode: 'draft' | 'edit'` to `TelegramAdapterOptions` and `httpPort: number` to `VoiceAdapterOptions`. `loadConfig()` should parse both env vars. The Phase 6 config spec should be updated.

---

### F-09 — MEDIUM: Phase 3 dependency declaration is misleading

**Location**: Phase 3 header: "Depends on: Phase 1 (shared types), Phase 2 (state-store for integration test setup)".

**Finding**: The plan states Phase 3 (tmux-client) depends on Phase 2 (state-store) "for integration test setup". Examining the actual Phase 3 test list, the coalescer and parser tests are pure unit tests with no state-store interaction. The client integration test (`fake-agent.sh`) requires a running tmux process, not the state store.

The dependency is real but its description is misleading. `tmux-client` itself has no dependency on `state-store` in `package.json`. The only reason Phase 2 is listed is presumably so the test harness can use `StateStore` to record events during integration testing. But the plan's Phase 3 test list does not actually show any `StateStore` usage.

This means Phase 2 and Phase 3 are actually independent and both depend only on Phase 1. A developer could implement them in parallel. The dependency diagram in Section 3 correctly shows this: both Phase 2 (State Store) and Phase 3 (tmux-client) branch independently from Phase 1. The Phase 3 header text is wrong.

**Required fix**: Change Phase 3 header to "Depends on: Phase 1 only". If future integration tests genuinely need `StateStore`, note this as an optional enhancement.

---

### F-10 — MEDIUM: Missing test file for `tmux-client` integration (`client.test.ts`)

**Location**: Phase 3 "Files to create" list.

**Finding**: The plan lists test files for the parser (`parser.test.ts`) and coalescer (`coalescer.test.ts`) but no `client.test.ts`. The architecture's testing strategy (Section 11.1) calls for a reconnection test: "mock a disconnected socket, assert exponential backoff timing." This test has no file to live in. The `client.ts` module (which handles connection, events generator, sendKeys, session/pane management) is the most complex module in the package and has no unit test file designated.

**Required fix**: Add `packages/tmux-client/src/client.test.ts` to the Phase 3 file list. Minimum test targets: mock process spawn for `sendKeys`, verify correct command-line format; mock disconnect and verify reconnect delay doubles; `listPanes()` parses `tmux list-panes` output correctly.

---

### F-11 — MEDIUM: `pipeline` package missing `buildContext` dependency on `StateStore`

**Location**: `packages/pipeline/src/context.ts` — `buildContext(event, pane)` vs orchestrator usage.

**Finding**: With the plan's `buildContext(event: TmuxEvent, pane: PaneState | null)` signature, the `state-manager` middleware PRE phase must populate `ctx.pane` — but it runs inside the pipeline, and `ctx.pane` is the thing it writes, not reads. The chicken-and-egg situation: `buildContext` creates the initial context with `pane = store.getPane(event.paneId)` (pre-loaded) OR with `pane = null` (empty, to be filled by `state-manager`).

The plan's middleware spec says state-manager (PRE) "load PaneState from StateStore → ctx.pane". For this to work, `buildContext` must construct the context with `pane = null`, and the state-manager does the lookup. This is correct — but it means the orchestrator event loop constructs context with `buildContext(event, null)` and the state-manager (which has a reference to `store`) populates `ctx.pane`.

The plan's `buildContext` signature `(event, pane)` and the comment "Creates a fresh EventContext with defaults" are consistent with the `null` initial value pattern. This is fine. The finding is that the orchestrator pseudo-code should explicitly show `buildContext(event, null)` rather than `buildContext(event, ...)`, to prevent an implementer from pre-loading pane state before passing to buildContext (which would bypass the state-manager middleware entirely for that field).

**Required fix**: Update the Phase 6 orchestrator pseudo-code to show `pipeline.run(buildContext(event, null))` explicitly.

---

### F-12 — MEDIUM: `sentence-buffer.ts` missing from `voice-pipeline` test files

**Location**: Phase 8 test file list for `packages/voice-pipeline`.

**Finding**: The plan's Phase 8 file list includes `packages/voice-pipeline/test/audio-convert.test.ts` but not a test for `SentenceBoundaryBuffer`. Given the streaming TTS strategy depends on correct sentence boundary detection (Section 7.4 architecture doc), this class is important enough to warrant explicit test coverage. Edge cases include: multi-sentence LLM output, tokens that straddle sentence boundaries, flush-on-end-of-stream behavior, and the `minChunkChars` threshold.

**Required fix**: Add `packages/voice-pipeline/test/sentence-buffer.test.ts` to the Phase 8 file list with at minimum these targets: single-token sentence flushes when boundary detected, multi-token accumulation below `minChunkChars` does not flush early, `flush()` returns remaining buffer regardless of boundary, empty `push` returns null.

---

### F-13 — MEDIUM: `apps/orchestrator` imports `@sirko/telegram-bot` and `@sirko/voice-server` but they are not in dependencies

**Location**: Phase 6 `apps/orchestrator/package.json` (plan).

**Finding**: The plan's Phase 6 orchestrator `package.json` lists:

```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@sirko/tmux-client": "workspace:*",
    "@sirko/pipeline": "workspace:*",
    "@sirko/event-bus": "workspace:*",
    "@sirko/detector": "workspace:*",
    "@sirko/tool-plugins": "workspace:*",
    "@sirko/state-store": "workspace:*"
  }
}
```

But Phase 7 and 8 integration instructions direct the orchestrator `index.ts` to import `createTelegramAdapter` from `@sirko/telegram-bot` and `createVoiceAdapter` from `@sirko/voice-server`. Neither `@sirko/telegram-bot` nor `@sirko/voice-server` is in the orchestrator's dependencies.

The plan says this integration code is "added in Phase 7 and Phase 8" — but does not instruct the developer to update `apps/orchestrator/package.json` when doing so. This will result in a TypeScript module resolution error when Phase 7 code is merged.

**Required fix**: Add an explicit instruction in Phase 7 and Phase 8: "Update `apps/orchestrator/package.json` to add `@sirko/<adapter>: workspace:*` to dependencies." Alternatively, add both as optional/commented dependencies in Phase 6 with a note.

---

### F-14 — MEDIUM: `AdapterSink` interface defined in architecture but absent from plan

**Location**: Architecture doc Section 4.7 vs. plan (all phases).

**Finding**: The architecture defines an `AdapterSink` interface:

```typescript
interface AdapterSink {
  readonly name: string
  handlePaneOutput(event): Promise<void>
  handlePaneAwaitingInput(event): Promise<void>
  handlePaneExited(event): Promise<void>
  handleInputDelivered(event): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  isHealthy(): boolean
}
```

The plan's `TelegramAdapter` and `VoiceAdapter` classes have `start()` and `stop()` methods, but neither class is declared as implementing `AdapterSink`. The interface is defined in the architecture doc but has no home in the plan — it is not assigned to `packages/shared` or to `packages/event-bus` or to any specific file.

Without this interface, adapter polymorphism is lost: the orchestrator cannot maintain a list of `AdapterSink[]` and call `start()`/`stop()` uniformly. The graceful shutdown handler in the orchestrator pseudo-code calls `telegramAdapter.stop()` and (implicitly) `voiceAdapter.stop()` as separate calls, which works but is not extensible.

**Required fix**: Add `AdapterSink` interface to `packages/shared/src/types.ts` (it belongs there since it depends only on `SirkoEvent`). Have `TelegramAdapter` and `VoiceAdapter` implement it explicitly (`implements AdapterSink`). The orchestrator can then maintain an `AdapterSink[]` array.

---

### F-15 — LOW: `turbo.json` missing `typecheck` dependency on `^typecheck`

**Location**: Plan Section 1.3 `turbo.json`.

**Finding**: The plan's `turbo.json` shows:

```json
"typecheck": {
  "dependsOn": ["^build"],
  "outputs": []
}
```

This means typechecking a package waits for all its dependency packages to `build` (compile to `dist/`). For Bun workspace development where packages point directly to `./src/index.ts` (not `./dist/`), the `build` step may not be necessary before typecheck. However, if any package uses `declaration: true` (which the `tsconfig.base.json` does), TypeScript project references need the upstream `.d.ts` files — which are only emitted by the build step.

Since the plan recommends pointing `"main"` and `"exports"` to `./src/index.ts` for development (Section 1.6), typecheck will resolve symbols through source, not `dist/`. The `"dependsOn": ["^build"]` means the very first `turbo run typecheck` on a fresh repo will attempt to build all packages first. This adds ~30 seconds to the first run in CI.

A better pattern for pure TypeScript source-based workspaces is `"dependsOn": ["^typecheck"]` — ensuring upstream packages are typechecked before downstream ones, without triggering a full build.

**Required fix (LOW, optional)**: Change `typecheck.dependsOn` from `["^build"]` to `["^typecheck"]` in `turbo.json`. Keep `build.dependsOn` as `["^build"]` for production builds. This speeds up `turbo run typecheck` significantly on a fresh clone.

---

### F-16 — LOW: `fake-agent.sh` prompt pattern differs between plan and architecture doc

**Location**: Phase 3 fixture (`packages/tmux-client/fixtures/fake-agent.sh`) vs. architecture doc Section 11.3.

**Finding**: The plan's Phase 3 `fake-agent.sh` uses:
```bash
printf "> "   # prompt — no newline, cursor stays at end
```

The architecture doc Section 11.3 uses:
```bash
echo "> "   # prompt pattern
```

The difference matters: `printf "> "` leaves the cursor on the same line (no trailing newline), which is how real CLI tools render their prompts. `echo "> "` adds a newline, which means `claudeCodeSkill.promptPatterns: [/^> $/m]` would match correctly in either case — but the cursor state would differ, and the `xterm-interpret` middleware test in the E2E scenario would behave differently.

More importantly, the prompt pattern `/^> $/m` requires the line to end with `> ` followed by end-of-line. With `printf "> "` (no newline), the last line of the xterm buffer may contain `> ` without a newline, and `$` in multiline mode matches before `\n`. This should work, but the E2E test instructions should use `printf` consistently with the Phase 3 fixture, not `echo`.

**Required fix (LOW)**: Update the architecture doc Section 11.3 `fake-agent.sh` listing to use `printf "> "` to match the Phase 3 fixture. This is a documentation consistency fix.

---

### F-17 — LOW: Weight discrepancy between architecture doc and plan for `claude-code`

**Location**: Architecture doc Section 6.3 vs. plan Phase 4 `claudeCodeSkill`.

**Finding**: Architecture doc Section 6.3 lists Claude Code weights as:
```
promptPatternWeight:  0.45
wchanWeight:          0.35
quiescenceWeight:     0.20
```

And the worked example in Section 6.1 uses:
```
(1.0 * 0.40) + (1.0 * 0.35) + (1.0 * 0.25) = 1.00
```

That example uses `0.40 / 0.35 / 0.25`, which differs from both the per-tool weights (`0.45 / 0.35 / 0.20`) and the default weights (`0.50 / 0.30 / 0.20`). The worked example appears to be illustrative and uses neither set of actual weights.

The plan's `claudeCodeSkill` (Phase 4) uses `promptPatternWeight: 0.45, wchanWeight: 0.35, quiescenceWeight: 0.20` — which is consistent with Section 6.3 but inconsistent with the Section 6.1 example.

These weights sum to 1.00, which is correct. The Section 6.1 example is simply inaccurate (using illustrative numbers). This is a documentation issue in the architecture doc, not in the plan.

**Required fix (LOW)**: No change to the plan. Architecture doc Section 6.1 worked example should be corrected to use actual `claude-code` weights (`0.45 / 0.35 / 0.20`) for consistency.

---

## Summary Table

| ID | Severity | Category | Description |
|----|----------|----------|-------------|
| F-01 | CRITICAL | Type correctness | `buildContext` signature conflict across documents |
| F-02 | CRITICAL | Missing dependency | `@sirko/tmux-client` not in `packages/pipeline` deps |
| F-03 | CRITICAL | Type correctness | `startedAt` typed as both `number` and `bigint` |
| F-04 | HIGH | Build feasibility | `@xterm/headless` optional import not handled for TypeScript |
| F-05 | HIGH | Integration gap | `QuiescenceTracker` export scope vs. scheduler design |
| F-06 | HIGH | Missing dependency | `@sirko/tmux-client` not in `apps/voice-server` deps |
| F-07 | HIGH | Type correctness | `SkillDefinition` field name (`preInputDelay` vs `preInputDelayMs`) |
| F-08 | HIGH | Completeness | `TELEGRAM_STREAMING_MODE` / `SIRKO_VOICE_HTTP_PORT` not in config structs |
| F-09 | MEDIUM | Dependency ordering | Phase 3 dependency on Phase 2 is misleading |
| F-10 | MEDIUM | Test coverage | No `client.test.ts` for `TmuxClient` |
| F-11 | MEDIUM | Completeness | Orchestrator pseudo-code should show explicit `buildContext(event, null)` |
| F-12 | MEDIUM | Test coverage | `SentenceBoundaryBuffer` has no test file |
| F-13 | MEDIUM | Integration gap | Orchestrator `package.json` not updated when adapters added |
| F-14 | MEDIUM | Alignment | `AdapterSink` interface from arch doc absent from plan |
| F-15 | LOW | Build feasibility | `turbo.json` typecheck depends on `^build` (slow first run) |
| F-16 | LOW | Completeness | `fake-agent.sh` uses `echo` vs `printf` inconsistency |
| F-17 | LOW | Alignment | Section 6.1 worked example uses wrong weights |

---

## Alignment Assessment

The plan implements what the architecture specifies. The hybrid Pipeline+EventBus design (Section 1.3 of architecture), the exact middleware order (8 stages), the three-signal detection formula, the per-pane serialization queue, the per-pane coalescing window, and the `VoiceTransport` abstraction are all faithfully represented. The phasing (Foundation → Core Intelligence → Telegram → Voice → LiveKit → Polish) maps correctly to the architecture's implementation plan.

The main areas where the plan diverges from the architecture are minor: `QuiescenceTracker` scope (F-05), `AdapterSink` interface placement (F-14), and two signature inconsistencies (F-01, F-07) introduced by the plan trying to be more specific than the architecture doc while not matching it exactly.

---

## Verdict

**CONDITIONAL**

The plan may proceed to implementation with the following mandatory pre-conditions:

1. **MUST resolve before Phase 1**: Confirm `buildContext` signature (F-01) — choose `(event, pane: null)` and document it in one place.
2. **MUST resolve before Phase 3**: Confirm `@xterm/headless` optional import strategy (F-04) and add `client.test.ts` to file list (F-10).
3. **MUST resolve before Phase 4**: Standardise `SkillDefinition` field names (`Ms` suffix, F-07).
4. **MUST resolve before Phase 5**: Fix `@sirko/tmux-client` missing from `packages/pipeline` deps (F-02) and lock `startedAt` to `bigint` (F-03).
5. **MUST resolve before Phase 6**: Add `TELEGRAM_STREAMING_MODE` / `SIRKO_VOICE_HTTP_PORT` to appropriate config structs (F-08).
6. **MUST resolve before Phase 8**: Add `@sirko/tmux-client` to `apps/voice-server` deps (F-06) and add `sentence-buffer.test.ts` (F-12).
7. **MUST resolve before Phase 7/8 integration**: Orchestrator `package.json` update instruction for adapter deps (F-13).

The MEDIUM/LOW findings (F-09, F-11, F-14, F-15, F-16, F-17) are recommended but non-blocking.
