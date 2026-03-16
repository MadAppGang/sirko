# Test Plan: Sirko Orchestrator

## Overview
- **Feature**: Sirko — tmux-based CLI agent orchestration with Telegram/voice interfaces
- **Requirements**: ai-docs/sessions/dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f/requirements.md
- **Architecture (API contracts)**: Section 4 of architecture.md
- **Test Count**: 52 scenarios

---

## Test Scenarios

### Feature: tmux-client — Protocol Parsing

#### TEST-001: Parse %output event
- **Type**: unit
- **Priority**: critical
- **Given**: A raw control-mode line `%output %3 hello world`
- **When**: `parseControlModeLine()` is called
- **Then**: Returns `{ type: 'output', paneId: '%3', data: 'hello world' }`
- **Requirements**: FR-TMUX-04

#### TEST-002: Parse %begin / %end delimiters
- **Type**: unit
- **Priority**: critical
- **Given**: Lines `%begin 1234 0 1` and `%end 1234 0 1`
- **When**: `parseControlModeLine()` is called on each
- **Then**: Returns `{ type: 'begin', time: 1234, ... }` and `{ type: 'end', time: 1234, ... }` respectively
- **Requirements**: FR-TMUX-04

#### TEST-003: Parse %session-created event
- **Type**: unit
- **Priority**: high
- **Given**: A raw line `%session-created $1 main`
- **When**: `parseControlModeLine()` is called
- **Then**: Returns `{ type: 'session-created', sessionId: '$1', name: 'main' }`
- **Requirements**: FR-TMUX-04

#### TEST-004: Parse %pane-exited event
- **Type**: unit
- **Priority**: high
- **Given**: A raw line `%pane-exited %3 $1 @0 0`
- **When**: `parseControlModeLine()` is called
- **Then**: Returns `{ type: 'pane-exited', paneId: '%3', exitCode: 0 }`
- **Requirements**: FR-TMUX-04

#### TEST-005: Unescape tmux output encoding
- **Type**: unit
- **Priority**: high
- **Given**: A tmux-escaped string `hello\\nworld` (literal backslash-n)
- **When**: `unescapeTmuxOutput()` is called
- **Then**: Returns `hello\nworld` (actual newline)
- **Requirements**: FR-TMUX-04

#### TEST-006: Command-response correlation (begin/end pairing)
- **Type**: unit
- **Priority**: critical
- **Given**: An `OutputCoalescer` receiving a `%begin` with time T, output lines, then `%end` with time T
- **When**: The coalescer processes all events
- **Then**: The matched response is emitted as a single correlated unit keyed by time T
- **Requirements**: FR-TMUX-04

#### TEST-007: Pane ID stability — canonical form
- **Type**: unit
- **Priority**: critical
- **Given**: A pane reference in dotted form `session:window.3`
- **When**: `paneIdFromString()` is called (from @sirko/shared)
- **Then**: Returns `%3` in canonical form
- **Requirements**: FR-TMUX-03

#### TEST-008: Pane ID already canonical
- **Type**: unit
- **Priority**: high
- **Given**: A string `%42`
- **When**: `paneIdFromString()` is called
- **Then**: Returns `%42` unchanged
- **Requirements**: FR-TMUX-03

#### TEST-009: Pane ID unrecognised format returns null
- **Type**: unit
- **Priority**: medium
- **Given**: A string `notapane`
- **When**: `paneIdFromString()` is called
- **Then**: Returns `null`
- **Requirements**: FR-TMUX-03

---

### Feature: state-store — CRUD Operations

#### TEST-010: Create and retrieve pane state
- **Type**: unit
- **Priority**: critical
- **Given**: A `StateStore` instance and a `PaneState` object for pane `%1`
- **When**: `upsertPane()` is called, then `getPane('%1')` is called
- **Then**: The returned pane state matches the inserted object
- **Requirements**: FR-ORCH-01

#### TEST-011: Update existing pane state
- **Type**: unit
- **Priority**: critical
- **Given**: A `StateStore` with pane `%1` in status `running`
- **When**: `upsertPane()` is called with `status: 'awaiting-input'`
- **Then**: `getPane('%1').status` returns `awaiting-input`
- **Requirements**: FR-ORCH-01

#### TEST-012: Get non-existent pane returns undefined
- **Type**: unit
- **Priority**: high
- **Given**: An empty `StateStore`
- **When**: `getPane('%99')` is called
- **Then**: Returns `undefined`
- **Requirements**: FR-ORCH-01

#### TEST-013: List all panes
- **Type**: unit
- **Priority**: high
- **Given**: A `StateStore` with panes `%1`, `%2`, `%3`
- **When**: `getAllPanes()` is called
- **Then**: Returns an array of 3 `PaneState` objects with IDs `%1`, `%2`, `%3`
- **Requirements**: FR-ORCH-01

#### TEST-014: Persistence round-trip — save and load
- **Type**: integration
- **Priority**: critical
- **Given**: A `StateStore` with pane `%5` and telegramTopicId 42, saved to a temp directory
- **When**: A new `StateStore` is created from the same directory
- **Then**: `getPane('%5').telegramTopicId` equals 42; `schemaVersion` equals 1
- **Requirements**: NFR-REL-03

#### TEST-015: Atomic write — tmp file rename
- **Type**: integration
- **Priority**: high
- **Given**: A `StateStore` that has been persisted
- **When**: The data directory is inspected
- **Then**: No `state.json.tmp` file remains; `state.json` and `state.json.bak` exist
- **Requirements**: NFR-REL-03, architecture §5.2

#### TEST-016: Migration from unknown schema version
- **Type**: unit
- **Priority**: medium
- **Given**: Raw JSON with `schemaVersion: 0` or an unknown older version
- **When**: `migrate()` is called
- **Then**: Either `MigrationError` is thrown or the state is upgraded to `CURRENT_SCHEMA_VERSION`
- **Requirements**: NFR-REL-03

#### TEST-017: Concurrent upsert safety
- **Type**: unit
- **Priority**: high
- **Given**: A `StateStore` with pane `%1` initially `running`
- **When**: 10 concurrent `upsertPane` calls each set different fields
- **Then**: Final state is internally consistent (no undefined fields, no corruption)
- **Requirements**: FR-ORCH-01

---

### Feature: event-bus — Type-Safe Routing

#### TEST-018: Subscribe and receive event
- **Type**: unit
- **Priority**: critical
- **Given**: A `TypedEventBus` with a subscriber for `PaneOutput` events
- **When**: `emit({ type: 'PaneOutput', paneId: '%1', ... })` is called
- **Then**: The subscriber callback is invoked exactly once with the correct payload
- **Requirements**: FR-ORCH-02

#### TEST-019: Subscriber only receives its own event type
- **Type**: unit
- **Priority**: critical
- **Given**: A `TypedEventBus` with subscriber A on `PaneOutput` and subscriber B on `PaneAwaitingInput`
- **When**: A `PaneOutput` event is emitted
- **Then**: Subscriber A is called once; subscriber B is never called
- **Requirements**: FR-ORCH-02

#### TEST-020: Error in subscriber is isolated
- **Type**: unit
- **Priority**: critical
- **Given**: A `TypedEventBus` with subscriber A that throws, and subscriber B that does not
- **When**: An event is emitted
- **Then**: Subscriber B still receives the event; the bus does not crash
- **Requirements**: NFR-REL-02 (error isolation)

#### TEST-021: Queue overflow drops oldest events
- **Type**: unit
- **Priority**: high
- **Given**: A `TypedEventBus` configured with `maxQueueSize: 5` and a slow subscriber
- **When**: 10 events are emitted rapidly
- **Then**: At most 5 events are delivered; the bus does not throw or block indefinitely
- **Requirements**: NFR-PERF-05

#### TEST-022: Unsubscribe stops delivery
- **Type**: unit
- **Priority**: high
- **Given**: A `TypedEventBus` with a subscriber that has been unsubscribed
- **When**: An event is emitted after unsubscription
- **Then**: The subscriber callback is never called
- **Requirements**: FR-ORCH-02

---

### Feature: detector — Signal Combination

#### TEST-023: All signals present → score exceeds threshold → awaiting = true
- **Type**: unit
- **Priority**: critical
- **Given**: `DetectorEngine` with default weights; wchan = waiting, quiescence = exceeded, prompt matched
- **When**: `computeScore()` is called
- **Then**: `result.awaiting === true` and `result.score >= threshold`
- **Requirements**: FR-DETECT-01, FR-DETECT-02

#### TEST-024: No signals present → score below threshold → awaiting = false
- **Type**: unit
- **Priority**: critical
- **Given**: `DetectorEngine` with no signals firing (process running, output recent, no prompt match)
- **When**: `computeScore()` is called
- **Then**: `result.awaiting === false`
- **Requirements**: FR-DETECT-01, FR-DETECT-02

#### TEST-025: Per-tool weight calibration — claude-code skill
- **Type**: unit
- **Priority**: high
- **Given**: `DetectorEngine` with `claudeCodeSkill` plugin and a prompt matching claude's prompt pattern
- **When**: `computeScore()` is called
- **Then**: `result.tool === 'claude-code'` and weight contributions match `claudeCodeSkill.signalWeights`
- **Requirements**: FR-DETECT-03, FR-DETECT-04

#### TEST-026: Per-tool weight calibration — codex skill
- **Type**: unit
- **Priority**: high
- **Given**: `DetectorEngine` with `codexSkill` plugin and a prompt matching codex's prompt pattern
- **When**: `computeScore()` is called
- **Then**: `result.tool === 'codex'`
- **Requirements**: FR-DETECT-03, FR-DETECT-04

#### TEST-027: Per-tool weight calibration — aider skill
- **Type**: unit
- **Priority**: high
- **Given**: `DetectorEngine` with `aiderSkill` plugin
- **When**: `computeScore()` is called with aider's known prompt patterns
- **Then**: `result.tool === 'aider'`
- **Requirements**: FR-DETECT-03, FR-DETECT-04

#### TEST-028: Edge case — no process (pid = null)
- **Type**: unit
- **Priority**: high
- **Given**: `DetectorEngine` called with `pid = null`
- **When**: `computeScore()` is called
- **Then**: wchan signal contributes 0; no error thrown; result.signals.wchan.isWaiting === false
- **Requirements**: FR-DETECT-01

#### TEST-029: Edge case — empty buffer
- **Type**: unit
- **Priority**: high
- **Given**: `DetectorEngine` called with an empty terminal buffer string
- **When**: `computeScore()` is called
- **Then**: promptPattern signal contributes 0; no error thrown; result.signals.promptPattern.matched === false
- **Requirements**: FR-DETECT-01

#### TEST-030: Signal breakdown structure
- **Type**: unit
- **Priority**: medium
- **Given**: Any `DetectorEngine.computeScore()` call
- **When**: Result is returned
- **Then**: `result.signals` contains `promptPattern`, `wchan`, and `quiescence` each with `weight` and `contribution` fields
- **Requirements**: FR-DETECT-05

#### TEST-031: Confidence score range
- **Type**: unit
- **Priority**: medium
- **Given**: Any `DetectorEngine.computeScore()` call
- **When**: Result is returned
- **Then**: `result.confidence` is in range [0, 1] and `result.score` is a finite number >= 0
- **Requirements**: FR-DETECT-05

#### TEST-032: QuiescenceTracker reports silence after threshold
- **Type**: unit
- **Priority**: high
- **Given**: A `QuiescenceTracker` with threshold 200ms; last output was recorded 300ms ago
- **When**: `getScore()` is called
- **Then**: `score.silenceMs >= 200` and silence is considered exceeded
- **Requirements**: FR-DETECT-01

#### TEST-033: PromptMatcher matches known claude pattern
- **Type**: unit
- **Priority**: high
- **Given**: `PromptMatcher` initialized with `claudeCodeSkill.promptPatterns`; buffer contains `"> "`
- **When**: `match()` is called
- **Then**: Returns `{ matched: true, pattern: ... }`
- **Requirements**: FR-DETECT-01, FR-DETECT-03

---

### Feature: pipeline — Middleware Ordering and Context Propagation

#### TEST-034: Middleware executes in registration order
- **Type**: unit
- **Priority**: critical
- **Given**: A `compose()` pipeline with middleware A, B, C each appending to a trace array
- **When**: `pipeline.run(ctx)` is called
- **Then**: Trace is `['A', 'B', 'C']`
- **Requirements**: architecture §4.1 (`Pipeline.run`)

#### TEST-035: Middleware can modify context
- **Type**: unit
- **Priority**: critical
- **Given**: A pipeline where middleware A sets `ctx.foo = 1` and middleware B reads `ctx.foo`
- **When**: `pipeline.run(ctx)` is called
- **Then**: Middleware B sees `ctx.foo === 1`
- **Requirements**: architecture §4.1

#### TEST-036: Middleware error stops pipeline without crashing bus
- **Type**: unit
- **Priority**: critical
- **Given**: A pipeline where middleware B throws; middleware C is after B
- **When**: `pipeline.run(ctx)` is called
- **Then**: Middleware C does NOT execute; the error is caught and logged without crashing the process
- **Requirements**: NFR-REL-02

#### TEST-037: buildContext creates valid EventContext
- **Type**: unit
- **Priority**: high
- **Given**: A `TmuxEvent` of type output and a `StateStore` instance
- **When**: `buildContext(event, store)` is called
- **Then**: Returned `EventContext` has non-null `pane`, `event`, and `sideEffects` fields
- **Requirements**: architecture §4.1

---

### Feature: telegram-adapter — Message Routing

#### TEST-038: truncateForTelegram — within limit passes through
- **Type**: unit
- **Priority**: critical
- **Given**: Text of 100 characters
- **When**: `truncateForTelegram(text)` is called
- **Then**: Returned string equals original text (no truncation)
- **Requirements**: FR-TG-05, CON-API-02

#### TEST-039: truncateForTelegram — 4097 chars truncates with suffix
- **Type**: unit
- **Priority**: critical
- **Given**: Text of exactly 4097 characters
- **When**: `truncateForTelegram(text)` is called
- **Then**: Returned string length is exactly 4096; ends with `…[truncated]`
- **Requirements**: FR-TG-05, CON-API-02

#### TEST-040: truncateForTelegram — exactly 4096 chars unchanged
- **Type**: unit
- **Priority**: high
- **Given**: Text of exactly 4096 characters
- **When**: `truncateForTelegram(text)` is called
- **Then**: Returned string equals original (no truncation)
- **Requirements**: CON-API-02

#### TEST-041: Output > 12000 chars must be file attachment (behavioral contract)
- **Type**: integration
- **Priority**: high
- **Given**: A pane output event with `text.length > 12000`
- **When**: The telegram adapter processes the event
- **Then**: The adapter emits a file upload action (not an inline message) in side effects
- **Requirements**: FR-TG-06

#### TEST-042: sanitizeForSendKeys removes control characters
- **Type**: unit
- **Priority**: critical
- **Given**: A string containing ASCII control characters (e.g., `\x00`, `\x1b`, `\x08`) and normal text
- **When**: `sanitizeForSendKeys(text)` is called
- **Then**: All control chars except `\t` and `\n` are removed; normal text is preserved
- **Requirements**: FR-TMUX-06 (safe send-keys input)

#### TEST-043: sanitizeForSendKeys preserves tab and newline
- **Type**: unit
- **Priority**: high
- **Given**: A string `"hello\tworld\nbye"`
- **When**: `sanitizeForSendKeys(text)` is called
- **Then**: Returns `"hello\tworld\nbye"` unchanged
- **Requirements**: FR-TMUX-06

---

### Feature: voice-adapter — Circuit Breaker and Call Lifecycle

#### TEST-044: VoiceCallStarted event shape
- **Type**: unit
- **Priority**: high
- **Given**: A `VoiceCallStarted` event object
- **When**: Its type is checked
- **Then**: Has fields `paneId: string`, `callSid: string`, `transport: 'twilio' | 'livekit'`
- **Requirements**: FR-VOICE-01, events.ts public contract

#### TEST-045: VoiceCallFailed event shape
- **Type**: unit
- **Priority**: high
- **Given**: A `VoiceCallFailed` event object
- **When**: Its type is checked
- **Then**: Has fields `paneId: string`, `reason: string`
- **Requirements**: NFR-REL-04, events.ts public contract

#### TEST-046: AudioFormat — mulaw 8kHz is accepted
- **Type**: unit
- **Priority**: critical
- **Given**: An `AudioFormat` object `{ codec: 'mulaw', sampleRate: 8000, channels: 1 }`
- **When**: Validated against the `AudioFormat` type
- **Then**: Is a valid `AudioFormat` value with no type errors
- **Requirements**: CON-API-04, FR-VOICE-03

---

### Feature: orchestrator — End-to-End Integration

#### TEST-047: PaneOutput event emitted from pipeline
- **Type**: integration (pipeline-flow)
- **Priority**: critical
- **Given**: A mock `TmuxEvent` of type `output` for pane `%1`, fed into an assembled pipeline with an `EventBus`
- **When**: `pipeline.run(ctx)` completes
- **Then**: `EventBus` emits a `PaneOutput` event with matching `paneId` and non-empty `text`
- **Requirements**: FR-ORCH-01, FR-DETECT-05

#### TEST-048: PaneAwaitingInput event emitted when all signals fire
- **Type**: integration (detection-accuracy)
- **Priority**: critical
- **Given**: A pipeline context where detection signals all fire (quiescence exceeded, prompt matched, wchan waiting)
- **When**: `pipeline.run(ctx)` completes
- **Then**: `EventBus` emits a `PaneAwaitingInput` event with `awaiting === true` and `confidence > 0`
- **Requirements**: FR-DETECT-01 through FR-DETECT-05

#### TEST-049: No PaneAwaitingInput if already notified (dedup)
- **Type**: integration
- **Priority**: critical
- **Given**: Pane state with `notificationState: 'notified'`; detection signals fire again
- **When**: Pipeline processes another output event
- **Then**: `PaneAwaitingInput` is NOT re-emitted (dedup middleware suppresses it)
- **Requirements**: FR-ORCH-03

#### TEST-050: Telegram routing — message to correct topic
- **Type**: integration (telegram-routing)
- **Priority**: critical
- **Given**: Pane `%1` mapped to topic 100; pane `%2` mapped to topic 200; a `PaneOutput` event for `%1`
- **When**: A telegram adapter mock processes the event
- **Then**: Output is routed to topic 100, NOT topic 200
- **Requirements**: FR-TG-02, FR-TG-07

#### TEST-051: Telegram routing — incoming message to correct pane
- **Type**: integration (telegram-routing)
- **Priority**: critical
- **Given**: Topic 100 maps to pane `%1`; a user message arrives in topic 100
- **When**: The telegram adapter routes the message
- **Then**: An `InputDelivered` event is emitted with `paneId: '%1'` and `source: 'telegram'`
- **Requirements**: FR-TG-07

#### TEST-052: Detection accuracy differs across CLI tools
- **Type**: integration (detection-accuracy)
- **Priority**: high
- **Given**: `DetectorEngine` evaluating the same quiescence/wchan signals for `claude-code` vs `aider`
- **When**: Prompt patterns specific to each tool are present in the buffer
- **Then**: Confidence score differs between tools (tool-specific calibration is applied)
- **Requirements**: FR-DETECT-03, FR-DETECT-04

---

## Coverage Matrix

| Requirement | Test Cases | Coverage |
|-------------|------------|----------|
| FR-TMUX-03 (pane ID stability) | TEST-007, 008, 009 | 100% |
| FR-TMUX-04 (protocol parsing) | TEST-001, 002, 003, 004, 005, 006 | 100% |
| FR-TMUX-06 (send-keys input) | TEST-042, 043 | 100% |
| FR-DETECT-01 (3-signal combination) | TEST-023, 024, 028, 029, 032, 033 | 100% |
| FR-DETECT-02 (weighted threshold) | TEST-023, 024, 030, 031 | 100% |
| FR-DETECT-03 (plugin system) | TEST-025, 026, 027, 033, 052 | 100% |
| FR-DETECT-04 (built-in tools) | TEST-025, 026, 027 | 100% |
| FR-DETECT-05 (event shape) | TEST-030, 047, 048 | 100% |
| FR-TG-02 (topic mapping) | TEST-050, 051 | 100% |
| FR-TG-05 (expandable blockquote) | TEST-038, 039, 040 | partial |
| FR-TG-06 (file >12k) | TEST-041 | 100% |
| FR-TG-07 (message routing) | TEST-050, 051 | 100% |
| FR-ORCH-01 (state model) | TEST-010, 011, 012, 013, 047 | 100% |
| FR-ORCH-02 (fan-out) | TEST-018, 019 | 100% |
| FR-ORCH-03 (dedup) | TEST-049 | 100% |
| FR-VOICE-01/03 (call lifecycle) | TEST-044, 045, 046 | partial |
| NFR-REL-02 (error isolation) | TEST-020, 036 | 100% |
| NFR-REL-03 (persistence) | TEST-014, 015, 016 | 100% |
| NFR-PERF-05 (queue overflow) | TEST-021 | 100% |
| CON-API-02 (4096 char limit) | TEST-038, 039, 040 | 100% |
| CON-API-04 (mulaw audio) | TEST-046 | 100% |

---

## Execution Strategy

1. **Unit tests first** (TEST-001 through TEST-033, TEST-038 through TEST-046) — no I/O, fast feedback
2. **Integration tests** (TEST-034 through TEST-037, TEST-047 through TEST-052) — validate cross-package contracts
3. **E2E smoke tests** — manual only (requires live tmux + Telegram credentials)

## Known Gaps

- FR-TG-03 (`sendMessageDraft` streaming) — requires live Telegram API; not covered in automated tests
- FR-TG-08 (session management commands) — behavioral contract requires bot running; deferred to E2E
- FR-TG-09 (rate limiting 20/min, 30/s) — requires time-based testing with real queue; partially covered by TEST-021
- FR-VOICE-02 through FR-VOICE-05 (voice pipeline stages) — require Twilio/Deepgram/ElevenLabs; deferred to manual testing
- NFR-REL-01 (reconnection with exponential backoff) — requires live tmux socket; deferred to manual testing
- NFR-PERF-01 through NFR-PERF-04 (latency targets) — require instrumented real environment
