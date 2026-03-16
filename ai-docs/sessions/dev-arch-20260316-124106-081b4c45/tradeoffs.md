# Sirko — Architecture Trade-off Analysis

**Session**: dev-arch-20260316-124106-081b4c45
**Date**: 2026-03-16
**Status**: Final

---

## 1. Trade-off Matrix

Scores are 1–5 where 5 is best (most favorable for this project).

| Dimension | Alt A: Event-Driven | Alt B: Actor-Model | Alt C: Pipeline/MW |
|---|:---:|:---:|:---:|
| Performance | 4 | 3 | 4 |
| Maintainability | 3 | 3 | 4 |
| Scalability | 4 | 5 | 3 |
| Security | 3 | 4 | 4 |
| Development effort (v1 speed) | 4 | 2 | 5 |
| Operational complexity | 3 | 2 | 4 |
| Cost | 4 | 3 | 4 |
| Testability | 3 | 4 | 5 |
| Extensibility (new tools/adapters) | 5 | 4 | 3 |
| Debugging / Observability | 3 | 2 | 5 |
| **TOTAL** | **36** | **31** | **41** |

---

## 2. Dimension-by-Dimension Justification

### 2.1 Performance

**Alt A: Event-Driven — 4/5**

The in-process EventEmitter is synchronous for each emit call, meaning all handlers for a given event execute within the same microtask queue turn. This satisfies NFR-PERF-02 (≤50ms tmux event-to-state-update latency) without any inter-thread serialization overhead. The main risk is that a slow subscriber (e.g., a Telegram rate-limit wait) can block subsequent subscribers if handlers are not carefully made async — requiring discipline in handler implementation.

**Alt B: Actor-Model — 3/5**

Each pane output event traverses at least two async mailbox enqueue/dequeue cycles: OrchestratorActor → PaneActor → DetectorActor. At 10 concurrent panes each producing bursty output (NFR-PERF-05), the async queue overhead accumulates. The mailbox pattern adds bounded but real latency on the critical path from tmux event to state update, making the ≤50ms target harder to guarantee without profiling and tuning. The concurrency model is well-suited for isolation but wastes cycles on indirection for what is fundamentally single-threaded I/O work in Bun.

**Alt C: Pipeline/Middleware — 4/5**

The Koa-style middleware chain executes sequentially in a single async chain per event, which is highly cache-friendly and predictable. Each middleware `await`s only when doing actual I/O (wchan check, file append), not for dispatch overhead. The main performance risk is that the pipeline is sequential within one event: parallel fan-out to Telegram and Voice sinks requires explicit `Promise.all()` inside the notification middleware, which is straightforward to implement correctly.

---

### 2.2 Maintainability

**Alt A: Event-Driven — 3/5**

Adding a new subscriber to handle a new concern is easy, but tracing the full behavior for a given event requires following subscriptions across multiple packages. When a bug manifests (e.g., a duplicate notification), the developer must reconstruct the event flow from multiple independent handlers, none of which have direct visibility into each other. The event shape is a shared contract: renaming a field in `PaneAwaitingInput` requires finding and updating all subscribers, and TypeScript helps but does not prevent runtime mismatches if some subscriber is conditionally registered.

**Alt B: Actor-Model — 3/5**

Within an individual actor, the state machine is highly maintainable: all behavior for a pane is in `PaneActor.receive()`. However, the custom `actor-runtime` package is infrastructure code that the team owns and must maintain indefinitely. Bugs in the runtime (mailbox starvation, supervision restart loops) are foundational and time-consuming to debug. The supervision tree design must also be revisited if new actor types are added, requiring more upfront architectural judgment than the other alternatives.

**Alt C: Pipeline/Middleware — 4/5**

The middleware stack is self-documenting: reading the `compose([...])` call in `app.ts` tells a new developer the exact order in which every event is processed. Adding a new cross-cutting concern (e.g., a metrics middleware) means inserting one function at the appropriate position with no changes to existing code. The primary maintainability risk is `EventContext` growing into a "god object" as more middleware attach fields — mitigated by strict TypeScript typing with distinct context shapes per event type.

---

### 2.3 Scalability

**Alt A: Event-Driven — 4/5**

Adding a new pane requires no structural change: the existing subscribers automatically receive events for the new pane ID. The bus can handle fan-out to arbitrarily many subscribers without explicit routing code. At v1 scale (≤10 panes), this is more than sufficient. If the system ever moves to multiple hosts, the bus abstraction can be transparently replaced with a distributed pub/sub backend (e.g., Redis channels) without changing subscriber code — though this is explicitly out of v1 scope.

**Alt B: Actor-Model — 5/5**

The actor model is intrinsically designed for scale: each pane is an independent, self-contained unit of execution. Adding panes, adding new actor types, or moving actors to separate threads/processes is a structural capability built into the model. For Sirko's v1 use case this headroom is unnecessary, but the model would require the fewest architectural changes if the system needed to manage hundreds of panes or distribute across hosts.

**Alt C: Pipeline/Middleware — 3/5**

The pipeline model scales well within a single event stream but becomes awkward when the same event must be processed differently per pane (e.g., different detection thresholds per tool). Customization requires branching logic inside middleware rather than per-pane specialization. Extending to multiple concurrent tmux servers would require either multiple pipeline instances or multiplexing logic in the pipeline runner, neither of which is elegantly expressed in the middleware composition model.

---

### 2.4 Security

**Alt A: Event-Driven — 3/5**

The event bus is a shared singleton in the process. Any component that has a reference to the bus can subscribe to any event type, including sensitive ones (e.g., `InputDelivered` events containing user input text). There is no built-in capability to restrict which subscribers can receive which event types. For a personal/small-team tool (NFR-SEC-01 defers auth to future versions), this is acceptable in v1, but the architecture does not naturally enforce information boundaries.

**Alt B: Actor-Model — 4/5**

Actors communicate only through explicit `ActorRef` handles. A component cannot receive messages unless another component holds its `ActorRef` and explicitly sends to it. This is a natural capability boundary: the `VoiceActor` has no knowledge of Telegram messages; `PaneActor` has no knowledge of voice call state. Secret material (API keys from environment variables) can be injected into actor constructors and never shared with the bus or other actors, enforcing the spirit of NFR-SEC-04.

**Alt C: Pipeline/Middleware — 4/5**

The `EventContext` passed through the pipeline accumulates data from all middleware, meaning sensitive data (parsed pane text containing credentials or keys that a user typed) is visible to every downstream middleware in the chain. However, because the pipeline is a controlled, ordered, explicitly-composed chain, it is straightforward to audit which middleware can access which data. Middleware ordering provides a natural "drop sensitive fields before logging" pattern, and the sink boundary (Telegram/Voice sinks are separate from the pipeline) limits what external APIs receive.

---

### 2.5 Development Effort (v1 Speed)

**Alt A: Event-Driven — 4/5**

The bus is a thin typed wrapper over Bun's native `EventEmitter` (estimated at ~50–100 lines). Each package can be built independently and tested against a fake bus. The first working end-to-end path (tmux event → Telegram message) can be assembled quickly because no new abstractions need to be designed or implemented — just a typed union and an `on()` wrapper. The main upfront cost is designing the event type union, which is also a useful design exercise that clarifies system boundaries.

**Alt B: Actor-Model — 2/5**

Before writing any business logic, the team must implement a correct `actor-runtime` package: async queues, actor lifecycle, supervision strategies, `ActorRef` types, and crash handling. This is estimated at 200–400 lines of non-trivial infrastructure code that requires thorough testing. The impedance mismatch between grammY's callback-based API and the actor mailbox model also requires a non-trivial adapter. For a v1 system targeting personal use with a ≤10 pane scale, this infrastructure investment has low return.

**Alt C: Pipeline/Middleware — 5/5**

The `compose()` function is approximately 50 lines of well-understood Koa-style code. Each middleware is a standalone function with a clear signature. The pipeline can be assembled incrementally: start with just `[logger, xterm, stateMgr]`, prove output flows through, then add detection and notification. The explicit, linear structure makes the initial implementation the fastest of the three alternatives, and the team gets a working system earlier, leaving more time for calibrating the detection signals and polishing the voice pipeline.

---

### 2.6 Operational Complexity

**Alt A: Event-Driven — 3/5**

In production, diagnosing a misbehavior (e.g., a pane that is not being notified) requires reconstructing which subscribers were registered, in what order, and whether any threw an error silently. Structured logging (NFR-MAINT-03) mitigates this, but the implicit control flow means the operational runbook must document the subscription topology. Reconnect and error recovery logic is distributed across packages, each of which must implement its own retry/backoff for its external connections.

**Alt B: Actor-Model — 2/5**

The supervision tree adds a layer of operational abstraction: when a `PaneActor` crashes and is restarted by the `OrchestratorActor`, the operator must understand the supervision policy to know whether state was preserved. Actor state snapshots add another operational concern: version skew between snapshot schemas and running code after a deployment requires a migration strategy. The custom runtime means that debugging tools (heap snapshots, event loop analysis) may not directly map to the actor abstraction.

**Alt C: Pipeline/Middleware — 4/5**

Each event's processing path is a single, synchronous-ordered chain. A structured log entry emitted at the start and end of each pipeline execution (with the full `EventContext` serialized) is sufficient to reconstruct exactly what happened for any event. The pipeline's sequential nature means a failure in one event's processing does not affect the next event's pipeline execution. Operations staff (or the solo operator) can understand the system's behavior by reading the middleware stack — no graph traversal or message topology required.

---

### 2.7 Cost

**Alt A: Event-Driven — 4/5**

The architecture has no significant infrastructure cost implications beyond the shared baseline. The event bus is in-process and free. The voice pipeline (Deepgram + ElevenLabs) cost is governed by call duration and is the same regardless of architecture. The main indirect cost risk is development time: if event ordering bugs or silent handler failures require extended debugging time, that represents developer cost. For a single-host personal tool this is low.

**Alt B: Actor-Model — 3/5**

The actor-runtime development and ongoing maintenance represents the primary cost differential versus the other alternatives. Estimated initial implementation adds ~1–2 developer-days upfront versus Alt A. If the runtime has reliability issues (deadlocks, starvation), debugging time is non-trivial. The per-pane actor also adds memory overhead (one mailbox queue + actor heap per pane), though at ≤10 panes this is negligible in absolute terms. The longer development timeline (lower v1 speed score) also has opportunity cost.

**Alt C: Pipeline/Middleware — 4/5**

The pipeline infrastructure is the simplest to implement (fastest v1 delivery) and cheapest to maintain (well-understood pattern, no custom runtime). The lower initial development time directly reduces developer cost. The `compose()` utility is ~50 lines with no dependencies and no ongoing maintenance burden. Operational simplicity (score 4/5) reduces the time spent diagnosing production issues, which is also a recurring cost factor.

---

### 2.8 Testability

**Alt A: Event-Driven — 3/5**

Individual packages can be tested in isolation by injecting a mock event bus. However, testing the end-to-end behavior of a sequence (e.g., pane produces output, quiescence elapses, notification fires, user replies, voice is cancelled) requires either a real bus with timing-sensitive assertions or a carefully controlled fake bus that allows synchronous emission. The lack of return values from event handlers means tests must assert on side effects (messages emitted, files written) rather than function outputs, which is more verbose and brittle.

**Alt B: Actor-Model — 4/5**

Each actor can be tested as a pure function: given an initial state and a sequence of input messages, assert on the resulting state and the messages sent to mock `ActorRef` targets. This is highly amenable to property-based testing. The FIFO mailbox guarantee means test scenarios are deterministic within an actor. The main testing complexity is the supervision tree: integration tests must bootstrap enough of the actor hierarchy to exercise cross-actor interactions, which has more boilerplate than a simple function call.

**Alt C: Pipeline/Middleware — 5/5**

Individual middleware functions have the clearest testing interface of all three alternatives: construct an `EventContext` with the relevant fields, call `middleware(ctx, next)`, and assert on mutations to `ctx` and whether `next()` was called. No bus, no actor system, no async queue required. The full pipeline can be integration-tested by composing a real middleware stack and feeding it a sequence of `EventContext` objects, asserting on the final state after each. The `SideEffect[]` accumulation pattern specifically enables dry-run testing modes where effects are declared but not executed.

---

### 2.9 Extensibility (New Tools/Adapters)

**Alt A: Event-Driven — 5/5**

Adding a new notification channel (e.g., Slack, webhook, desktop notification) requires creating a new package that subscribes to `PaneAwaitingInput` events — zero changes to existing code. Adding a new CLI tool plugin requires adding a config entry to `tool-plugins` — no changes to the detector's signal logic. The event contract is the extension interface. This is the architecture's primary competitive advantage for the specific extensibility dimension described in NFR-MAINT-01 and the plugin system in FR-DETECT-03.

**Alt B: Actor-Model — 4/5**

Adding a new notification sink requires creating a new actor and registering its `ActorRef` with the `OrchestratorActor`. This is slightly more involved than a bus subscription (requires modifying the orchestrator's fan-out logic to include the new actor ref) but still well-encapsulated. Adding a new CLI tool plugin is the same as Alt A. The actor model is highly extensible for per-pane features (new per-pane actor types) but slightly less so for cross-cutting sinks.

**Alt C: Pipeline/Middleware — 3/5**

Adding a new cross-cutting concern (a new logging stage, a new enrichment step) is trivial — insert a middleware. However, adding a new notification sink is more invasive: the `notification` middleware must be modified to call the new sink, or the `Sink` interface must be extended, and the new sink registered at pipeline construction. This is not difficult but requires touching the pipeline assembly code (in `app.ts`) and potentially the notification middleware, meaning new sinks are not as cleanly additive as in Alt A. New event types also require new pipeline compositions to be explicitly defined.

---

### 2.10 Debugging / Observability

**Alt A: Event-Driven — 3/5**

When a bug occurs, the developer must determine: which events were emitted, which subscribers received them, and what each subscriber did. With structured logging, this is achievable but requires correlating log lines from multiple packages using event timestamps and pane IDs. The implicit control flow means there is no single "call stack" to inspect. Adding an event trace log (logging every `bus.emit()` call with its event payload) significantly improves this, but it is extra infrastructure the team must build and maintain.

**Alt B: Actor-Model — 2/5**

Inspecting the state of a running actor requires sending it an explicit "dump state" message and waiting for the response. There is no synchronous way to inspect actor state from outside the actor, which makes interactive debugging harder. Message flows between actors are not automatically logged — each actor must log its own received messages. When a bug spans multiple actors (e.g., a `PaneAwaitingInput` from a `PaneActor` that the `OrchestratorActor` somehow dropped), reconstructing the sequence requires correlating logs across actor boundaries. Profiling tools and heap analyzers work at the JS level, not the actor abstraction level.

**Alt C: Pipeline/Middleware — 5/5**

The pipeline model is intrinsically observable. A single `logger` middleware at the start and end of the chain captures the full `EventContext` before and after processing. The sequential, synchronous-within-a-chain execution means the processing of any event can be reproduced by replaying the event through the pipeline with a debug middleware inserted at any position. The middleware stack itself is the documentation of the processing path. Adding an interactive "trace mode" (log every middleware entry/exit with context diff) requires inserting a single debug middleware. This is the strongest observability story of the three alternatives.

---

## 3. Recommendation

### 3.1 Recommended Alternative: C (Pipeline/Middleware)

**Alternative C is recommended for v1 implementation of Sirko.**

This recommendation diverges from the `alternatives.md` document's stated preference for Alternative A. The rationale follows.

#### Primary Justification

**Debuggability and observability are the most underweighted factors in the alternatives document's recommendation.** Sirko is a personal productivity tool that will be operated by a developer who also built it. The single most common activity during and after development will be answering the question: "Why did (or did not) the system detect that pane %3 was waiting for input?" The pipeline model provides a direct, unambiguous answer: add a logger middleware between detection and dedup, replay the event, and read the context diff. The event-driven model provides a weaker answer: search structured logs across multiple packages and reconstruct the emission sequence.

**The v1 speed advantage of Alternative C is material.** The `compose()` utility is faster to write correctly than even a typed event bus wrapper, because the pipeline pattern has no shared-singleton concerns and no subscription lifecycle management. The incremental assembly approach (add middleware one at a time, confirm behavior at each step) directly matches how a developer builds a new system.

**The quiescence detection "awkwardness" is overstated.** Both the alternatives document and the pipeline's own cons section flag quiescence scheduling as a weakness of Alt C. However, the recommended mitigation — a `setInterval` that polls pane state and directly updates `StateStore` without injecting synthetic events — is clean in practice. The quiescence timer is the one detection signal that is inherently time-driven rather than event-driven; treating it as an external scheduler rather than a pipeline event is architecturally honest, not a workaround.

**The extensibility gap is acceptable for v1 scope.** Alternative A scores higher on extensibility (5 vs. 3), but the v1 extensibility requirements are well-bounded: the system needs exactly the sinks described in the requirements (Telegram, Voice/Twilio, Voice/LiveKit). The plugin system for CLI tools is a static config registry in all three alternatives. Adding a hypothetical future Slack sink requires modifying the notification middleware and the pipeline assembly — two files, not zero, but not a significant burden.

#### Secondary Factors

- The `SideEffect[]` pattern in the pipeline enables dry-run testing of the notification path, which directly supports calibrating the detection thresholds (ASM-07 notes empirical calibration is required).
- The single structured-log entry per event (pre/post pipeline) satisfies NFR-MAINT-03 with minimal additional instrumentation.
- The 50-line `compose()` implementation has no custom maintenance burden, unlike Alternative B's actor runtime.

---

### 3.2 Elements to Incorporate from Non-Selected Alternatives

#### From Alternative A (Event-Driven)

**Typed event contracts as a design exercise.** The `SirkoEvent` discriminated union defined in Alt A's `event-bus` package should be adopted in Alt C as the type definitions for `TmuxEvent` and the context fields in `EventContext`. Even though events are not broadcast on a bus, defining them as a typed union makes the pipeline's inputs and outputs explicit and prevents the `EventContext` from becoming an untyped grab-bag.

**Clear separation of output streaming from notification.** Alt A's architecture explicitly models pane output streaming to Telegram as a separate concern from the await-input notification path (separate subscriptions). Alt C should enforce the same separation in the sink interface: `TelegramSink.onPaneOutput()` (called from the pipeline for every output event) and `TelegramSink.onPaneAwaitingInput()` (called from the notification middleware) are distinct methods serving distinct purposes and should be independently rate-limited.

**Decoupled sink testing with a fake bus.** The principle of testing sinks against a contract without requiring a real tmux connection is equally applicable in Alt C. Implement sink tests that call `sink.onPaneOutput()` directly with synthetic context, independent of the pipeline. This is actually slightly easier in Alt C because sinks are plain objects implementing the `Sink` interface, not event subscribers that require a bus instance.

#### From Alternative B (Actor-Model)

**Per-pane encapsulation of xterm state.** Alt B's `PaneActor` owns its `@xterm/headless` instance privately. In Alt C, the `middleware/xterm` middleware must look up or maintain per-pane xterm instances. Adopt Alt B's pattern of storing the `@xterm/headless` instance keyed by pane ID inside `StateStore` (as part of `PaneState`), ensuring that each pane's terminal state is fully isolated and garbage-collected when the pane exits.

**Supervision-style error recovery for sinks.** Alt B defines maximum-restart policies for actors that crash. In Alt C, sinks hold long-lived connections (grammY polling loop, Twilio WebSocket). Adopt the same principle: each sink should have an internal restart policy with exponential backoff (satisfying NFR-REL-01 and NFR-REL-02). The pipeline should not crash if a sink's `onPaneOutput()` throws; instead, the notification middleware should catch sink errors and log them as structured error events (satisfying NFR-REL-04's graceful fallback requirement).

**State snapshot versioning.** Alt B's `state-persistence` package includes schema versioning for actor state snapshots. Adopt this for Alt C's `state-store` disk persistence: include a `schemaVersion` field in the persisted JSON so that future deployments can migrate stale state files rather than silently discarding them. This directly addresses NFR-REL-03 (state recovery after restart).

---

### 3.3 Key Risks of the Recommended Approach and Mitigations

#### Risk 1: EventContext grows into a "god object"

**Severity**: Medium
**Likelihood**: High (confirmed in alternatives.md risk table)

As development progresses, middleware authors will be tempted to attach additional fields to `EventContext` for convenience, making the shared context increasingly hard to audit. Over time, it becomes unclear which middleware "owns" which fields and whether downstream middleware can depend on them being populated.

**Mitigation**: Define `EventContext` as a strict TypeScript type with clearly delineated sections, and enforce that each middleware only accesses fields documented in its contract. Use TypeScript's `Readonly<>` pattern where possible to prevent accidental mutation. Consider per-event-type context types (a `PaneOutputContext` that extends the base context with `parsedText: string` guaranteed rather than optional) to eliminate the class of bug where a middleware accesses a field that was never populated for the current event type. Code review policy: any PR adding a field to `EventContext` must include documentation of which middleware populates it and which consumes it.

#### Risk 2: Middleware ordering bugs cause missed or duplicate notifications

**Severity**: High
**Likelihood**: Medium (confirmed in alternatives.md risk table)

If `dedupMiddleware` is accidentally placed before `detectionMiddleware` in the composition order, notifications will be silently suppressed even for new await-input cycles. If `notificationMiddleware` is placed before `stateManagerMiddleware` persists the updated `notificationState`, a process restart could re-send the same notification.

**Mitigation**: Encode the canonical middleware ordering as a named constant in `app.ts` with inline comments explaining the dependency relationships between adjacent middleware. Write integration tests that execute the full pipeline with a known sequence of events (output burst, silence, notification, user reply, next output burst) and assert on the exact set of side effects, catching any regression if ordering changes. Add a startup-time validator that checks the composed pipeline against a required-ordering contract (e.g., assert that the index of `dedupMiddleware` is always greater than the index of `detectionMiddleware`).

#### Risk 3: Quiescence detection via `setInterval` diverges from pipeline state

**Severity**: Medium
**Likelihood**: Medium

The `setInterval` scheduler runs on a wall-clock cadence independent of the pipeline. If the pipeline is processing a large burst of output events while the interval fires, the scheduler may read stale `lastOutputTime` from `StateStore` and trigger a false-positive quiescence detection while output is actively being processed.

**Mitigation**: The scheduler should read `lastOutputTime` from `StateStore` at the point of the interval callback, not from a cached copy. Add a `processingCount` counter to `StateStore` that the pipeline increments on entry and decrements on exit; the quiescence scheduler should skip firing for any pane where `processingCount > 0`. Document this as a required field in `PaneState` to ensure it is preserved across restarts. Alternatively, run the quiescence check as the first thing inside a `QuiescenceCheck` synthetic event that is processed by the pipeline in order, serializing it with other events for that pane.

#### Risk 4: Silent sink failures (Telegram/Voice API errors)

**Severity**: High
**Likelihood**: Medium

If the Telegram API returns a rate limit error or the ElevenLabs TTS endpoint is temporarily unavailable, the notification middleware's call to `sink.onPaneAwaitingInput()` will throw. Without explicit error handling, this will either crash the pipeline execution for that event or be silently swallowed by an outer try/catch, and the user will not be notified.

**Mitigation**: The notification middleware must catch errors from each sink call independently (not with a single `Promise.all()` that aborts on first error, but with `Promise.allSettled()`). Each failed sink call must emit a structured error log with pane ID, sink name, and error details. Each sink must implement internal retry logic with exponential backoff for transient errors (rate limits, 5xx responses). The Telegram sink's rate limiter queue (required by FR-TG-09 and CON-API-03) provides natural buffering against rate limit errors. Define a "sink health" status in `StateStore` and emit an alert via the still-healthy sink if a companion sink fails persistently (satisfying NFR-REL-04's requirement to notify via Telegram when voice is unavailable).

#### Risk 5: User reply path bypasses pipeline, creating state consistency risk

**Severity**: Medium
**Likelihood**: Low

The alternatives document explicitly notes that the user reply path in Alt C bypasses the pipeline: when a Telegram message arrives, the `TelegramSink` directly calls `stateStore.setPaneNotificationState(paneId, 'idle')` and `voiceSink.cancelPendingNotification()`. If this direct state mutation races with a pipeline execution for the same pane (processing the last output event before quiescence), the notification dedup state could be inconsistent.

**Mitigation**: Use Bun's single-threaded event loop to your advantage: because all JavaScript in Bun runs on a single thread, a synchronous state mutation in the Telegram callback and a synchronous state read in the pipeline middleware cannot truly race — they will execute in serial. Document this assumption explicitly. The `stateStore.setPaneNotificationState()` call must be synchronous (no `await`), ensuring it is atomic within the event loop turn. Add an assertion in the dedup middleware that logs a warning if `notificationState` is `'idle'` when it expected `'notified'`, as this would indicate a sequencing bug.

#### Risk 6: @xterm/headless Bun compatibility

**Severity**: High
**Likelihood**: Medium (shared with all alternatives; noted in Alt A risk table)

This risk is not specific to Alt C but affects all three alternatives equally. The `@xterm/headless` package is built for Node.js and may have incompatibilities with Bun's runtime (e.g., use of Node-specific APIs, native addons, or incompatible `process` assumptions).

**Mitigation**: This should be the first integration test written, before any pipeline or architecture work. If `@xterm/headless` fails, implement a minimal ANSI/VT state machine using `ansi-escapes` + `strip-ansi` as a drop-in replacement for the xterm middleware. The xterm middleware's interface (`(rawOutput: string) => { text: string; cursorState: CursorState }`) should be abstracted behind a `TerminalEmulator` interface so the underlying library can be swapped without changing the middleware.

---

## 4. Summary Scorecard

| Factor | Alt A | Alt B | Alt C |
|---|:---:|:---:|:---:|
| Best for v1 speed | | | X |
| Best for long-term scale | | X | |
| Best observability | | | X |
| Best testability | | | X |
| Best for extensibility | X | | |
| Least custom infrastructure | X | | |
| Best state isolation | | X | |
| Recommended for Sirko v1 | | | **X** |

The recommendation of Alternative C reflects the judgment that Sirko's most operationally critical property during its development and early deployment phase is the ability to quickly diagnose why a detection decision was or was not made. The pipeline model provides this at the lowest implementation cost. The extensibility gap relative to Alternative A is real but bounded by the v1 requirements. The reliability and state-isolation advantages of Alternative B are genuine but represent over-engineering at the declared scale of ≤10 panes on a single host.

---

*End of trade-off analysis.*
