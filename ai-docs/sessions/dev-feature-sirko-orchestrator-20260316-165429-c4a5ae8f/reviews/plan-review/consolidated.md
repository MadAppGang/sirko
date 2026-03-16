# Plan Review Consolidated

## Verdict: CONDITIONAL → APPROVED (after fixes)

## Models Reviewed: 5 (Claude, MiniMax, Kimi, GPT-5.4, Qwen)
## Unanimous: CONDITIONAL

## Critical Fixes Applied:

1. **Middleware ordering corrected** — `state-manager` now listed before `xterm-interpret` in `assemblePipeline` order comment. Added note explaining why: `xterm-interpret` reads `ctx.pane.xtermInstance`, which `state-manager` loads from the store in its PRE phase. Added matching note to `xterm-interpret` middleware spec.

2. **`@sirko/tmux-client` added to `packages/pipeline/package.json` dependencies** — required for `TmuxClient` type reference in `createXtermInterpretMiddleware`. Also added to `apps/voice-server/package.json` dependencies for `TmuxClient` type in `VoiceAdapter` constructor.

3. **`buildContext` signature locked** — canonical signature is `buildContext(event: TmuxEvent, pane: PaneState | null): EventContext`. Orchestrator call site updated from `buildContext(event, ...)` to explicit `buildContext(event, null)` with note that `state-manager` loads the pane in its PRE phase.

4. **App export contracts added** — Phase 7 (`apps/telegram-bot`) and Phase 8 (`apps/voice-server`) now have explicit `Library exports` sections showing what each module exports as a library for the orchestrator to import.

5. **`xtermInstance` type fixed** — `PaneState.xtermInstance` changed from `unknown | null` to `TerminalEmulator | null`. `TerminalEmulator` interface moved to `packages/shared/src/types.ts` (avoids circular dependency: shared cannot import from tmux-client). `packages/tmux-client/src/types.ts` re-exports `TerminalEmulator` from `@sirko/shared`.

6. **`startedAt` type locked to `number`** — `EventContext.startedAt` changed from `bigint` to `number` with comment `// Date.now() milliseconds at context creation`. All `process.hrtime.bigint()` references removed.

7. **`preInputDelayMs` naming** — Already consistent throughout plan (`preInputDelayMs`, `outputStreamingDelayMs`). No change required.

8. **`AdapterSink` interface added to `packages/shared/src/types.ts`** — Full interface with `handlePaneOutput`, `handlePaneAwaitingInput`, `handlePaneExited`, `handleInputDelivered`, `start`, `stop`, `isHealthy`. Both `TelegramAdapter` and `VoiceAdapter` class declarations updated to `implements AdapterSink`.

9. **Phase 7/8 orchestrator `package.json` integration notes added** — Each adapter's `Library exports` section and the orchestrator `package.json` block now carry explicit notes: when Phase 7 is integrated, add `@sirko/telegram-bot: workspace:*`; when Phase 8 is integrated, add `@sirko/voice-server: workspace:*`.

10. **Missing env var mappings added** — `TELEGRAM_STREAMING_MODE` mapped to `TelegramAdapterOptions.streamingMode?: 'draft' | 'edit'`. `SIRKO_VOICE_HTTP_PORT` mapped to `VoiceAdapterOptions.httpPort?: number`. Section 5.1 header updated to clarify these are adapter-specific and not in `OrchestratorConfig`.

## Remaining non-critical items (address during implementation):

- **F-04** (MEDIUM): `@xterm/headless` optional import strategy — implement `XtermEmulator` wrapper using dynamic `import('@xterm/headless').catch(() => null)` pattern to fall back to `BufferEmulator` if import fails; document in Phase 3.
- **F-05** (MEDIUM): `QuiescenceTracker` should not be exported as public API from `packages/detector/src/index.ts` unless intentionally external; confirm scope during Phase 5.
- **F-09** (MEDIUM): Phase 3 dependency header says "depends on Phase 2 (state-store for integration test setup)" — this is misleading; Phase 3 depends only on Phase 1 in practice.
- **F-10** (MEDIUM): No `client.test.ts` designated for `TmuxClient` — add during Phase 3 implementation with reconnect backoff and `sendKeys` command-format tests.
- **F-11** (MEDIUM): Already fixed by Fix 3 above (explicit `buildContext(event, null)`).
- **F-12** (MEDIUM): Add `packages/voice-pipeline/test/sentence-buffer.test.ts` during Phase 8 implementation.
- **F-15** (LOW): `turbo.json` typecheck uses `dependsOn: ["^build"]` — consider changing to `["^typecheck"]` for faster CI first-run; optional optimization.
- **F-16** (LOW): Architecture doc Section 11.3 `fake-agent.sh` uses `echo` vs plan's `printf` — documentation consistency; fix in architecture doc separately.
- **F-17** (LOW): Architecture doc Section 6.1 worked example uses illustrative weights that differ from actual `claude-code` weights — documentation fix in architecture doc separately.
