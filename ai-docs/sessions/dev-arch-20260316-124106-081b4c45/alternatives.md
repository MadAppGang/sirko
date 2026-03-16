# Sirko — Architecture Alternatives

**Session**: dev-arch-20260316-124106-081b4c45
**Date**: 2026-03-16
**Status**: Draft

---

## Shared Baseline

All three alternatives share the following non-negotiable stack constraints derived from the requirements:

- **Runtime**: Bun (TypeScript strict)
- **Monorepo**: Turborepo + Bun workspaces
- **Telegram**: grammY framework
- **Terminal emulation**: `@xterm/headless`
- **STT**: Deepgram
- **TTS**: ElevenLabs
- **Voice MVP**: Twilio Programmable Voice + Media Streams
- **Voice production**: LiveKit Agents SDK
- **Frontend** (optional dashboard): React + TanStack Query + TanStack Router
- **Database** (optional persistence): Neon serverless Postgres
- **LLM framework**: Evaluated per alternative (Vercel AI SDK vs. LangChain.js vs. AI SDK Core direct)

The alternatives differ in **how the internal system is structured**: how events flow, how state is managed, how components communicate, and how the detection/notification pipeline is organized.

---

## LLM Framework Evaluation

Before presenting the alternatives, the LLM framework decision is evaluated because it cuts across all three.

### Vercel AI SDK (ai package)

Pros:
- First-class Bun/edge compatibility; designed for non-Node runtimes
- Provider-agnostic via a unified `generateText` / `streamText` / `generateObject` API
- Built-in streaming primitives that align with voice pipeline needs (stream text chunks to TTS)
- Strong TypeScript types and inference
- Active development, wide provider coverage (OpenAI, Anthropic, Google, Mistral, Groq, etc.)
- Lightweight — no graph/chain overhead when not needed

Cons:
- Primarily designed for text generation; does not include STT/TTS orchestration primitives natively
- No built-in agent/tool-loop framework (must be assembled manually or via `useChat`/`useCompletion` on the client side)
- Less opinionated about multi-step pipelines

### LangChain.js

Pros:
- Full chain/agent abstraction including tool loops
- Broader ecosystem of integrations (retrievers, memory, chains)
- Explicit pipeline composition model

Cons:
- Heavier, more abstraction overhead than needed for a focused system
- Node.js heritage — Bun compatibility has had historical rough edges
- More complex dependency tree; harder to audit
- Abstractions can obscure control flow, making low-latency tuning harder

### Recommendation (applies to all alternatives)

**Use Vercel AI SDK** (`ai` package) for LLM calls. The Sirko use case is focused: summarize terminal context for voice readout, optionally route/classify intent. It does not need LangChain's chain/retriever ecosystem. The AI SDK's streaming primitives align naturally with the real-time voice pipeline. STT (Deepgram) and TTS (ElevenLabs) are accessed via their native SDKs (not through any LLM framework), which the AI SDK does not try to replace.

---

## Alternative A: Event-Driven / Reactive Architecture

### 1. Overview and Philosophy

The system is structured around a central **event bus**. Every significant occurrence — tmux output, pane state change, detection signal, user message, voice event — is represented as a typed event emitted onto the bus. Consumers subscribe to event types and react independently. The orchestrator is a thin coordinator that routes events and maintains a small in-memory state registry; it does not contain business logic.

This is the "thin pipes, smart endpoints" approach. Each component is decoupled from all others except through the shared event contract. Adding a new notification channel means subscribing to `PaneAwaitingInput` events without touching existing code.

```
tmux control-mode stream
         |
         v
  +----------------+
  |  TmuxClient    |  Parses protocol, spawns typed events
  +----------------+
         |
         v  (typed events: PaneOutput, PaneExited, ...)
  +----------------+
  |   Event Bus    |  In-process EventEmitter, typed with TypeScript generics
  +----------------+
    |     |     |
    v     v     v
+--------+ +----------+ +-----------+
|Detector| |StateStore| |OutputLogger|
+--------+ +----------+ +-----------+
    |
    v  (PaneAwaitingInput event)
  +----------------+
  |   Event Bus    |
  +----------------+
    |           |
    v           v
+--------+  +--------+
|TgSink  |  |VoiceSink|
+--------+  +--------+
```

### 2. Monorepo Package Structure

```
sirko/
  packages/
    tmux-client/          # tmux control-mode protocol parser and connection manager
    event-bus/            # Typed event bus, event type definitions, subscription helpers
    detector/             # Input-detection engine (quiescence, wchan, prompt pattern signals)
    tool-plugins/         # Per-CLI-tool plugin registry (Claude, Codex, Aider configs)
    orchestrator/         # State registry, notification dedup, event routing coordinator
    state-store/          # In-memory + disk-persistent pane/session state
    telegram-adapter/     # grammY bot, topic management, message formatting, rate limiter
    voice-adapter/        # Voice pipeline abstraction; Twilio + LiveKit transport adapters
    voice-pipeline/       # STT (Deepgram) + LLM (AI SDK) + TTS (ElevenLabs) shared logic
    output-logger/        # Durable per-session pane output logging to disk
    app/                  # Main entry point; wires all packages together
    web/                  # (optional) React dashboard using TanStack Query/Router
  apps/
    sirko/                # Alias for app/ if Turborepo apps/ convention is preferred
  turbo.json
  package.json
  tsconfig.base.json
```

**Package responsibilities:**

| Package | Responsibility |
|---|---|
| `tmux-client` | Spawn/attach tmux in control mode, parse `%output`/`%begin`/`%end`/`%pane-exited` etc., emit typed events |
| `event-bus` | Typed `EventEmitter` wrapper; defines all event type contracts as TypeScript discriminated unions |
| `detector` | Subscribes to `PaneOutput` and `PaneStateChange` events; computes weighted confidence score; emits `PaneAwaitingInput` when threshold crossed |
| `tool-plugins` | Static registry of tool configs (name, binary, prompt regexes, weight overrides); loaded by `detector` |
| `orchestrator` | Subscribes to `PaneAwaitingInput`; manages notification dedup state; fans out to registered sinks; handles `InputDelivered` to reset dedup |
| `state-store` | Subscribes to state-changing events; maintains in-memory pane registry; persists to disk (JSON); recovers on start |
| `telegram-adapter` | Subscribes to `PaneOutput` and `PaneAwaitingInput`; implements grammY bot; rate-limiter queue; topic lifecycle management |
| `voice-adapter` | Subscribes to `PaneAwaitingInput`; initiates outbound calls via Twilio or LiveKit; delegates to `voice-pipeline` |
| `voice-pipeline` | Stateless pipeline functions: `transcribe(audio): text`, `synthesize(text): audio`, `summarize(context): text` using AI SDK + Deepgram + ElevenLabs |
| `output-logger` | Subscribes to `PaneOutput`; appends to per-session log files |
| `app` | Instantiates all packages, connects them to the bus, starts listeners |

### 3. Component Architecture within Key Packages

#### event-bus

```typescript
// Event type union (illustrative, not implementation)
type SirkoEvent =
  | { type: 'PaneOutput'; paneId: string; sessionId: string; raw: string; text: string; timestamp: number }
  | { type: 'PaneExited'; paneId: string; sessionId: string }
  | { type: 'PaneAwaitingInput'; paneId: string; sessionId: string; tool: string; confidence: number; context: string }
  | { type: 'InputDelivered'; paneId: string; sessionId: string; source: 'telegram' | 'voice' }
  | { type: 'SessionCreated'; sessionId: string }
  | { type: 'SessionClosed'; sessionId: string }
  | { type: 'VoiceCallStarted'; paneId: string; callSid: string }
  | { type: 'VoiceCallEnded'; paneId: string }

// Typed bus interface
interface EventBus {
  emit<T extends SirkoEvent>(event: T): void
  on<T extends SirkoEvent['type']>(type: T, handler: (event: Extract<SirkoEvent, { type: T }>) => void): () => void
}
```

The bus is a singleton per process. It wraps Node/Bun's native `EventEmitter` with typed overloads.

#### detector

Three signal computers run concurrently per pane:

```
PaneOutput events
       |
       +-----> QuiescenceSignal (timer-based, reset on each output)
       |
       +-----> PromptPatternSignal (regex match on xterm buffer snapshot)
       |
PaneStateChange
       |
       +-----> WchanSignal (spawns /proc read or ps invocation)

All three --> ScoreAggregator --> threshold check --> PaneAwaitingInput event
```

Each signal is an independent class with `getScore(paneId): Promise<number>` interface. The aggregator polls or reacts to score updates, applies weights from `tool-plugins`, and emits when the weighted sum exceeds the configured threshold.

#### orchestrator

Minimal state: a `Map<paneId, NotificationState>` where `NotificationState` is `'idle' | 'notified' | 'input-delivered'`. On `PaneAwaitingInput`, if state is `'idle'`, set to `'notified'` and fan out. On `InputDelivered`, reset to `'idle'`. The orchestrator itself holds no output data; everything flows through the bus.

### 4. Data Flow

```
tmux process
  |
  | (stdio — control-mode text stream)
  v
TmuxClient
  | parses protocol lines, runs text through @xterm/headless
  | emits: PaneOutput, PaneExited, SessionCreated, ...
  v
EventBus
  |--- detector subscribes to PaneOutput
  |       | (timer + regex + wchan)
  |       | emits: PaneAwaitingInput
  |       v EventBus
  |           |--- orchestrator subscribes to PaneAwaitingInput
  |           |       | checks dedup state
  |           |       | emits: NotifyTelegram, NotifyVoice
  |           |       v EventBus
  |           |           |--- telegram-adapter subscribes, formats + sends message
  |           |           |--- voice-adapter subscribes, initiates call
  |
  |--- state-store subscribes to all state events, persists
  |--- output-logger subscribes to PaneOutput, writes to disk
  |--- telegram-adapter subscribes to PaneOutput, streams to topic
```

When the user replies via Telegram:
```
grammY receives message
  -> telegram-adapter emits InputDelivered + routes text to TmuxClient.sendInput()
  -> TmuxClient sends keys to pane
  -> orchestrator receives InputDelivered, resets dedup state
  -> voice-adapter receives InputDelivered, cancels pending call if any
```

### 5. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| LLM framework | Vercel AI SDK | See shared evaluation above |
| Event bus | Native Bun `EventEmitter` wrapped with typed bus | Zero dependency, in-process, sufficient for single-host system |
| State persistence | JSON files on POSIX filesystem | Simplest durable store; no DB needed for v1 state recovery |
| Database | Neon (optional) | Only if audit log queries become needed; not required for v1 |
| Voice transport abstraction | Strategy pattern in `voice-adapter` | `TwilioTransport` and `LiveKitTransport` both implement `VoiceTransport` interface |

### 6. Pros and Cons

**Pros:**
- Highly decoupled: each package can be tested in isolation by mocking the event bus
- Easy to add new sinks (e.g., a Slack adapter, a webhook adapter) without touching existing code
- Event history can be replayed for debugging or testing
- Natural fit for the reactive nature of the problem (the system is fundamentally event-driven — tmux emits events)
- Clear audit trail: every significant action is a typed event that can be logged

**Cons:**
- Implicit control flow: tracing what happens for a given input requires following subscriptions across packages — less readable than a direct call chain
- Error handling is diffuse: a handler that throws doesn't propagate back to the emitter; requires per-handler try/catch discipline
- Ordering guarantees: if two subscribers both react to `PaneAwaitingInput`, execution order is not guaranteed without explicit sequencing
- Testing end-to-end flows requires asserting on bus emissions rather than return values, which can be verbose
- The bus becomes a critical shared dependency; changes to event shapes require updating all subscribers

### 7. Estimated Complexity

| Component | Complexity | Notes |
|---|---|---|
| `tmux-client` | High | Protocol parsing, reconnection logic, @xterm/headless integration |
| `event-bus` | Low | Thin typed wrapper over EventEmitter |
| `detector` | Medium-High | Three signals, weighted aggregation, per-pane timer management |
| `tool-plugins` | Low | Static config objects with well-defined schema |
| `orchestrator` | Low | Thin dedup state machine |
| `state-store` | Medium | In-memory + disk persistence with recovery |
| `telegram-adapter` | Medium | Rate limiting, topic lifecycle, message formatting, grammY setup |
| `voice-pipeline` | Medium | Streaming audio pipeline with latency targets |
| `voice-adapter` (Twilio) | Medium | WebSocket media stream, μ-law PCM handling |
| `voice-adapter` (LiveKit) | Medium | LiveKit Agents SDK integration |
| `output-logger` | Low | File append with rotation |
| `app` (wiring) | Low | Dependency injection / manual wiring |

### 8. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Event ordering bugs (notification fires twice) | Medium | Medium | Orchestrator dedup state machine; event bus emit is synchronous in-process |
| Diffuse error handling leads to silent failures | High | Medium | Mandatory error wrapper on all `bus.on()` subscriptions; structured error events |
| @xterm/headless Bun compatibility | High | Medium | Test early; fallback to `ansi-escapes` + manual VT state machine |
| Vercel AI SDK streaming not compatible with Bun's fetch implementation | Medium | Low | AI SDK uses standard `ReadableStream`; Bun has native support |
| tmux reconnect during active notification flood | Medium | Low | Reconnect logic in `tmux-client` is isolated; bus subscribers simply receive no events until reconnected |
| Disk I/O contention on high-volume pane output | Low | Low | Output logger is append-only; OS buffering handles bursty writes |

---

## Alternative B: Actor-Model / Message-Passing Architecture

### 1. Overview and Philosophy

Each managed entity — every tmux pane, the Telegram bot, the voice interface — is represented as an **actor**: an independent unit of state and behavior that communicates exclusively via message passing. There is no shared mutable state; actors hold their own state internally and expose it only through messages.

This maps naturally to the domain: a pane IS an actor. It receives messages (output arrives, input is requested, it exits) and sends messages (I am awaiting input, send this to Telegram). The orchestrator becomes a supervisor actor that manages the lifecycle of child pane actors and routes inter-actor messages.

Rather than implementing a full actor framework (which would be heavyweight), this alternative uses a lightweight `WorkerActor` abstraction built on Bun `Worker` threads for CPU-bound actors (e.g., the detector per pane) and an in-process actor pattern (mailbox queue + async message loop) for I/O-bound actors.

```
                    +------------------+
                    |  Orchestrator    |  (supervisor actor)
                    |  Actor           |
                    +------------------+
                      |     |     |
             spawn    |     |     |    spawn
          +-----------+     |     +-----------+
          |                 | spawn             |
          v                 v                   v
   +------------+   +------------+   +------------------+
   | PaneActor  |   | PaneActor  |   | TelegramActor    |
   | (%0)       |   | (%1)       |   |                  |
   +------------+   +------------+   +------------------+
          |                 |                   |
   +------+         +-------+         +---------+
   |                |                 |
   v                v                 v
DetectorActor  DetectorActor    VoiceActor
(per pane)     (per pane)
```

Each actor has:
- A private mailbox (async queue)
- An internal `state` object (immutable pattern recommended)
- A `receive(message)` async method that processes one message at a time

### 2. Monorepo Package Structure

```
sirko/
  packages/
    actor-runtime/        # Actor base class, mailbox, message dispatch, supervision tree
    tmux-client/          # tmux protocol parser; runs as a managed actor
    pane-actor/           # PaneActor: per-pane state machine, owns xterm instance
    detector-actor/       # DetectorActor: per-pane detection logic as a child actor of PaneActor
    tool-plugins/         # Tool plugin registry (same as Alternative A)
    orchestrator-actor/   # Supervisor: spawns/terminates PaneActors, routes cross-actor messages
    telegram-actor/       # TelegramActor: grammY bot as a long-running actor
    voice-actor/          # VoiceActor: voice pipeline lifecycle management
    voice-pipeline/       # Stateless pipeline (STT + LLM + TTS); same as Alternative A
    state-persistence/    # Snapshot + restore of actor state trees to disk
    output-logger/        # Logging actor (subscribes to pane output messages)
    app/                  # Bootstraps actor system, starts supervision tree
    web/                  # Optional React dashboard
  turbo.json
  package.json
  tsconfig.base.json
```

**Package responsibilities:**

| Package | Responsibility |
|---|---|
| `actor-runtime` | Base `Actor<State, Message>` class; async mailbox using `AsyncQueue`; `ActorRef` handle type for sending messages; supervision strategies (restart/stop on crash) |
| `tmux-client` | Wraps tmux stdio as a stream; runs inside or alongside `OrchestratorActor`; delivers `TmuxEvent` messages to orchestrator |
| `pane-actor` | One instance per managed pane; owns `@xterm/headless` instance; manages pane state machine (`running / awaiting-input / idle / exited`); holds `DetectorActorRef` |
| `detector-actor` | Child of `PaneActor`; runs detection signals; sends `ConfidenceUpdate` messages back to parent `PaneActor` which decides to escalate to orchestrator |
| `orchestrator-actor` | Supervision tree root; maps `paneId -> PaneActorRef`; receives `PaneAwaitingInput` from pane actors; routes to `TelegramActor` and `VoiceActor` |
| `telegram-actor` | Long-running actor; grammY bot loop inside `receive()`; incoming Telegram messages become `TelegramMessage` messages to orchestrator; maintains topic map state |
| `voice-actor` | Manages voice call lifecycle; receives `PlaceCall` messages; handles Twilio/LiveKit events |
| `voice-pipeline` | Stateless functions; same as Alternative A |
| `state-persistence` | Serializes and restores actor state snapshots to disk on shutdown/startup |
| `output-logger` | Receives `PaneOutput` messages forwarded by pane actors; writes to log files |

### 3. Component Architecture within Key Packages

#### actor-runtime

```
Actor<State, Message>
  - state: State  (private, immutable-by-convention)
  - mailbox: AsyncQueue<Message>
  - async start(): void  -- starts the message loop
  - async receive(msg: Message): State  -- override this; returns new state
  - send(ref: ActorRef, msg): void  -- puts msg in target's mailbox
  - self: ActorRef  -- reference to this actor

ActorRef<Message>
  - send(msg: Message): void  -- async, non-blocking

AsyncQueue<T>
  - enqueue(item: T): void
  - dequeue(): Promise<T>  -- waits if empty
```

The message loop:
```
while (running) {
  const msg = await this.mailbox.dequeue()
  try {
    this.state = await this.receive(msg)
  } catch (err) {
    supervisor.reportCrash(this, err)
  }
}
```

#### pane-actor

State machine embedded in the actor's `receive()` method:

```
Messages IN:
  TmuxOutput { raw: string }       -> feed to xterm, forward to TelegramActor, append to log
  ConfidenceUpdate { score, tool }  -> check threshold; if crossed: send PaneAwaitingInput to orchestrator
  SendInput { text: string }        -> send to TmuxClient, reset confidence state
  PaneExited                        -> transition to exited state, notify orchestrator

Messages OUT (to OrchestratorActor):
  PaneAwaitingInput { paneId, sessionId, tool, confidence, context }
  PaneResumed { paneId }
  PaneExited { paneId }
```

#### orchestrator-actor

```
Messages IN:
  TmuxEvent (from tmux-client)         -> create/destroy PaneActors as needed
  PaneAwaitingInput (from PaneActor)   -> dedup check; forward to TelegramActor + VoiceActor
  InputDelivered (from TelegramActor)  -> send SendInput to PaneActor; cancel voice if pending
  TelegramMessage (from TelegramActor) -> route to appropriate PaneActor

State:
  panes: Map<paneId, PaneActorRef>
  notificationState: Map<paneId, 'idle' | 'notified'>
  topicMap: Map<paneId, topicId>  (persisted via state-persistence)
```

### 4. Data Flow

```
tmux stdio stream
  |
  | raw control-mode lines
  v
TmuxClientStream (inside OrchestratorActor or a sibling)
  | parses lines into TmuxEvent structs
  v
OrchestratorActor.receive(TmuxEvent)
  | on new pane: spawn PaneActor, register in map
  | on output: forward TmuxOutput message to correct PaneActor
  v
PaneActor.receive(TmuxOutput)
  | update xterm buffer
  | forward PaneOutput message to: OutputLoggerActor, TelegramActor
  | forward raw/text to DetectorActor
  v
DetectorActor.receive(PaneOutput)
  | runs quiescence timer, prompt regex, wchan check
  | sends ConfidenceUpdate back to PaneActor
  v
PaneActor.receive(ConfidenceUpdate)
  | if score > threshold:
  |   send PaneAwaitingInput to OrchestratorActor
  v
OrchestratorActor.receive(PaneAwaitingInput)
  | dedup check: if notificationState == 'idle':
  |   set 'notified'
  |   send NotifyUser to TelegramActor
  |   send PlaceCall to VoiceActor
  v
TelegramActor / VoiceActor act independently
```

Reply path:
```
Telegram user sends message
  -> TelegramActor.grammY handler -> enqueue TelegramIncoming to TelegramActor mailbox
  -> TelegramActor.receive(TelegramIncoming)
  -> send InputDelivered to OrchestratorActor (with text)
  -> OrchestratorActor routes: send SendInput to PaneActor, send CancelCall to VoiceActor
  -> PaneActor sends text to TmuxClient
```

### 5. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| LLM framework | Vercel AI SDK | Same rationale as Alternative A |
| Actor runtime | Custom lightweight (no heavy framework) | Full actor frameworks (e.g., Akka port) are overkill; a 200-line `Actor` base class suffices |
| Concurrency | In-process async mailboxes (no Workers) | Bun Workers have overhead and IPC serialization cost; for I/O-bound work, async mailboxes give actor isolation without thread overhead |
| State persistence | JSON snapshots of actor state on graceful shutdown | Each actor serializes its state; `state-persistence` package handles versioning |
| Database | Neon (optional) | Same as Alternative A |

### 6. Pros and Cons

**Pros:**
- Excellent encapsulation: each pane's state is fully owned by its actor; no shared mutable state bugs
- Natural process/failure boundary: if a PaneActor crashes, the supervisor restarts it without affecting other panes
- The domain maps well to the model (a pane IS an actor)
- Predictable message ordering within each actor (mailbox is FIFO)
- Clear place to add per-pane features (rate limiting, retry logic) without affecting global state
- Scales horizontally in concept (even if single-host for v1)

**Cons:**
- Custom actor runtime introduces a non-trivial dependency that must be maintained
- Message passing overhead: every pane output event is a message enqueue/dequeue vs. a direct function call
- Debugging is harder: inspecting actor state requires explicit state-dump messages or an inspector
- More boilerplate than the event-driven approach: every interaction is formalized as a typed message
- The actor system adds indirection; developers unfamiliar with the model face a steeper learning curve
- Supervision tree design requires upfront thought; incorrect supervision strategies lead to cascading restarts

### 7. Estimated Complexity

| Component | Complexity | Notes |
|---|---|---|
| `actor-runtime` | Medium | Custom but scoped; roughly 200-400 lines |
| `tmux-client` | High | Same as Alternative A |
| `pane-actor` | Medium | State machine is clear; messaging overhead minimal |
| `detector-actor` | Medium | Same signals as A; expressed as messages instead of callbacks |
| `orchestrator-actor` | Medium | Supervision logic adds complexity vs. A's thin orchestrator |
| `telegram-actor` | Medium | grammY needs to funnel into mailbox; non-trivial adapter |
| `voice-actor` | Medium | Same as A |
| `voice-pipeline` | Medium | Same as A |
| `state-persistence` | Medium | Serializing actor state trees requires careful schema versioning |
| `app` | Low | Start supervisor tree; everything else is self-managing |

### 8. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Custom actor runtime bugs (deadlock, starvation) | High | Medium | Keep runtime minimal; thorough unit tests; add watchdog timers |
| grammY's callback-based API impedance mismatch with actor mailbox | Medium | Medium | Wrap grammY handlers to enqueue messages; tested adapter pattern |
| Supervision restart loops on transient errors | Medium | Low | Use `max-restart` policy; escalate to process exit if exceeded |
| Actor state serialization version skew on restart | Medium | Medium | Schema versioning in `state-persistence`; migration strategy |
| Performance: mailbox overhead for high-frequency PaneOutput events | Low | Medium | Benchmark with 10 concurrent panes; batch output messages if needed |
| LiveKit SDK event model conflicts with actor mailbox | Low | Low | LiveKit events enqueued into VoiceActor mailbox; standard adapter pattern |

---

## Alternative C: Pipeline / Middleware Architecture

### 1. Overview and Philosophy

Every tmux event passes through an ordered **middleware chain** before reaching its final handlers. This is analogous to an Express/Koa HTTP middleware pipeline, but applied to a stream of tmux events. Each middleware in the chain can inspect, enrich, transform, or short-circuit an event. The pipeline is composable: new behaviors (logging, detection, rate limiting) are added by inserting middleware without modifying existing stages.

The orchestrator is the pipeline runner. It is stateful (holds current pane states) and passes a mutable `context` object through the chain for each event, accumulating enrichments as it progresses.

```
tmux event arrives
       |
       v
+------+------+------+------+------+------+------+
| Auth | Parse| Xterm| Detect| State| Notify| Log |  <- middleware stack
+------+------+------+------+------+------+------+
                                       |
                                    (if awaiting input)
                                       |
                              +--------+--------+
                              |                 |
                        TelegramSink        VoiceSink
```

The pipeline is defined as an ordered array of middleware functions. Each middleware receives an `EventContext` and a `next()` function. It can augment the context and call `next()` to proceed, or return early to halt processing.

This approach prioritizes **legibility of the processing path**: you can read the middleware stack top-to-bottom and understand exactly what happens to every event. It is easy to insert a debugging middleware, a replay middleware, or a filtering middleware at any position.

### 2. Monorepo Package Structure

```
sirko/
  packages/
    tmux-client/          # tmux protocol parser and connection (same role as A/B)
    pipeline/             # Middleware runner, EventContext type, compose() utility
    middleware/           # All middleware implementations as individual modules
      xterm/              # ANSI/VT interpretation middleware
      detection/          # Input detection middleware (signals + aggregation)
      state-manager/      # State mutation middleware; reads/writes pane state
      notification/       # Fan-out middleware; sends to configured sinks
      dedup/              # Deduplication middleware (suppress duplicate notifications)
      logger/             # Structured JSON logging middleware
      output-archiver/    # Durable output logging middleware
    tool-plugins/         # Tool plugin registry (same as A/B)
    sinks/
      telegram/           # TelegramSink: grammY bot + topic management
      voice/              # VoiceSink: Twilio + LiveKit transports
    voice-pipeline/       # STT + LLM + TTS shared logic (same as A/B)
    state-store/          # PaneStateStore: in-memory + persistent state
    app/                  # Main entry point; assembles pipeline, starts tmux client
    web/                  # Optional React dashboard
  turbo.json
  package.json
  tsconfig.base.json
```

**Package responsibilities:**

| Package | Responsibility |
|---|---|
| `tmux-client` | Control-mode connection, protocol parsing, exposes async event iterator |
| `pipeline` | `compose(middlewares)` function; `EventContext` type; `run(event)` method |
| `middleware/xterm` | Feeds raw output into per-pane `@xterm/headless` instance; attaches `context.parsedText` and `context.cursorState` |
| `middleware/detection` | Runs three signals; attaches `context.detectionResult` (score, tool, confidence); sets `context.pane.status = 'awaiting-input'` if threshold crossed |
| `middleware/state-manager` | Reads and writes to `StateStore`; ensures `context.pane` is populated; persists changes after pipeline completes |
| `middleware/dedup` | Checks `context.pane.notificationState`; short-circuits if already notified for this input-wait cycle |
| `middleware/notification` | If `context.detectionResult.awaiting`, fans out to all registered `Sink` instances |
| `middleware/logger` | Emits structured JSON log entry for every event (before and/or after pipeline) |
| `middleware/output-archiver` | Appends pane output to per-session log file |
| `tool-plugins` | Static tool config registry; consumed by `middleware/detection` |
| `sinks/telegram` | `TelegramSink` implementing `Sink` interface; streams output + sends notifications |
| `sinks/voice` | `VoiceSink` implementing `Sink` interface; manages call lifecycle |
| `state-store` | `PaneStateStore`; `Map<paneId, PaneState>` + disk persistence |
| `voice-pipeline` | Same stateless pipeline as A/B |
| `app` | Assembles the middleware stack; wires `TmuxClient` output to `pipeline.run()` |

### 3. Component Architecture within Key Packages

#### pipeline

```typescript
// Core types
interface EventContext {
  event: TmuxEvent           // raw event from tmux-client
  pane: PaneState | null     // populated by state-manager middleware
  parsedText?: string        // populated by xterm middleware
  cursorState?: CursorState  // populated by xterm middleware
  detectionResult?: {
    score: number
    tool: string | null
    awaiting: boolean
  }
  sideEffects: SideEffect[]  // accumulated by middleware, executed after chain
  aborted: boolean           // set by dedup or other short-circuit middleware
}

type Middleware = (ctx: EventContext, next: () => Promise<void>) => Promise<void>

// compose creates a single function from an ordered array of middleware
function compose(middlewares: Middleware[]): (ctx: EventContext) => Promise<void>
```

The pipeline for a `PaneOutput` event:

```
compose([
  loggerMiddleware,        // log event received
  xtermMiddleware,         // parse ANSI, populate ctx.parsedText
  stateManagerMiddleware,  // load pane state into ctx.pane
  outputArchiverMiddleware,// write output to log file
  detectionMiddleware,     // compute detection score
  dedupMiddleware,         // short-circuit if already notified
  notificationMiddleware,  // fan out to sinks if awaiting
  loggerMiddleware,        // log event processed (or use post-hook pattern)
])
```

Different event types use different pipeline compositions:

```typescript
const pipelines = {
  PaneOutput:   compose([logger, xterm, stateMgr, archiver, detect, dedup, notify]),
  PaneExited:   compose([logger, stateMgr, exitNotify]),
  SessionClosed: compose([logger, stateMgr, cleanupSinks]),
}
```

#### middleware/detection

The detection middleware runs three signal checkers. Rather than managing timers globally, the quiescence timer state is stored **in `ctx.pane`** (which is part of `StateStore`). When the middleware runs on a `PaneOutput` event, it resets the quiescence timer timestamp. A separate scheduled task (setInterval) periodically checks all panes' quiescence timestamps and injects synthetic `QuiescenceCheck` events into the pipeline for any pane that has been quiet for longer than the threshold.

```
PaneOutput event -> pipeline
  -> detectionMiddleware:
     - reset quiescence timer in pane state
     - run prompt pattern check on ctx.parsedText
     - run wchan check (async, cached for 500ms)
     - aggregate partial score
     - if partial score already > threshold -> set ctx.detectionResult.awaiting = true

Scheduler (every 500ms):
  -> for each pane where (now - lastOutputTime) > quiescenceThreshold:
     -> inject QuiescenceCheckEvent into pipeline
     -> detectionMiddleware aggregates final score
```

#### sinks/telegram

The `TelegramSink` implements:

```typescript
interface Sink {
  onPaneOutput(paneId: string, text: string): Promise<void>
  onPaneAwaitingInput(event: AwaitingInputEvent): Promise<void>
  onPaneExited(paneId: string): Promise<void>
  onInputDelivered(paneId: string): Promise<void>
  cancelPendingNotification(paneId: string): Promise<void>
}
```

The `notification` middleware calls `sink.onPaneAwaitingInput()` on each registered sink. The `telegram` sink manages topic creation, the rate-limiter queue, and the `sendMessageDraft` streaming updates.

### 4. Data Flow

```
TmuxClient (async generator)
  | yields TmuxEvent objects
  v
app.ts (main event loop)
  | for await (const event of tmuxClient.events()) {
  |   await pipeline.run(buildContext(event))
  | }
  v
Pipeline (per-event)

For PaneOutput event:
  [loggerMiddleware]
      -> log: "PaneOutput received from %3"
  [xtermMiddleware]
      -> feed to xterm, populate ctx.parsedText
  [stateManagerMiddleware]
      -> load PaneState from StateStore -> ctx.pane
  [outputArchiverMiddleware]
      -> append ctx.parsedText to /logs/session-X/pane-3.log
  [detectionMiddleware]
      -> check prompt patterns on ctx.parsedText
      -> check wchan (cached)
      -> reset quiescence timer in ctx.pane
      -> compute partial score -> ctx.detectionResult
  [dedupMiddleware]
      -> if ctx.pane.notificationState == 'notified': ctx.aborted = true; return (skip next)
  [notificationMiddleware]
      -> if ctx.detectionResult.awaiting:
          -> await telegramSink.onPaneAwaitingInput(...)
          -> await voiceSink.onPaneAwaitingInput(...)
          -> ctx.pane.notificationState = 'notified'
  [stateManagerMiddleware post-hook]
      -> persist updated ctx.pane to StateStore
```

User reply path:
```
TelegramSink receives message via grammY
  -> calls tmuxClient.sendInput(paneId, text)
  -> calls stateStore.setPaneNotificationState(paneId, 'idle')
  -> calls voiceSink.cancelPendingNotification(paneId)
```

Note: the user reply path bypasses the pipeline because it is an outbound action (sending input TO the pane), not an inbound tmux event.

### 5. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| LLM framework | Vercel AI SDK | Same rationale as A/B |
| Pipeline pattern | Custom compose() (Koa-style) | ~50 lines; no framework dependency; well-understood pattern |
| State store | In-memory `Map` + disk JSON | Same as A |
| Scheduler for quiescence | `setInterval` + synthetic events | Keeps quiescence detection inside the pipeline model |
| Database | Neon (optional) | Same as A/B |

### 6. Pros and Cons

**Pros:**
- Highly readable: the ordered middleware stack is the system's processing documentation
- Easy to insert cross-cutting concerns (logging, rate limiting, metrics) without touching business logic
- Easy to test individual middleware in isolation with a fake `EventContext`
- Different event types can use different pipeline compositions — explicit specialization
- The `SideEffect[]` accumulation pattern allows middleware to declare effects without executing them, enabling dry-run and testing modes
- Synchronous control flow within a pipeline execution is easy to reason about and debug

**Cons:**
- The `EventContext` object grows large as more middleware attach data to it; risk of unclear ownership
- Cross-event state (e.g., quiescence timing) requires injecting synthetic events or scheduling outside the pipeline, which breaks the clean model
- Middleware ordering bugs (putting dedup before detection, for example) cause subtle failures that are not caught by the type system
- Sinks (Telegram, Voice) are not fully encapsulated actors; they hold their own state (connections, topic maps) outside the pipeline, creating implicit dependencies
- The pipeline is inherently sequential for a single event; parallelism (fan-out to multiple sinks) must be added explicitly with `Promise.all()`
- The model works cleanly for the tmux event stream but feels forced for the user reply path (which is an outbound action, not a pipeline event)

### 7. Estimated Complexity

| Component | Complexity | Notes |
|---|---|---|
| `tmux-client` | High | Same as A/B |
| `pipeline` (runner + compose) | Low | ~50-100 lines of well-understood code |
| `middleware/xterm` | Medium | Same as A/B |
| `middleware/detection` | Medium-High | Quiescence scheduler + pipeline injection adds complexity |
| `middleware/state-manager` | Medium | Must handle pre/post hook pattern for state persistence |
| `middleware/dedup` | Low | Simple state check |
| `middleware/notification` | Low | Fan-out with `Promise.all()` |
| `sinks/telegram` | Medium | Same as A/B |
| `sinks/voice` | Medium | Same as A/B |
| `voice-pipeline` | Medium | Same as A/B |
| `state-store` | Medium | Same as A/B |
| `app` | Low | Pipeline assembly is explicit and readable |

### 8. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Middleware ordering bugs causing missed notifications | High | Medium | Integration tests that assert on output for known input sequences; lint rule to enforce canonical order |
| EventContext growing into a "god object" | Medium | High | Strict typing with required vs. optional fields per event type; consider splitting contexts by event type |
| Quiescence scheduler synthetic event injection feels unnatural | Medium | High | Alternatively, run quiescence as a separate polling process that calls a direct state method, bypassing the pipeline for that signal only |
| Sequential pipeline throughput for high-frequency output events | Low | Medium | Profiling at 10 concurrent panes; async middleware is non-blocking for I/O; xterm parsing is sync but fast |
| Sink state (grammY bot, LiveKit connection) not visible to pipeline | Medium | Low | Sinks expose health/status methods; orchestrator can check before routing |

---

## Comparative Summary

### Architecture Comparison Matrix

```
                         Alt A             Alt B              Alt C
                    Event-Driven      Actor-Model         Pipeline/MW
---------------------------------------------------------------------------
Control flow        Implicit          Message-passing     Explicit / linear
State location      Distributed       Per-actor private   StateStore + ctx
Concurrency model   EventEmitter      Async mailboxes     Async/await chain
Error boundary      Handler-level     Actor supervisor    Middleware try/catch
Extensibility       Add subscriber    Add actor           Add middleware
Debuggability       Trace emissions   Inspect mailboxes   Read middleware stack
Ordering guarantee  None (implicit)   Per-actor FIFO      Pipeline order
Test isolation      Mock bus          Mock actor refs     Mock ctx + next()
Approx. LoC         ~3,500            ~4,500              ~3,000
---------------------------------------------------------------------------
Overall complexity  Medium            Medium-High         Medium-Low
```

### Recommendation

**Alternative A (Event-Driven)** is recommended as the baseline implementation for v1 for the following reasons:

1. **Natural fit**: The problem domain is inherently event-driven. tmux emits events; the orchestrator reacts. Forcing it into actors or a synchronous pipeline introduces abstraction overhead without proportional benefit at the v1 scale (single host, ≤10 panes).

2. **Lowest custom infrastructure**: Alt B requires a custom actor runtime. Alt C requires careful quiescence scheduler integration. Alt A requires only a typed wrapper over a built-in primitive (EventEmitter).

3. **Fastest to initial working state**: The decoupled structure allows packages to be built and tested independently. The Telegram adapter can be built and tested against a fake bus before the detector is complete.

4. **Clear extension path**: Adding a Slack adapter or webhook sink in a future version is a single new subscriber — no changes to existing code.

**Alternative C (Pipeline)** is the recommended fallback if the team prefers explicit, readable control flow over decoupled reactivity. Its main advantage is that the processing pipeline for any event is immediately legible. Its main risk (quiescence scheduler awkwardness) can be mitigated by treating quiescence as an external timer that directly calls state methods rather than injecting synthetic events.

**Alternative B (Actor-Model)** is best suited if the system grows in scope: more pane types, more complex per-pane lifecycle management, or multi-host deployment. It is over-engineered for v1 but represents the cleanest long-term architecture if Sirko expands significantly.

---

*End of alternatives document.*
