# Architecture Review — Internal (Claude)

**Reviewed by**: Claude (claude-sonnet-4-6)
**Date**: 2026-03-16
**Document reviewed**: `architecture.md` (Session dev-arch-20260316-124106-081b4c45)
**Requirements reviewed**: `requirements.md` (same session)

---

## Summary

The architecture is thorough, well-structured, and demonstrates strong alignment with the requirements document. The hybrid Pipeline/Middleware + EventBus approach is well-motivated and the seam between them (the `notification-fanout` middleware) is clearly defined. Type contracts are specified at a level of detail that should prevent integration friction during implementation. The implementation plan is realistic and the risk notes within each phase are honest and actionable.

The primary concerns fall into three categories: (1) one unacknowledged hard dependency on an API feature (`sendMessageDraft`) that may not exist yet; (2) several Bun compatibility risks that are noted in the document but whose mitigations are incomplete or deferred too late; and (3) a subtle but real concurrency edge case in the quiescence scheduler that the `processingCount` mechanism does not fully solve. These are manageable, but the `sendMessageDraft` issue in particular could invalidate the Telegram streaming design and warrants a decision before implementation begins.

---

## Findings

### [CRITICAL] `sendMessageDraft` API availability is unverified

**Description**: The entire Telegram output-streaming strategy (Section 8.3) depends on `sendMessageDraft`, described as a "Telegram Bot API 9.3+" feature. As of the knowledge cutoff date this endpoint does not exist in the public Bot API specification. The requirement (FR-TG-03) acknowledges this with the parenthetical "(or equivalent streaming/edit-based approach)," but the architecture commits to it fully without providing the fallback design inline. If this API is unavailable, the described streaming behaviour — updating a single draft message with accumulating pane output — cannot be implemented as specified, and the fallback (edit-last-message) has meaningfully different rate-limit properties.

**Recommendation**: Before writing any Telegram adapter code, verify that `sendMessageDraft` is available in the Bot API version accessible to the project. If it is not, design the fallback explicitly now: a `sendMessage` + `editMessageText` loop with a 100ms debounce is the standard alternative. It consumes the per-chat rate limit (20 msg/min) for new messages but uses only the global limit (30 req/s) for edits, which changes the analysis in Section 8.5. The `RateLimitQueue` design is sound regardless; it just needs to bucket `editMessageText` calls separately from `sendMessage` calls.

---

### [CRITICAL] `@xterm/headless` Bun compatibility is a Phase 1 risk with no confirmed fallback

**Description**: Section 1 notes the Bun compatibility risk for `@xterm/headless` and mentions a fallback (`strip-ansi` + custom VT state machine), but the fallback is unnamed and undesigned. This matters because `@xterm/headless` is load-bearing: it is used by the `xterm-interpret` middleware, which feeds `ctx.xtermBuffer` to the detection stage. If the fallback is `strip-ansi` only (which strips escape sequences but does not maintain a screen buffer), then `PromptMatcher` can only match against the raw text of incoming events, not against the current screen state. This is a meaningful capability regression — multi-line prompts, redrawn lines, and cursor-positioned prompts would all be invisible to the prompt pattern signal.

**Recommendation**: Design the fallback `TerminalEmulator` abstraction now, as part of Phase 1. At minimum, decide: does the fallback maintain a rolling line buffer (last N lines, cursor-positioned rewrites tracked manually), or does it match only against the current event's text? The answer changes how prompt patterns need to be written. The `SkillDefinition.promptPatterns` regexes should be documented as targeting either the full buffer or the event text, and the `xterm-interpret` middleware should expose which mode is active via `ctx`.

---

### [HIGH] Quiescence scheduler race: `processingCount` does not protect against concurrent QuiescenceCheck injections

**Description**: Section 6.4 explains that `processingCount` prevents the quiescence scheduler from firing while the pipeline is actively processing events for a pane. However, the scheduler fires every 500ms and iterates all panes. If a pane crosses the quiescence threshold while the scheduler is iterating (and `processingCount` is 0 because no `pane-output` event is currently in flight), the scheduler will call `pipeline.run(buildQuiescenceContext(pane))`. Because Bun's event loop is single-threaded, the pipeline call is not concurrent — but `pipeline.run()` is `async`, meaning it yields on awaits. The scheduler's `setInterval` can fire again before the first `QuiescenceCheck` pipeline run completes, injecting a second `QuiescenceCheck` for the same pane before `dedup` has updated `pane.notificationState`.

The `dedup` middleware prevents a second `PaneAwaitingInput` from being emitted in the same awaiting cycle, but only after `state-manager (PRE)` loads the state. If two `QuiescenceCheck` pipeline runs are in flight simultaneously (interleaved via `await` yields), both could load `notificationState = 'idle'` before either writes `'notified'`, defeating dedup.

**Recommendation**: Add a per-pane `quiescenceCheckInFlight: boolean` flag to `PaneState` (or a local `Set<paneId>` in the scheduler closure). The scheduler sets it to `true` before calling `pipeline.run()` and clears it in a `finally` block. The scheduler skips the pane if this flag is set. This is a single synchronous write before the first `await`, so it is safe without locks. Alternatively, increment `processingCount` at the top of the scheduler loop entry for that pane (before the `await`) and decrement in `finally` — this reuses the existing mechanism.

---

### [HIGH] LiveKit Agents SDK Bun compatibility is unvalidated and the dependency is production-critical

**Description**: `livekit-agents` (the TypeScript/Node.js SDK for LiveKit agents) has dependencies on Node.js native modules (notably `worker_threads`, specific Node.js buffer behaviour, and potentially native bindings). The requirements document (ASM-05) says "LiveKit SDK compatibility with Bun is assumed or workarounds are acceptable," but the architecture does not describe what those workarounds are. The LiveKit path is the production voice transport — it is not a nice-to-have. If the SDK does not run under Bun, the production voice system cannot be implemented as designed without either switching to Node.js for the voice-server app or wrapping the SDK in a Node.js subprocess.

**Recommendation**: Validate `livekit-agents` under Bun before Phase 5 begins (ideally during Phase 1 or 2 as a parallel spike). If compatibility issues are found, document the decision: (a) run `apps/voice-server` under Node.js (Bun and Node.js can coexist in a monorepo); (b) proxy via a thin Node.js shim; or (c) bypass `livekit-agents` and implement the LiveKit WebRTC integration directly using the lower-level `livekit-client` or `livekit-server-sdk`. Option (a) is the pragmatic path and does not compromise the architecture.

---

### [HIGH] PID resolution timing gap creates a wchan signal blind spot on pane creation

**Description**: Section 6.2 states that the PID for a pane is resolved once via `display-message -t %3 -p '#{pane_pid}'` and stored in `PaneState.pid`. However, for panes that existed before the orchestrator connected (reconnect scenario), and for panes where the CLI agent process has not yet started (the shell is running but the agent hasn't been launched), the stored PID will be the shell's PID, not the agent's PID. The `detectTool()` function (from `tool-plugins`) identifies the tool from the process tree, but `PaneState.pid` may point at the wrong process for the wchan signal.

More critically: if the user starts a CLI agent *after* the orchestrator has already registered the pane, the PID in `PaneState.pid` will remain the shell's PID indefinitely unless there is a mechanism to refresh it. The shell's wchan while waiting for a child process is different from the agent's wchan while waiting for input, which would systematically underweight the wchan signal for any agent started after pane registration.

**Recommendation**: Add periodic PID refresh (e.g., every 10 seconds, or on each `QuiescenceCheck`) by re-running `display-message` and checking if the foreground process has changed. Alternatively, parse the foreground process PID from the tmux pane's process tree (`pane_pid` gives the shell; the CLI agent is typically a child). The `detector` package already knows about process trees (it uses `ProcessInfo` arrays in `detectTool()`); extend `WchanInspector` to walk the child process tree and locate the deepest non-shell process as the target for wchan inspection.

---

### [MEDIUM] `dedup` reset logic on `notificationState` is driven by detection score, but detection requires pane output

**Description**: Section 5 (Middleware 4: dedup) states: "If `ctx.pane.notificationState == 'notified'` AND `ctx.detectionResult.awaiting == false`: resets `ctx.pane.notificationState = 'idle'`." This means dedup only resets when a new `pane-output` event arrives AND the detection score drops below the threshold. But when the user sends a reply via `tmuxClient.sendKeys`, the reset is also performed immediately via `stateStore.setNotificationState(paneId, 'idle')` in the Telegram handler (Section 3.2) and via `bus.emit({ type: 'InputDelivered', ... })`.

The problem: these are two independent reset paths. If the Telegram handler resets `notificationState` to `'idle'` but the next pipeline event (which may arrive microseconds later) still scores `awaiting = true` (because the agent hasn't started outputting yet), `dedup` will immediately re-emit `PaneAwaitingInput`. This creates a notification loop: user replies → reset → quiescence not expired → still awaiting → re-notify.

**Recommendation**: Introduce a brief "cooldown" period after `InputDelivered`. The simplest approach: add a `lastInputDeliveredAt: number` field to `PaneState`. The `dedup` middleware suppresses notifications for a configurable window (e.g., 5000ms) after `lastInputDeliveredAt`, regardless of detection score. This window covers the time it takes for the CLI agent to receive the input, start processing, and produce output that resets the quiescence timer.

---

### [MEDIUM] Telegram adapter is a separate app process but needs `tmuxClient.sendKeys` — the dependency is indirect and fragile

**Description**: Section 3.2 shows the Telegram adapter calling `tmuxClient.sendKeys(paneId, text)` directly when routing user input. However, in the monorepo layout (Section 2.1), `apps/telegram-bot` is a separate app from `apps/orchestrator`, which owns the `TmuxClient` instance. The architecture does not specify how `telegram-bot` accesses `tmuxClient`. If all apps run as separate OS processes (which is the standard Turborepo multi-app pattern), `telegram-bot` cannot call `tmuxClient.sendKeys` directly — it would need an IPC mechanism.

The architecture seems to assume all apps run in the same process (since the `EventBus` is described as "in-process" and "passed by reference"), but this is never stated explicitly, and the monorepo `apps/` structure normally implies separate processes.

**Recommendation**: Clarify explicitly whether this is a single-process architecture (all apps imported and run together in one Bun process) or a multi-process architecture (each app is a separate process). If single-process, rename `apps/` to something less ambiguous (e.g., `domains/` or `modules/`), and document the single entry point. If multi-process, add an IPC layer (e.g., a lightweight HTTP endpoint or Bun's `IPC` channel) for `telegram-bot` to request `sendKeys` operations from the orchestrator. The IPC path should be architecturally documented and the security implications addressed (input from one process driving keystrokes in another).

---

### [MEDIUM] No error boundary or backpressure for high-volume PaneOutput events to Telegram

**Description**: Every `pane-output` event from every pane emits a `PaneOutput` event on the bus. The Telegram adapter's `handlePaneOutput` appends to an in-memory buffer and schedules a flush. With 10 concurrent panes each emitting high-volume output (e.g., a CLI agent generating a large code file), the Telegram adapter's output buffer could grow unbounded. The architecture documents a max queue depth of 100 for the `RateLimitQueue`, but the output buffer per pane has no stated size cap.

Additionally, dropping the oldest queue entry (when max depth is exceeded) silently discards output, which will create gaps in the Telegram topic's view of the pane output. This may be acceptable, but it is not documented as a deliberate policy.

**Recommendation**: Document the maximum output buffer size per pane and the overflow policy. A reasonable policy: if the buffer for a pane exceeds 12,000 characters (the file-upload threshold), immediately flush to file upload rather than continuing to buffer. This also aligns with FR-TG-06. Add a structured log entry when buffer overflow is triggered so operators can detect panes with excessive output volume.

---

### [MEDIUM] Voice call cancellation race between Telegram reply and call initiation

**Description**: Section 3.2 shows that when a user replies via Telegram, `bus.emit({ type: 'InputDelivered', ... })` causes the voice-server to cancel the pending outbound call. However, the voice-server initiates a call asynchronously after receiving `PaneAwaitingInput`. If the Telegram reply arrives while the Twilio API call to initiate the outbound call is in flight (i.e., after the voice-server has started the HTTP request to Twilio but before it receives the callSid), there is no callSid to cancel. The `InputDelivered` handler would check for a pending call, find none (callSid not yet assigned), and do nothing. The call would then proceed to connect.

**Recommendation**: Add a per-pane call state machine in the voice-server with states: `idle | initiating | ringing | connected | cancelling`. The `InputDelivered` handler transitions to `cancelling` regardless of current state. When the Twilio API returns the callSid in the `initiating` state, the system immediately calls `twilio.calls(callSid).update({ status: 'completed' })`. This is a standard Twilio pattern for cancelling outbound calls before answer.

---

### [MEDIUM] Audio codec conversion library is unspecified and may not exist as a pure JS/Bun package

**Description**: Section 7.3 describes the audio format conversion chain (μ-law 8kHz ↔ PCM16 16kHz) and refers to "custom G.711 decoder + Sox-style resampler or audiobuffer-resampler npm." The `audiobuffer-resampler` package is a browser-oriented library that depends on the Web Audio API, which is not available in Bun or Node.js without a polyfill. Sox is a native binary, not an npm package.

**Recommendation**: Identify and validate a specific pure-JS or Bun-compatible G.711 codec + resampler before Phase 4. Candidates: `@datastream/mulaw` (G.711 μ-law codec, pure JS), combined with a simple linear interpolation resampler (8kHz → 16kHz is a clean 2x upsample, trivially implementable). The resampler does not need Sox — a 2x upsample by linear interpolation is ~20 lines of TypeScript. Name the chosen library explicitly in the architecture to prevent a last-minute dependency scramble in Phase 4.

---

### [LOW] `processingCount` is mutated in the pipeline but also read by the quiescence scheduler — no memory ordering guarantee is documented

**Description**: The architecture relies on Bun's single-threaded event loop to make `processingCount` a safe lock-free counter (Section 3.3). This is correct as long as all reads and writes are synchronous and no `await` appears between the read and write. However, `state-manager (PRE)` increments `processingCount` synchronously, then calls `next()` (which is async), then decrements in a `finally` block. The quiescence scheduler reads `processingCount` inside its own `setInterval` callback. Since both execute on the single JS thread, there is no true race, but the sequencing depends on the event loop not yielding between the scheduler's read and the pipeline's increment.

**Recommendation**: Add a brief comment in the code (and a note in the architecture) explicitly stating the safety invariant: "all reads of `processingCount` in the scheduler and all writes in `state-manager` occur synchronously (no `await` between them), making them safe on Bun's single-threaded event loop." This prevents a future developer from adding an `await` before the increment, which would silently break the invariant.

---

### [LOW] Schema migration strategy is deferred with no migration mechanism specified

**Description**: Section 9.2 mentions "validate schemaVersion (migrate if needed)" in the startup sequence, and Phase 6 includes "Schema versioning and migration for `state.json`." However, no migration mechanism is described. For a JSON file that contains active session state (pane-to-topic mappings, notification state), a failed or mishandled migration during a restart could result in all topic mappings being lost — requiring the user to manually re-associate all panes with their topics.

**Recommendation**: Design a simple migration path now, even if only one schema version exists: define a `migrations: Record<number, (old: unknown) => unknown>` map in `state-store`. For v1 this is a no-op passthrough. When a second schema version is introduced, the migration function transforms the v1 JSON to v2 before writing. Also document the "migration fails" path: fall back to `state.json.bak`, log an error, and notify the operator via stderr. This prevents silent state loss.

---

### [LOW] `SirkoEvent` union does not include a `PaneCreated` event type

**Description**: The requirements (FR-TMUX-02, FR-TMUX-07) require that the system model pane creation and support spawning new panes. The `SirkoEvent` union (Section 4.1) includes `SessionCreated`, `SessionClosed`, `WindowAdded`, `WindowClosed`, and `PaneExited`, but no `PaneCreated` event. The Telegram adapter creates forum topics on "new pane detected (SessionCreated / first PaneOutput)" (Section 8.1), using `PaneOutput` as a proxy for pane creation. This is fragile: a pane that never produces output (e.g., a pane running a program that waits silently for input immediately) will never trigger topic creation.

**Recommendation**: Add `PaneCreated` to the `SirkoEvent` union and emit it from `notification-fanout` (or from `state-manager (PRE)` on first sight of a new pane). The Telegram adapter should listen for `PaneCreated` to trigger topic creation, rather than relying on the first `PaneOutput` event. This also aligns with FR-TMUX-02's requirement to model the pane hierarchy explicitly.

---

### [LOW] No defined strategy for apps/web to access live EventBus data

**Description**: `apps/web` (Phase 6) is specified as a React dashboard using TanStack Query and TanStack Router. It needs to display live pane status, detection confidence scores, and log output. The architecture does not define how the web app receives this data. If the orchestrator and web app are in the same process, the web app could subscribe to the EventBus directly. If they are separate processes (the standard interpretation of `apps/`), a WebSocket or SSE endpoint in the orchestrator would be needed.

**Recommendation**: Since this is Phase 6 and optional, a low-complexity solution is sufficient: add a lightweight WebSocket endpoint to the orchestrator that broadcasts `SirkoEvent` objects as JSON to connected web clients. TanStack Query can poll a REST endpoint for initial state (`GET /api/panes`), with WebSocket updates layered on top. Document this in the architecture now to avoid designing the web app in a vacuum.

---

## Requirements Coverage Check

| Requirement | Coverage | Notes |
|---|---|---|
| FR-TMUX-01 through FR-TMUX-08 | Covered | See Sections 1.4, 2.2 (tmux-client), 9.3 |
| FR-DETECT-01 through FR-DETECT-05 | Covered | See Sections 6.1–6.3, 4.4 (SkillDefinition) |
| FR-TG-01 through FR-TG-09 | Mostly covered | FR-TG-03 has unverified API dependency (CRITICAL finding above) |
| FR-VOICE-01 through FR-VOICE-05 | Covered | See Section 7 |
| FR-VOICE-06 through FR-VOICE-09 | Covered (Phase 5) | Bun compatibility unvalidated (HIGH finding above) |
| FR-ORCH-01 through FR-ORCH-05 | Covered | FR-ORCH-04 has race condition (MEDIUM finding above) |
| NFR-PERF-01 through NFR-PERF-05 | Covered | Latency budget analysis in Section 7.4 |
| NFR-SEC-01 through NFR-SEC-06 | Covered | See Section 12 |
| NFR-REL-01 through NFR-REL-05 | Covered | Reconnection in Section 9.3; fallback in Phase 4 |
| NFR-MAINT-01 through NFR-MAINT-03 | Covered | Plugin system (Section 2.2), VoiceTransport abstraction (Section 4.5), structured logs (Section 5, Middleware 8) |
| CON-STACK-01 through CON-STACK-14 | Covered | Bun compatibility risks noted but mitigations incomplete |
| CON-API-01 through CON-API-04 | Partially covered | CON-API-01 (`sendMessageDraft`) unverified — CRITICAL finding |

**Gap**: `FR-TMUX-04` lists `%window-add` and `%window-close` as required events. The `TmuxEvent` type union (Section 4.2) includes `window-add` and `window-close`, but the `SirkoEvent` union (Section 4.1) does not include `WindowAdded` or `WindowClosed` events. Window events are parsed but apparently not propagated to adapters. This is likely intentional (adapters care about panes, not windows), but it should be documented explicitly.

---

## Verdict

**CONDITIONAL APPROVE**

The architecture is production-grade in its thinking and ready for implementation with the following conditions:

1. **Resolve the `sendMessageDraft` availability question** before writing any Telegram adapter code. Design the fallback inline in the architecture document if the API is unavailable.

2. **Validate `@xterm/headless` under Bun in Phase 1** (this is already planned) and design the fallback `TerminalEmulator` interface now, not when the issue is discovered mid-implementation. The fallback capability regression needs to be documented so prompt patterns are written accordingly.

3. **Add the `quiescenceCheckInFlight` guard** (or equivalent) to the scheduler before Phase 2 begins, to prevent concurrent QuiescenceCheck pipeline injections.

4. **Clarify single-process vs. multi-process architecture** before Phase 3. The `telegram-bot` → `tmuxClient.sendKeys` dependency path must be explicit.

The remaining MEDIUM and LOW findings are all well within the ability of the implementation to address as they are encountered, and none of them invalidate the core design.
