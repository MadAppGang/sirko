# Sirko — Architecture Document

**Session**: dev-arch-20260316-124106-081b4c45
**Date**: 2026-03-16
**Status**: Approved
**Approach**: Hybrid A+C — Pipeline/Middleware for core event processing + EventBus for adapter fan-out

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Data Flow](#3-data-flow)
4. [Key Interfaces and Type Contracts](#4-key-interfaces-and-type-contracts)
5. [Middleware Pipeline Detail](#5-middleware-pipeline-detail)
6. [Input Detection Deep Dive](#6-input-detection-deep-dive)
7. [Voice Pipeline Architecture](#7-voice-pipeline-architecture)
8. [Telegram Adapter Architecture](#8-telegram-adapter-architecture)
9. [State Persistence](#9-state-persistence)
10. [Implementation Plan](#10-implementation-plan)
11. [Testing Strategy](#11-testing-strategy)
12. [Security Considerations (v1)](#12-security-considerations-v1)
13. [Runtime Topology](#13-runtime-topology)
14. [Backpressure & Queueing](#14-backpressure--queueing)

---

## 1. System Overview

### 1.1 Architecture Diagram

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                         HOST MACHINE                                    │
 │                                                                          │
 │  ┌──────────┐   control-mode stdio   ┌───────────────────────────────┐  │
 │  │  tmux    │ ─────────────────────► │        tmux-client            │  │
 │  │ server   │ ◄───────────────────── │  (protocol parser + sender)   │  │
 │  └──────────┘     send-keys          └───────────┬───────────────────┘  │
 │       │                                          │ TmuxEvent stream      │
 │  ┌────┴───────┐                                  ▼                       │
 │  │  CLI agent │             ┌────────────────────────────────────────┐   │
 │  │  (claude,  │             │          MIDDLEWARE PIPELINE           │   │
 │  │   codex,   │             │                                        │   │
 │  │   aider)   │             │  xterm-interpret                       │   │
 │  └────────────┘             │       │                                │   │
 │                             │  state-manager                         │   │
 │                             │       │                                │   │
 │                             │  detection                             │   │
 │                             │       │                                │   │
 │                             │  dedup                                 │   │
 │                             │       │                                │   │
 │                             │  output-archive                        │   │
 │                             │       │                                │   │
 │                             │  notification-fanout ─────────────┐   │   │
 │                             │       │                            │   │   │
 │                             │  logger                            │   │   │
 │                             └────────────────────────────────────┘   │   │
 │                                                                       │   │
 │                    ┌──────────────────────────────────────────────────┘   │
 │                    │                                                       │
 │                    ▼                                                       │
 │         ┌─────────────────┐                                               │
 │         │    EventBus     │  (typed, in-process)                          │
 │         └────────┬────────┘                                               │
 │                  │                                                        │
 │       ┌──────────┼──────────────────────┐                                │
 │       ▼          ▼                      ▼                                │
 │  ┌──────────┐  ┌──────────────┐  ┌──────────┐                           │
 │  │ telegram │  │    voice     │  │  logger  │                           │
 │  │  adapter │  │   adapter    │  │  sink    │                           │
 │  └────┬─────┘  └──────┬───────┘  └──────────┘                           │
 │       │               │                                                   │
 └───────┼───────────────┼───────────────────────────────────────────────────┘
         │               │
         ▼               ▼
   Telegram Bot    ┌─────────────┐
   API / grammY    │ voice-server│
                   │  (Twilio /  │
                   │  LiveKit)   │
                   └─────────────┘
                         │
               ┌─────────┴──────────┐
               ▼                    ▼
          Deepgram STT         ElevenLabs TTS
               │                    ▲
               ▼                    │
          Vercel AI SDK  ───────────┘
          (LLM summary)
```

### 1.2 System Description

Sirko is a personal orchestration layer that bridges CLI AI agents (Claude Code, Codex, Aider) running inside tmux panes to human interfaces (Telegram and voice calls). It connects to tmux via control mode to receive a structured event stream, runs every event through an ordered middleware pipeline that interprets terminal output, tracks pane state, and detects when an agent is awaiting human input — then emits a typed event onto an internal EventBus that fans out to adapter subscribers (Telegram bot, voice pipeline, logger). The reverse path allows replies typed in Telegram or spoken over a phone call to be routed back as keystrokes to the correct pane.

### 1.3 The Hybrid Design

The system combines two complementary patterns:

**Pipeline/Middleware (Alternative C)** governs the inbound processing path. Every `TmuxEvent` arriving from the control-mode socket passes sequentially through a composed middleware stack. Each stage can inspect, enrich, and mutate a shared `EventContext` before passing control to the next stage via `next()`. This provides explicit, readable, and debuggable control flow: the ordered middleware array in `orchestrator/src/index.ts` is the authoritative description of what happens to every event.

**EventBus (Alternative A fan-out)** governs the outbound notification path. When the final notification middleware determines that a pane is awaiting input, it does not call adapter code directly. Instead it emits a typed `SirkoEvent` onto an in-process EventBus. Adapters (Telegram, Voice, Logger) subscribe to specific event types and react independently. This preserves the pipeline's linear clarity for the common case while providing the event-driven architecture's extensibility for the fan-out case: adding a new notification channel requires only a new subscriber, with no changes to the middleware stack.

The seam between the two patterns is the `notification-fanout` middleware: it is the last substantive middleware in the pipeline and its sole job is to emit the appropriate `SirkoEvent` onto the bus.

### 1.4 Component Descriptions

**tmux-client** is the system's only connection to the outside world for tmux events. It spawns or attaches to a tmux server using control mode (`tmux -CC`), reads the structured text stream line by line, parses protocol messages into typed `TmuxEvent` objects, and exposes an async generator that the orchestrator's event loop consumes. It also holds the outbound `sendKeys` capability: given a pane ID and text, it issues the appropriate `send-keys` command over the same control-mode connection.

**pipeline** is a small, dependency-free compose engine. It implements the Koa-style `compose(middlewares)` function that takes an ordered array of `Middleware` functions and returns a single `(ctx: EventContext) => Promise<void>` runner. The pipeline package defines the `EventContext` type and the `Middleware` type. It has no knowledge of tmux, detection, or adapters.

**event-bus** is a typed wrapper over Bun's native EventEmitter. It exposes `emit<T extends SirkoEvent>(event: T)` and `on<K extends SirkoEvent['type']>(type, handler)` with full TypeScript inference, ensuring that subscribers receive precisely-typed event payloads. The bus is instantiated once in the orchestrator and injected into any component that needs it.

**detector** is not a standalone package but the `detection` middleware module within the `pipeline` package. It implements the three-signal weighted heuristic: prompt-pattern matching against the xterm buffer, process wait-channel inspection, and quiescence timing. It reads `SkillDefinition` config from `tool-plugins` to apply per-tool weights and patterns.

**tool-plugins** is a pure-data package that exports a registry of `SkillDefinition` objects, one per supported CLI tool. Each definition declares the tool's name, binary path pattern, custom prompt regexes, signal weight overrides, and any tool-specific pre/post-input behavior. New tools are added by adding a file to this package — no core logic changes required.

**state-store** is a synchronous in-memory `Map<paneId, PaneState>` with a disk-persistence layer. It is the single source of truth for pane status, notification state, topic mappings, and xterm instances. It serializes to JSON on a configurable interval and on graceful shutdown, and loads from disk on startup to restore state across restarts.

**voice-pipeline** contains the stateless, transport-independent voice processing logic: `transcribe(audioStream) → AsyncIterable<string>` using Deepgram, `summarize(context: string) → string` using Vercel AI SDK, and `synthesize(text: string) → AsyncIterable<Buffer>` using ElevenLabs. The transport (Twilio or LiveKit) is injected as a `VoiceTransport` dependency.

**orchestrator** (the `apps/orchestrator` app) wires all packages together. It instantiates the tmux client, assembles the middleware pipeline, creates the EventBus, constructs adapters, and runs the event loop: `for await (const event of tmuxClient.events()) { await pipeline(buildContext(event)) }`.

**telegram-bot** (the `apps/telegram-bot` app) subscribes to `PaneOutput`, `PaneAwaitingInput`, and `PaneExited` events on the bus. It manages the grammY bot instance, maintains the topic-to-pane mapping, streams output, sends notifications, and routes incoming Telegram messages back to the orchestrator via `tmuxClient.sendKeys`.

**voice-server** (the `apps/voice-server` app) subscribes to `PaneAwaitingInput` events, initiates outbound calls via Twilio or LiveKit, and drives the voice pipeline for the duration of the call.

---

## 2. Monorepo Structure (Turborepo + Bun Workspaces)

### 2.1 Directory Layout

```
sirko/
├── turbo.json
├── package.json                  (root workspace, Bun workspaces config)
├── tsconfig.base.json            (shared TS strict config)
├── .env.example
│
├── packages/
│   ├── tmux-client/              tmux control-mode TypeScript client
│   ├── pipeline/                 Middleware compose engine + core middleware
│   ├── event-bus/                Typed EventBus for adapter fan-out
│   ├── detector/                 Input detection (3-signal weighted heuristic)
│   ├── tool-plugins/             CLI tool skill definitions
│   ├── state-store/              In-memory + file-persisted state
│   ├── voice-pipeline/           STT → LLM → TTS with Vercel AI SDK
│   └── shared/                   Types, constants, utilities
│
└── apps/
    ├── orchestrator/             Main app — wires pipeline, bus, tmux client
    ├── telegram-bot/             grammY Telegram adapter
    ├── voice-server/             Twilio/LiveKit voice adapter
    └── web/                      React dashboard (Phase 6, optional)
```

### 2.2 Package Detail

---

#### `packages/shared`

**Purpose**: Shared TypeScript types, constants, and pure utility functions used by all other packages. Has no dependencies on any other internal package.

**Key exports**:
- All `SirkoEvent` discriminated union types
- `PaneStatus` enum (`running | awaiting-input | idle | exited`)
- `ToolName` enum (`claude-code | codex | aider | unknown`)
- `Platform` type (`macos | linux`)
- Pure utility functions: `formatTimestamp`, `truncateForTelegram`, `paneIdFromString`

**Dependencies**: None (zero internal deps, no runtime external deps beyond TypeScript builtins)

---

#### `packages/tmux-client`

**Purpose**: Connects to a tmux server via control mode, parses the structured event stream into typed objects, and provides the `sendKeys` interface for delivering text input to panes.

**Key exports**:
- `TmuxClient` class — `connect(socketPath?)`, `events(): AsyncGenerator<TmuxEvent>`, `sendKeys(paneId, text)`, `newSession(name)`, `newWindow(sessionId)`, `newPane(windowId)`, `capturePane(paneId)`
- `TmuxEvent` discriminated union — `PaneOutputEvent`, `PaneExitedEvent`, `SessionCreatedEvent`, `SessionClosedEvent`, `WindowAddedEvent`, `WindowClosedEvent`
- `TmuxObjectModel` — `Server`, `Session`, `Window`, `Pane` hierarchy types

**Key types**:
```typescript
type TmuxEvent =
  | { type: 'pane-output';    paneId: string; sessionId: string; raw: string; timestamp: number }
  | { type: 'pane-exited';    paneId: string; sessionId: string }
  | { type: 'session-created'; sessionId: string; name: string }
  | { type: 'session-closed'; sessionId: string }
  | { type: 'window-add';     windowId: string; sessionId: string }
  | { type: 'window-close';   windowId: string; sessionId: string }
```

**Dependencies (internal)**: `shared`
**Dependencies (external)**: `@xterm/headless` (for xterm instance construction, shared with the pipeline middleware)

---

#### `packages/pipeline`

**Purpose**: The compose engine and all core middleware implementations. This is the heart of the inbound event processing path.

**Key exports**:
- `compose(middlewares: Middleware[]): Pipeline` — creates a runnable pipeline
- `buildContext(event: TmuxEvent, store: StateStore): EventContext` — constructs initial context
- `EventContext` type (see Section 4)
- `Middleware` type (see Section 4)
- Individual middleware factory functions (one per middleware stage, detailed in Section 5)

**Sub-modules** (within the package, not separate packages):
```
pipeline/src/
  compose.ts           compose() implementation (~50 lines, Koa-style)
  context.ts           EventContext type definition
  middleware/
    xterm-interpret.ts
    state-manager.ts
    detection.ts
    dedup.ts
    notification-fanout.ts
    output-archive.ts
    logger.ts
```

**Dependencies (internal)**: `shared`, `state-store`, `tool-plugins`, `event-bus`
**Dependencies (external)**: `@xterm/headless`

---

#### `packages/event-bus`

**Purpose**: Typed in-process EventBus for adapter fan-out. Wraps Bun's native EventEmitter with TypeScript generics so subscribers receive precisely-typed payloads.

**Key exports**:
- `EventBus` class — `emit<T extends SirkoEvent>(event: T): void`, `on<K>(type: K, handler): UnsubscribeFn`, `once<K>(type: K, handler): UnsubscribeFn`, `off(type, handler)`
- `SirkoEvent` discriminated union re-export from `shared`
- `createEventBus(): EventBus` factory

**Key invariant**: The bus is constructed once in the orchestrator and passed by reference to all components that need it (not a global singleton). This keeps the dependency explicit and testable.

**Dependencies (internal)**: `shared`
**Dependencies (external)**: None (wraps Bun built-in EventEmitter)

---

#### `packages/detector`

**Purpose**: Encapsulates the three-signal input detection logic. Exported as a self-contained module that the `detection` middleware instantiates per-pane.

**Key exports**:
- `DetectorEngine` class — `computeScore(paneId: string, ctx: EventContext): Promise<DetectionResult>`
- `QuiescenceTracker` class — manages per-pane quiescence timers, called by the scheduler in the orchestrator
- `WchanInspector` — platform-abstracted process wait-channel reader (Linux: `/proc`; macOS: `ps`)
- `PromptMatcher` — regex-based prompt pattern matcher, fed from `SkillDefinition`
- `DetectionResult` type — `{ score: number; awaiting: boolean; tool: ToolName; confidence: number; signals: SignalBreakdown }`

**Dependencies (internal)**: `shared`, `tool-plugins`, `state-store`
**Dependencies (external)**: None

---

#### `packages/tool-plugins`

**Purpose**: Static registry of per-CLI-tool `SkillDefinition` objects. Adding a new tool requires only adding a new file in `plugins/` — no core logic changes.

**Key exports**:
- `SkillDefinition` interface (see Section 4)
- `getSkill(toolName: ToolName): SkillDefinition`
- `detectTool(paneId: string, processList: ProcessInfo[]): ToolName` — identifies which tool is running in a pane
- Built-in skills: `claudeCodeSkill`, `codexSkill`, `aiderSkill`, `unknownSkill`

**Plugin file structure**:
```
tool-plugins/src/
  types.ts           SkillDefinition interface
  registry.ts        skill registry and getSkill()
  detect.ts          tool identification logic
  plugins/
    claude-code.ts
    codex.ts
    aider.ts
    unknown.ts       fallback defaults
```

**Dependencies (internal)**: `shared`
**Dependencies (external)**: None

---

#### `packages/state-store`

**Purpose**: Single source of truth for all runtime pane state. Synchronous in-memory operations for use on the hot path; async disk persistence for durability.

**Key exports**:
- `StateStore` class
  - `getPane(paneId): PaneState | undefined`
  - `setPane(paneId, state: PaneState): void`
  - `deletePane(paneId): void`
  - `allPanes(): PaneState[]`
  - `getTopicMap(): Map<paneId, topicId>` (pane ↔ Telegram topic)
  - `setTopicMap(paneId, topicId): void`
  - `persist(): Promise<void>` — write to disk
  - `load(): Promise<void>` — restore from disk on startup
- `PaneState` type (see Section 4)
- `createStateStore(persistPath: string): StateStore`

**Key design note**: All reads/writes to in-memory state are synchronous, exploiting Bun's single-threaded event loop to avoid races between the pipeline (which mutates state) and the quiescence scheduler (which reads state). No locks required.

**Dependencies (internal)**: `shared`
**Dependencies (external)**: None

---

#### `packages/voice-pipeline`

**Purpose**: Stateless, transport-independent voice processing logic: STT, LLM summarization, and TTS. The `VoiceTransport` (Twilio vs. LiveKit) is injected; this package contains none of that wiring.

**Key exports**:
- `transcribe(audioStream: AsyncIterable<Buffer>, opts: TranscribeOptions): AsyncIterable<string>` — Deepgram streaming STT
- `summarize(terminalContext: string, opts: SummarizeOptions): Promise<string>` — Vercel AI SDK LLM call
- `synthesize(text: string, opts: SynthesizeOptions): AsyncIterable<Buffer>` — ElevenLabs streaming TTS
- `VoiceTransport` interface (see Section 4)
- `VoicePipelineConfig` type — API keys, model selection, ElevenLabs voice ID, etc.

**Dependencies (internal)**: `shared`
**Dependencies (external)**: `@deepgram/sdk`, `elevenlabs`, `ai` (Vercel AI SDK)

---

#### `apps/orchestrator`

**Purpose**: Main application process. Instantiates and wires all packages. Owns the event loop.

**Key responsibilities**:
- Load config from environment variables
- Construct `StateStore` and call `store.load()`
- Construct `EventBus`
- Construct `TmuxClient` and connect
- Assemble middleware pipeline with `compose([...])`
- Start quiescence scheduler (`setInterval`)
- Start signal on graceful shutdown (SIGTERM/SIGINT)
- Run the event loop: `for await (const event of tmuxClient.events())`

**Dependencies (internal)**: All packages
**Dependencies (external)**: None (only glue code)

---

#### `apps/telegram-bot`

**Purpose**: The grammY Telegram adapter. Subscribes to `SirkoEvent`s on the bus and handles inbound Telegram messages.

**Key responsibilities**:
- Subscribe to `PaneOutput`, `PaneAwaitingInput`, `PaneExited`, `InputDelivered` events
- Manage forum topic lifecycle (create on new pane, archive on exit)
- Stream output using `sendMessageDraft`
- Format and send awaiting-input notifications
- Route incoming messages to `tmuxClient.sendKeys`
- Enforce rate-limit queue

**Dependencies (internal)**: `shared`, `event-bus`, `state-store`
**Dependencies (external)**: `grammy`

---

#### `apps/voice-server`

**Purpose**: The voice adapter. Subscribes to `PaneAwaitingInput` events, manages call lifecycles, and drives the voice pipeline.

**Key responsibilities**:
- Subscribe to `PaneAwaitingInput` and `InputDelivered` events
- Serve Twilio webhook endpoints (TwiML for outbound calls)
- Manage bidirectional WebSocket media stream with Twilio
- (Phase 5) Manage LiveKit room lifecycle and agent session
- Drive `voice-pipeline` (STT → LLM summarize → TTS)
- Route transcribed speech as input back to the pane

**Dependencies (internal)**: `shared`, `event-bus`, `state-store`, `voice-pipeline`
**Dependencies (external)**: `twilio`, `livekit-server-sdk`, `livekit-agents`

---

#### `apps/web` (Phase 6, optional)

**Purpose**: React dashboard for session overview and management.

**Key responsibilities**: Display pane status, session history, detection confidence scores, log viewer.

**Dependencies (external)**: `react`, `@tanstack/react-query`, `@tanstack/react-router`

---

## 3. Data Flow

### 3.1 Inbound: tmux Output to Adapter Delivery

```
 tmux pane (CLI agent writes output)
          │
          │  stdout written to pty
          ▼
 tmux server (control mode)
          │
          │  "%output %3 <escaped-text>\n"
          ▼
 TmuxClient.events()  [packages/tmux-client]
          │
          │  yields: TmuxEvent { type: 'pane-output', paneId: '%3',
          │                      raw: '<escaped-text>', timestamp }
          ▼
 orchestrator event loop  [apps/orchestrator]
          │
          │  buildContext(event, store) → EventContext
          │  pipeline(ctx)
          ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │                  MIDDLEWARE PIPELINE                             │
 │                                                                  │
 │  [1] xterm-interpret                                             │
 │      - feed ctx.event.raw through per-pane @xterm/headless      │
 │      - ctx.parsedText = plain text                               │
 │      - ctx.cursorState = { row, col, visible }                   │
 │      - ctx.xtermBuffer = current screen buffer snapshot          │
 │                                                                  │
 │  [2] state-manager (PRE)                                         │
 │      - load PaneState from StateStore → ctx.pane                 │
 │      - create PaneState if first event for this pane             │
 │                                                                  │
 │  [3] detection                                                   │
 │      - PromptMatcher.match(ctx.xtermBuffer, skill) → signal 1   │
 │      - WchanInspector.read(ctx.pane.pid) → signal 2             │
 │      - QuiescenceTracker.score(ctx.pane) → signal 3             │
 │      - WeightedAggregator → ctx.detectionResult                  │
 │        { score, awaiting, tool, confidence, signals }            │
 │                                                                  │
 │  [4] dedup                                                       │
 │      - if ctx.pane.notificationState == 'notified':              │
 │          ctx.aborted = true; return (skip remaining)             │
 │                                                                  │
 │  [5] notification-fanout                                         │
 │      - if ctx.detectionResult.awaiting && !ctx.aborted:          │
 │          bus.emit({ type: 'PaneAwaitingInput', ...ctx })         │
 │          ctx.pane.notificationState = 'notified'                 │
 │      - always:                                                   │
 │          bus.emit({ type: 'PaneOutput', paneId, text, ts })      │
 │                                                                  │
 │  [6] output-archive                                              │
 │      - append ctx.parsedText to /logs/<sessionId>/<paneId>.log   │
 │                                                                  │
 │  [7] state-manager (POST)                                        │
 │      - write ctx.pane back to StateStore                         │
 │      - update lastOutputTime, status, etc.                       │
 │                                                                  │
 │  [8] logger                                                      │
 │      - emit structured JSON log entry with full ctx summary      │
 │                                                                  │
 └─────────────────────────────────────────────────────────────────┘
          │
          │  bus.emit(SirkoEvent)
          ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │                         EVENT BUS                               │
 └──────────────┬───────────────────────┬───────────────┬──────────┘
                │                       │               │
      ┌─────────▼────────┐   ┌──────────▼──────┐   ┌───▼──────┐
      │  telegram-bot    │   │  voice-server   │   │  logger  │
      │  subscriber      │   │  subscriber     │   │  sink    │
      │                  │   │                 │   └──────────┘
      │  on PaneOutput:  │   │  on PaneAwaiting│
      │   stream to topic│   │  Input:         │
      │                  │   │   initiate call │
      │  on PaneAwaiting │   │                 │
      │  Input:          │   │  on InputDeliv- │
      │   send notif msg │   │  ered: cancel   │
      │                  │   │   pending call  │
      └────────┬─────────┘   └────────┬────────┘
               │                      │
               ▼                      ▼
       Telegram Bot API        Twilio / LiveKit
       (grammY, forum topic)   WebSocket + voice-pipeline
```

### 3.2 Reverse Path: User Input via Telegram

```
 User types message in Telegram forum topic
          │
          ▼
 grammY message handler  [apps/telegram-bot]
          │
          │  identify pane from topic ID (state-store topic map)
          ▼
 tmuxClient.sendKeys(paneId, text)  [packages/tmux-client]
          │
          │  sends: "send-keys -t %3 '<text>' Enter"
          ▼
 tmux server delivers keystrokes to pane
          │
          ▼
 CLI agent receives input, resumes execution
          │
          │  (telegram-bot also:)
          ├─ stateStore.setNotificationState(paneId, 'idle')
          └─ bus.emit({ type: 'InputDelivered', paneId, source: 'telegram' })
                    │
                    ▼
             voice-server subscriber
             (cancels pending outbound call if one was queued)
```

### 3.3 Quiescence Scheduler (external to pipeline)

```
 setInterval(500ms)  [apps/orchestrator]
          │
          │  for each pane in stateStore.allPanes():
          │    if (now - pane.lastOutputTime > skill.quiescenceThreshold)
          │    && pane.processingCount == 0
          │    && pane.status != 'awaiting-input':
          │        inject QuiescenceCheck event into pipeline
          │        pipeline(buildQuiescenceContext(pane))
          │
          ▼
 (QuiescenceCheck flows through detection middleware)
 (if score crosses threshold → emits PaneAwaitingInput to bus)
```

---

## 4. Key Interfaces and Type Contracts

The following TypeScript interface definitions are authoritative contracts. No implementation code is included.

### 4.1 `SirkoEvent` Discriminated Union

```typescript
type SirkoEvent =
  | {
      type: 'PaneOutput'
      paneId: string
      sessionId: string
      text: string           // plain text (post-xterm interpretation)
      raw: string            // original escape-sequence bytes
      timestamp: number
    }
  | {
      type: 'PaneAwaitingInput'
      paneId: string
      sessionId: string
      tool: ToolName
      confidence: number     // 0.0–1.0
      score: number          // raw weighted score
      context: string        // terminal buffer snapshot for voice summarization
      signals: SignalBreakdown
    }
  | {
      type: 'InputDelivered'
      paneId: string
      sessionId: string
      source: 'telegram' | 'voice'
      text: string
    }
  | {
      type: 'PaneExited'
      paneId: string
      sessionId: string
      exitCode: number | null
    }
  | {
      type: 'SessionCreated'
      sessionId: string
      name: string
    }
  | {
      type: 'SessionClosed'
      sessionId: string
    }
  | {
      type: 'VoiceCallStarted'
      paneId: string
      callSid: string        // Twilio call SID or LiveKit room name
      transport: 'twilio' | 'livekit'
    }
  | {
      type: 'VoiceCallEnded'
      paneId: string
      callSid: string
      durationSeconds: number
    }
  | {
      type: 'VoiceCallFailed'
      paneId: string
      reason: string
    }
  | {
      type: 'SinkError'
      sink: 'telegram' | 'voice'
      paneId: string | null
      error: string
      retriable: boolean
    }
```

### 4.2 `EventContext`

```typescript
interface EventContext {
  // Populated at construction (buildContext)
  readonly event: TmuxEvent
  readonly startedAt: number        // hrtime.bigint() for latency tracking

  // Populated by state-manager (PRE)
  pane: PaneState | null            // null only for SessionCreated/SessionClosed events

  // Populated by xterm-interpret (only for pane-output events)
  parsedText?: string
  cursorState?: CursorState
  xtermBuffer?: string              // full current screen content as plain text

  // Populated by detection
  detectionResult?: DetectionResult

  // Pipeline control
  aborted: boolean                  // set by dedup to skip notification-fanout
  sideEffects: SideEffect[]         // accumulated declared effects (for testing/dry-run)

  // Populated by logger for structured output
  middlewareDurations: Record<string, number>  // ms per middleware stage
}

interface CursorState {
  row: number
  col: number
  visible: boolean
}

interface DetectionResult {
  score: number                     // weighted sum, 0.0–1.0
  awaiting: boolean                 // score >= threshold
  tool: ToolName
  confidence: number                // same as score, named for readability in events
  signals: SignalBreakdown
}

interface SignalBreakdown {
  promptPattern: { matched: boolean; pattern: string | null; weight: number; contribution: number }
  wchan:         { value: string | null;  isWaiting: boolean; weight: number; contribution: number }
  quiescence:    { silenceMs: number;     threshold: number;  weight: number; contribution: number }
}

type SideEffect =
  | { kind: 'send-keys';    paneId: string; text: string }
  | { kind: 'file-append';  path: string;   content: string }
  | { kind: 'bus-emit';     event: SirkoEvent }
  | { kind: 'telegram-api'; method: string; params: unknown }
```

### 4.3 `Middleware<T>`

```typescript
// Base middleware type — T is the EventContext subtype for typed pipelines
type Middleware<T extends EventContext = EventContext> =
  (ctx: T, next: () => Promise<void>) => Promise<void>

// Pipeline runner returned by compose()
interface Pipeline<T extends EventContext = EventContext> {
  run(ctx: T): Promise<void>
}

// compose() implementation signature
declare function compose<T extends EventContext>(
  middlewares: Middleware<T>[]
): Pipeline<T>
```

### 4.4 `SkillDefinition`

```typescript
interface SkillDefinition {
  name: ToolName
  displayName: string

  // Process identification
  binaryPattern: RegExp             // matched against process argv[0]
  processNamePattern: RegExp        // matched against process name in ps output

  // Prompt pattern signal
  promptPatterns: RegExp[]          // regexes matched against xterm buffer last lines
  promptPatternWeight: number       // 0.0–1.0, overrides global default

  // Quiescence signal
  quiescenceThresholdMs: number     // silence duration before quiescence fires
  quiescenceWeight: number          // 0.0–1.0

  // Wait-channel signal
  wchanWaitValues: string[]         // kernel wait channel values indicating blocking read
  wchanWeight: number               // 0.0–1.0

  // Aggregation
  scoringThreshold: number          // weighted score threshold to trigger PaneAwaitingInput

  // Behavior hooks
  preInputDelay?: number            // ms to wait before routing input (some tools need it)
  inputSuffix?: string              // appended to input before send-keys (e.g., '\n')
  outputStreamingDelay?: number     // ms debounce before treating output burst as complete
}
```

### 4.5 `VoiceTransport`

```typescript
interface VoiceTransport {
  readonly name: 'twilio' | 'livekit'

  // Lifecycle
  initiateCall(to: string, callbackUrl: string): Promise<string>   // returns callSid/roomName
  hangup(callId: string): Promise<void>

  // Audio streams
  getInboundAudio(callId: string): AsyncIterable<Buffer>           // raw μ-law or PCM from caller
  sendOutboundAudio(callId: string, audio: AsyncIterable<Buffer>): Promise<void>

  // Format info (for pipeline to convert as needed)
  readonly inboundFormat: AudioFormat
  readonly outboundFormat: AudioFormat

  // Event hooks
  onCallConnected(callId: string, handler: () => void): void
  onCallEnded(callId: string, handler: (reason: string) => void): void
}

interface AudioFormat {
  codec: 'mulaw' | 'pcm16' | 'opus'
  sampleRate: 8000 | 16000 | 48000
  channels: 1 | 2
}
```

### 4.6 `PaneState`

```typescript
interface PaneState {
  // Identity
  paneId: string
  sessionId: string
  windowId: string

  // Tool
  tool: ToolName
  pid: number | null             // OS PID of the process running in the pane

  // Status
  status: PaneStatus             // 'running' | 'awaiting-input' | 'idle' | 'exited'
  exitCode: number | null

  // Notification dedup
  notificationState: 'idle' | 'notified'
  lastNotifiedAt: number | null  // Unix ms timestamp

  // Output timing (for quiescence)
  lastOutputTime: number         // Unix ms timestamp
  processingCount: number        // incremented on pipeline entry, decremented on exit

  // Terminal state
  xtermInstance: unknown | null  // @xterm/headless ITerminal — not serialized to disk
  lastBufferSnapshot: string

  // Telegram
  telegramTopicId: number | null

  // Persistence metadata
  schemaVersion: number
  createdAt: number
  updatedAt: number
}

type PaneStatus = 'running' | 'awaiting-input' | 'idle' | 'exited'
```

### 4.7 `AdapterSink`

```typescript
// Interface implemented by telegram-bot, voice-server, and any future adapters
interface AdapterSink {
  readonly name: string

  // Called by the EventBus subscriber in each adapter app
  // These are not called directly by the pipeline
  handlePaneOutput(event: Extract<SirkoEvent, { type: 'PaneOutput' }>): Promise<void>
  handlePaneAwaitingInput(event: Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>): Promise<void>
  handlePaneExited(event: Extract<SirkoEvent, { type: 'PaneExited' }>): Promise<void>
  handleInputDelivered(event: Extract<SirkoEvent, { type: 'InputDelivered' }>): Promise<void>

  // Health and lifecycle
  start(): Promise<void>
  stop(): Promise<void>
  isHealthy(): boolean
}
```

---

## 5. Middleware Pipeline Detail

The pipeline is assembled once at startup in `apps/orchestrator/src/pipeline.ts` and executed once per incoming `TmuxEvent`. Middleware are listed in execution order. Each entry shows the stage name, purpose, what it reads from `EventContext`, what it writes, and error behavior.

```
 Event arrives
      │
      ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │  MIDDLEWARE EXECUTION ORDER                                          │
 │                                                                      │
 │  1. xterm-interpret        [packages/pipeline/middleware/xterm.ts]   │
 │  2. state-manager (PRE)    [packages/pipeline/middleware/state.ts]   │
 │  3. detection              [packages/pipeline/middleware/detect.ts]  │
 │  4. dedup                  [packages/pipeline/middleware/dedup.ts]   │
 │  5. notification-fanout    [packages/pipeline/middleware/fanout.ts]  │
 │  6. output-archive         [packages/pipeline/middleware/archive.ts] │
 │  7. state-manager (POST)   [same file, post-next() hook]             │
 │  8. logger                 [packages/pipeline/middleware/logger.ts]  │
 │                                                                      │
 └─────────────────────────────────────────────────────────────────────┘
```

---

### Middleware 1: `xterm-interpret`

**Purpose**: Translate raw tmux output (which contains ANSI/VT escape sequences) into human-readable text and current screen state.

**Reads**: `ctx.event.raw` (only runs for `pane-output` events; calls `next()` immediately for other event types)

**Writes**: `ctx.parsedText`, `ctx.cursorState`, `ctx.xtermBuffer`

**Implementation notes**:
- Retrieves (or lazily creates) the per-pane `@xterm/headless` `ITerminal` instance from `ctx.pane.xtermInstance` (stored in `PaneState`, not serialized to disk)
- Feeds `ctx.event.raw` into `terminal.write(raw)`, which updates the terminal's internal buffer
- Reads the current viewport via `terminal.buffer.active` to produce `ctx.xtermBuffer`
- `ctx.parsedText` is extracted from the written data only (the new text from this event), not the full buffer
- The middleware uses a `TerminalEmulator` interface abstraction rather than calling `@xterm/headless` directly:

```typescript
interface TerminalEmulator {
  write(raw: string): void
  getBuffer(): string          // full current screen as plain text
  getCursor(): CursorState
}
```

- **`XtermEmulator`** (full capability): wraps `@xterm/headless` `ITerminal`. Provides accurate screen-buffer state, cursor tracking, and full ANSI/VT sequence interpretation.
- **`BufferEmulator`** (degraded, line-buffer + `strip-ansi`): fallback when `@xterm/headless` is not Bun-compatible. Maintains a rolling line buffer; strips ANSI escape sequences but does not emulate cursor movement or screen rewrites. Prompt patterns in `SkillDefinition` MUST be designed to match against the degraded buffer (plain text, last N lines) — not against pixel-perfect screen positions.
- **Phase 1, Week 1 spike**: validate `@xterm/headless` Bun compatibility before building on top of it. If incompatible, `BufferEmulator` ships as the v1 implementation and `XtermEmulator` is deferred

**Error behavior**: Catch and log; populate `ctx.parsedText = ctx.event.raw` as degraded fallback so downstream stages still receive text.

---

### Middleware 2: `state-manager` (PRE)

**Purpose**: Load the current `PaneState` into `EventContext` before detection and notification run. Also creates a new `PaneState` on first sight of a pane.

**Reads**: `ctx.event.paneId`

**Writes**: `ctx.pane`, increments `ctx.pane.processingCount`

**Implementation notes**:
- For `session-created` and `session-closed` events, `ctx.pane` is set to `null`
- On first output from a previously unseen pane, creates a minimal `PaneState` and calls `detectTool()` from `tool-plugins` to populate `ctx.pane.tool`
- Increments `processingCount` synchronously before calling `next()`, decrements it in a `finally` block after `next()` resolves — this is what the quiescence scheduler checks to avoid false positives during active processing

**Error behavior**: If `StateStore` throws (which should not happen for in-memory operations), log and rethrow — this is a fatal condition.

---

### Middleware 3: `detection`

**Purpose**: Run the three-signal weighted heuristic to determine if the pane is awaiting human input.

**Reads**: `ctx.pane`, `ctx.xtermBuffer`, `ctx.parsedText`

**Writes**: `ctx.detectionResult`, `ctx.pane.status`

**Implementation notes**:
- Instantiates (or retrieves) a `DetectorEngine` per pane ID — the engine holds the wchan cache (refreshed every 500ms to avoid hammering `/proc`)
- For `QuiescenceCheck` synthetic events, runs the full three-signal evaluation
- For regular `pane-output` events, runs prompt-pattern and partial wchan check, resets quiescence timer, and computes partial score (quiescence signal score is 0 for active-output events)
- Per-tool weights and thresholds are sourced from `tool-plugins.getSkill(ctx.pane.tool)`
- If `ctx.detectionResult.awaiting == true`, also sets `ctx.pane.status = 'awaiting-input'`

**Error behavior**: Log signal computation errors individually. If all three signals fail, set `ctx.detectionResult = { score: 0, awaiting: false, ... }` — fail safe (do not false-positive an awaiting notification).

---

### Middleware 4: `dedup`

**Purpose**: Prevent duplicate notifications for a single await-input cycle.

**Reads**: `ctx.pane.notificationState`, `ctx.detectionResult.awaiting`

**Writes**: `ctx.aborted = true` (if suppressing)

**Implementation notes**:
- If `ctx.pane.notificationState == 'notified'` AND `ctx.detectionResult.awaiting == true`: sets `ctx.aborted = true` and returns without calling `next()` — this short-circuits the pipeline for this event
- If `ctx.pane.notificationState == 'notified'` AND `ctx.detectionResult.awaiting == false`: resets `ctx.pane.notificationState = 'idle'` (agent resumed running; next await cycle will notify again)
- Logging: always emit a structured log entry documenting the dedup decision

**Error behavior**: No I/O; cannot throw in normal operation.

---

### Middleware 5: `notification-fanout`

**Purpose**: Emit typed events onto the EventBus. This is the seam between the pipeline and the event-driven fan-out layer.

**Reads**: `ctx.detectionResult`, `ctx.pane`, `ctx.aborted`, `ctx.parsedText`

**Writes**: `ctx.pane.notificationState = 'notified'` (when emitting await notification)

**Implementation notes**:
- Always emits `PaneOutput` event (regardless of detection result) — this is how the Telegram adapter receives pane output for streaming to the topic
- If `!ctx.aborted && ctx.detectionResult.awaiting`: emits `PaneAwaitingInput` event with full context snapshot
- For `pane-exited` events: emits `PaneExited` event
- Uses `bus.emit()` which is synchronous in Bun — the event is dispatched to subscribers in the same microtask turn
- All bus emissions are recorded in `ctx.sideEffects` as `{ kind: 'bus-emit', event }` for dry-run testing

**Error behavior**: Bus `emit()` is synchronous and does not throw. Subscriber errors are caught by the EventBus wrapper and re-emitted as `SinkError` events.

---

### Middleware 6: `output-archive`

**Purpose**: Write durable per-session pane output logs to disk.

**Reads**: `ctx.parsedText`, `ctx.pane.paneId`, `ctx.pane.sessionId`, `ctx.event.timestamp`

**Writes**: appends to `/logs/<sessionId>/<paneId>.log`

**Implementation notes**:
- Log path is derived from config: `{logDir}/{sessionId}/{paneId}.log`
- Appends in format: `[<ISO-timestamp>] <parsedText>\n`
- Uses `Bun.file().writer()` with buffered append mode
- Does not block the pipeline on disk flush (fire-and-forget with error logging)
- On `pane-exited` event: writes a final `[<timestamp>] [exited: code <N>]\n` marker

**Error behavior**: Log write errors are non-fatal. Log the error to stderr, continue pipeline.

---

### Middleware 7: `state-manager` (POST)

**Purpose**: Persist the updated `PaneState` (mutated by detection and notification-fanout) back to the `StateStore`.

**Implementation notes**: This is the `finally` block of the `state-manager` middleware — it runs after all downstream middleware have resolved (or rejected). It also decrements `processingCount`. The `StateStore` schedules periodic disk persistence; the middleware only writes to the in-memory store.

---

### Middleware 8: `logger`

**Purpose**: Emit a single structured JSON log entry summarizing the full event processing run.

**Reads**: all fields of `ctx`, `ctx.middlewareDurations`, `ctx.aborted`, `ctx.detectionResult`

**Writes**: stdout (structured JSON)

**Log entry shape**:
```json
{
  "ts": 1234567890123,
  "event": "pane-output",
  "paneId": "%3",
  "sessionId": "$1",
  "tool": "claude-code",
  "detectionScore": 0.82,
  "awaiting": true,
  "aborted": false,
  "notified": true,
  "durations": { "xterm": 1.2, "state-pre": 0.3, "detection": 4.1, "dedup": 0.1, "fanout": 0.2, "archive": 0.5 },
  "totalMs": 6.4
}
```

**Error behavior**: Logger errors are swallowed (must not impact pipeline correctness).

---

## 6. Input Detection Deep Dive

### 6.1 Three-Signal Weighted Scoring Formula

The detector combines three independent signals into a single confidence score:

```
score = (S_prompt * W_prompt) + (S_wchan * W_wchan) + (S_quiescence * W_quiescence)

Where:
  S_*   = signal value in range [0.0, 1.0]
  W_*   = signal weight from SkillDefinition (default sum = 1.0, but not required to sum to 1)

Decision:
  awaiting = (score >= skill.scoringThreshold)
```

**Default weights** (used by `unknownSkill` fallback):

```
W_prompt     = 0.50   (highest weight: prompt patterns are highly reliable when matched)
W_wchan      = 0.30   (medium weight: strong signal on Linux; noisier on macOS)
W_quiescence = 0.20   (lower weight alone: many tools are quiet without waiting for input)

Default threshold = 0.60
```

**Per-signal value computation**:

| Signal | Raw value | Normalized to [0,1] |
|---|---|---|
| Prompt pattern | boolean match | 1.0 if matched, 0.0 if not |
| Wchan | kernel wait channel string | 1.0 if value in `skill.wchanWaitValues`, 0.5 if unknown/cacheable, 0.0 if running |
| Quiescence | milliseconds of silence | `min(silenceMs / threshold, 1.0)` — linearly ramps from 0 to 1 over the threshold window |

**Example: Claude Code awaiting input**

```
Signal state:
  prompt: matched "> " pattern             → S_prompt = 1.0
  wchan:  process in "wait_pipe_read"      → S_wchan  = 1.0
  quiescence: 2100ms silent (threshold 2000ms) → S_quiescence = 1.0

Score = (1.0 * 0.40) + (1.0 * 0.35) + (1.0 * 0.25) = 1.00
awaiting = true (threshold 0.60 exceeded)
```

**Example: Active code generation (false positive prevention)**

```
Signal state:
  prompt: no match                        → S_prompt = 0.0
  wchan:  process running (not in wait)   → S_wchan  = 0.0
  quiescence: 500ms silent (threshold 2000ms) → S_quiescence = 0.25

Score = (0.0 * 0.40) + (0.0 * 0.35) + (0.25 * 0.25) = 0.0625
awaiting = false (below threshold 0.60)
```

### 6.2 Platform-Specific Implementation

The `WchanInspector` abstracts the platform difference:

```
 ┌─────────────────────────────────────────────────────┐
 │                  WchanInspector                      │
 │                                                      │
 │  interface:                                          │
 │    readWchan(pid: number): Promise<string | null>    │
 │                                                      │
 │  ┌─────────────────┐      ┌────────────────────────┐ │
 │  │  LinuxWchan     │      │  MacosWchan            │ │
 │  │                 │      │                        │ │
 │  │  reads:         │      │  runs:                 │ │
 │  │  /proc/<pid>    │      │  ps -o wchan= -p <pid> │ │
 │  │  /wchan         │      │  (cached 500ms)        │ │
 │  │  (sync read)    │      │  lsof fallback         │ │
 │  └─────────────────┘      └────────────────────────┘ │
 └─────────────────────────────────────────────────────┘
```

**Linux (production)**:
- `/proc/<pid>/wchan` contains a single string (the kernel wait channel symbol)
- Read synchronously using `Bun.file('/proc/'+pid+'/wchan').text()` — fast and cheap
- Common wait channel values for input-blocked processes: `wait_pipe_read`, `pipe_read`, `ep_poll_callback`, `read_events`

**macOS (development)**:
- No `/proc` filesystem; use `ps -o wchan= -p <pid>` which outputs a short wait-channel name
- Result is cached for 500ms to avoid spawning a new process for every pipeline event
- Fallback: `lsof -p <pid> -a -d 0` to check if stdin (fd 0) is open in read mode

**PID resolution**: The `paneId` → `pid` mapping is populated when a pane is first seen. The tmux command `display-message -t %3 -p '#{pane_pid}'` is issued once and stored in `PaneState.pid`. If pid is null (e.g., pane just created), wchan signal returns 0.0.

### 6.3 Per-Tool Calibration via SkillDefinition

Each tool's `SkillDefinition` overrides the global defaults:

```
Tool: claude-code
  promptPatterns:       [/^> $/m, /^❯ $/m]
  promptPatternWeight:  0.45
  wchanWaitValues:      ['pipe_read', 'read_events']
  wchanWeight:          0.35
  quiescenceThresholdMs: 1800    (Claude Code is slow, reduce false positives)
  quiescenceWeight:     0.20
  scoringThreshold:     0.60

Tool: aider
  promptPatterns:       [/^> /m, /\(y\/n\)/i, /\[Yes\]/i]
  promptPatternWeight:  0.50
  quiescenceThresholdMs: 3000    (Aider can be silent during thinking)
  scoringThreshold:     0.55

Tool: codex
  promptPatterns:       [/^\? /m, /Continue\?/i]
  promptPatternWeight:  0.55
  quiescenceThresholdMs: 1500
  scoringThreshold:     0.65
```

### 6.4 Quiescence Timer Architecture

The quiescence signal is inherently time-driven, not event-driven. It does not fit cleanly inside the event pipeline (which only runs when events arrive). The resolution: a periodic scheduler external to the pipeline generates synthetic `QuiescenceCheck` events.

```
 ┌──────────────────────────────────────────────────────────────────┐
 │              QUIESCENCE SCHEDULER  [apps/orchestrator]            │
 │                                                                   │
 │  setInterval(checkIntervalMs = 500)                               │
 │       │                                                           │
 │       ▼                                                           │
 │  for each pane in stateStore.allPanes():                          │
 │    const elapsed = Date.now() - pane.lastOutputTime               │
 │    const skill   = getSkill(pane.tool)                            │
 │    const active  = pane.processingCount > 0                       │
 │    const already = pane.status === 'awaiting-input'               │
 │                                                                   │
 │    if elapsed >= skill.quiescenceThresholdMs                      │
 │    && !active                                                     │
 │    && !already                                                     │
 │    && pane.status !== 'exited':                                   │
 │                                                                   │
 │      pipeline.run(buildQuiescenceContext(pane))                   │
 │      (flows through detection → dedup → fanout if score crosses)  │
 │                                                                   │
 └──────────────────────────────────────────────────────────────────┘
```

**Why `processingCount`?** When a burst of output events is being processed (pipeline running for each), `lastOutputTime` has been updated but the pipeline may not have reached `state-manager (POST)` yet. Without `processingCount`, the scheduler could read an updated `lastOutputTime` but the pane would appear quiescent because the timer-check fires between pipeline executions. The counter prevents this race condition while staying purely single-threaded.

---

## 7. Voice Pipeline Architecture

### 7.1 Cascaded Pipeline

```
 User phone (caller audio)
          │
          │  μ-law, 8kHz (Twilio) or Opus, 48kHz (LiveKit)
          ▼
 ┌─────────────────────────────────────────────────────────┐
 │                  VoiceTransport                          │
 │          (TwilioTransport or LiveKitTransport)           │
 └──────────────────────┬──────────────────────────────────┘
                        │ getInboundAudio() → AsyncIterable<Buffer>
                        ▼
 ┌─────────────────────────────────────────────────────────┐
 │              AUDIO FORMAT CONVERSION                     │
 │  Twilio: mulaw 8kHz → PCM16 16kHz (for Deepgram)        │
 │  LiveKit: Opus 48kHz → PCM16 16kHz (via WebRTC decode)   │
 └──────────────────────┬──────────────────────────────────┘
                        │ PCM16, 16kHz, mono
                        ▼
 ┌─────────────────────────────────────────────────────────┐
 │              transcribe()  [voice-pipeline]              │
 │              Deepgram Nova-2 Streaming STT               │
 │              WebSocket → text chunks (final only)        │
 └──────────────────────┬──────────────────────────────────┘
                        │ AsyncIterable<string>  (transcript chunks)
                        ▼
 ┌─────────────────────────────────────────────────────────┐
 │              TRANSCRIPT ASSEMBLY                         │
 │  accumulate final transcript segments until              │
 │  silence gap > VAD threshold (end-of-utterance)          │
 └──────────────────────┬──────────────────────────────────┘
                        │ complete utterance string
                        ▼
 ┌─────────────────────────────────────────────────────────┐
 │          [Inbound: system notifying user]                │
 │          summarize()  [voice-pipeline]                   │
 │          Vercel AI SDK → LLM provider                    │
 │          Input: terminal context snapshot                │
 │          Output: 1-2 sentence spoken summary             │
 └──────────────────────┬──────────────────────────────────┘
                        │  OR  [Outbound: user responding]
                        │  transcript routes directly to sendKeys
                        ▼
 ┌─────────────────────────────────────────────────────────┐
 │              synthesize()  [voice-pipeline]              │
 │              ElevenLabs Streaming TTS                    │
 │              sentence-boundary chunked streaming         │
 └──────────────────────┬──────────────────────────────────┘
                        │ AsyncIterable<Buffer>  (MP3 or PCM chunks)
                        ▼
 ┌─────────────────────────────────────────────────────────┐
 │              AUDIO FORMAT CONVERSION (outbound)          │
 │  ElevenLabs PCM → μ-law 8kHz (for Twilio)               │
 │  ElevenLabs PCM → Opus (for LiveKit, via WebRTC encode)  │
 └──────────────────────┬──────────────────────────────────┘
                        │
                        ▼
 VoiceTransport.sendOutboundAudio()
          │
          ▼
 User phone (synthesized voice plays)
```

### 7.2 Transport Abstraction

```
 ┌──────────────────────────────────────────────────────────┐
 │                  VoiceTransport  (interface)              │
 │   initiateCall() / hangup()                               │
 │   getInboundAudio() / sendOutboundAudio()                 │
 │   onCallConnected() / onCallEnded()                       │
 └─────────────────┬──────────────────────────────────┬─────┘
                   │                                  │
    ┌──────────────▼──────────────┐   ┌───────────────▼─────────────┐
    │       TwilioTransport        │   │      LiveKitTransport         │
    │                              │   │                               │
    │  - Exposes Fastify routes    │   │  - Manages LiveKit room        │
    │    for TwiML callbacks       │   │  - Creates agent session       │
    │  - Manages WebSocket media   │   │  - Publishes audio track       │
    │    stream connection         │   │  - Uses livekit-agents SDK     │
    │  - Validates Twilio HMAC     │   │  - Scoped JWT token per call   │
    │  - μ-law ↔ PCM16 conversion  │   │  - Opus ↔ PCM16 conversion    │
    │  - Handles stream events:    │   │                               │
    │    connected, media, stop    │   │                               │
    └──────────────────────────────┘   └───────────────────────────────┘
```

### 7.3 Audio Format Conversion Chain

```
 INBOUND (caller → system):
 ┌──────────────┬──────────────────────────────────────────┐
 │ Twilio path  │ mulaw/8kHz → PCM16/16kHz (resample)      │
 │              │ library: custom G.711 decoder + Sox-style │
 │              │ resampler or audiobuffer-resampler npm     │
 ├──────────────┼──────────────────────────────────────────┤
 │ LiveKit path │ Opus/48kHz → PCM16/16kHz                  │
 │              │ LiveKit SDK handles decode internally      │
 └──────────────┴──────────────────────────────────────────┘

 OUTBOUND (system → caller):
 ┌──────────────┬──────────────────────────────────────────┐
 │ Twilio path  │ ElevenLabs PCM16/24kHz → PCM16/8kHz      │
 │              │ (downsample) → mulaw/8kHz (G.711 encode)  │
 ├──────────────┼──────────────────────────────────────────┤
 │ LiveKit path │ ElevenLabs PCM16/24kHz → Opus/48kHz       │
 │              │ (upsample + Opus encode via LiveKit SDK)   │
 └──────────────┴──────────────────────────────────────────┘
```

The conversion utilities live in `packages/voice-pipeline/src/audio-convert.ts` and are used by both transport implementations. This keeps format-specific logic out of the transport adapters.

### 7.4 Streaming Strategy (Sentence-Boundary Chunking)

ElevenLabs supports streaming TTS, but the initial phoneme latency (time-to-first-audio) is minimized by sending complete sentences rather than character-by-character streaming.

```
 LLM generates summary text via Vercel AI SDK streamText()
          │
          │  AsyncIterable<string>  (token chunks)
          ▼
 SentenceBoundaryBuffer
   - accumulates tokens
   - detects sentence boundaries: '.', '!', '?', '\n'
   - when boundary detected AND accumulated length > minChunkChars (e.g., 80):
       flush chunk to ElevenLabs
          │
          ▼
 ElevenLabs synthesize(chunk) → streaming audio
   - streamed immediately to VoiceTransport.sendOutboundAudio()
   - next chunk synthesis starts while current chunk is playing
          │
          ▼
 End-to-end latency budget (target 800ms, acceptable up to 1.5s):
   Stage 1 - Deepgram final-transcript latency:   ~200ms   (network + VAD end-of-utterance)
   Stage 2 - LLM first-token latency:             ~150ms   (Vercel AI SDK streamText, fast provider)
   Stage 3 - ElevenLabs first-audio latency:      ~150ms   (streaming TTS, first chunk)
   Stage 4 - Transport/network overhead:          ~50-100ms (Twilio) / ~20-50ms (LiveKit)
                                                  ---------
   Optimistic total (all stages fast):             ~550ms
   Realistic total (p50 production):               ~700-900ms
   Acceptable ceiling (p95):                       1.5s

   If Stage 1 or 3 degrades, the circuit breaker (see Section 14) trips after 3 consecutive
   failures in 30 seconds. On voice circuit open, the system falls back to Telegram-only
   notification.
```

### 7.5 Terminal Context Summarization Prompt Strategy

When the system calls the user via voice to report an agent waiting for input, the LLM summarizes the terminal context for spoken delivery. The prompt is designed to produce a concise, speakable summary.

**Context assembly** (built by `voice-server` from `PaneState.lastBufferSnapshot`):
```
- Last N lines of terminal output (capped at ~2000 characters)
- Tool name and session identifier
- Time since last activity
```

**System prompt** (stored in `voice-pipeline/src/prompts/terminal-summary.txt`):
```
You are a voice assistant reading terminal output aloud. The user is a developer
who is away from their computer. Summarize the following terminal context in 1-2
spoken sentences, maximum 30 words. Focus on: what the tool is asking for, any
error or decision. Omit code snippets, file paths, and technical details.
Do not say "the terminal shows" — speak directly.
```

**Example output**: "Claude Code is asking whether you want to proceed with deleting three files in the src directory."

### 7.6 Circuit Breaker per External Dependency

Each external API call site (Deepgram, ElevenLabs) is wrapped in a per-dependency circuit breaker to prevent cascading failures from propagating through the voice pipeline.

**State machine** (implemented in `packages/voice-pipeline/src/circuit-breaker.ts`):

```
 CLOSED ──── 3 failures in 30s ────► OPEN
   ▲                                   │
   │  probe succeeds             60s elapsed
   │                                   │
   └──────────── HALF-OPEN ◄───────────┘
                (1 probe allowed)
```

- **CLOSED**: requests pass through normally. Failure counter resets on success.
- **OPEN**: requests fail immediately without calling the external API. Duration: 60 seconds, then transitions to HALF-OPEN.
- **HALF-OPEN**: one probe request is allowed through. If it succeeds, circuit returns to CLOSED; if it fails, returns to OPEN.

**Failure threshold**: 3 consecutive failures OR 3 failures within any 30-second window.

**Fallback behavior on OPEN circuit**:
- Deepgram circuit open: voice call abandoned; `VoiceCallFailed` event emitted; Telegram notification sent instead (NFR-REL-04).
- ElevenLabs circuit open: same fallback — TTS stage cannot be skipped without degrading call quality.

**Implementation note**: Circuit breaker state is per-process in-memory only; resets to CLOSED on orchestrator restart (intentional for v1).

---

## 8. Telegram Adapter Architecture

### 8.1 Forum Topic Lifecycle

```
 New pane detected (SessionCreated / first PaneOutput)
          │
          ▼
 TelegramAdapter.handleNewPane(paneId, tool, sessionName)
          │
          ├── stateStore.getTopicMap(paneId) → topicId?
          │       │
          │   if found: reuse existing topic (restart recovery)
          │       │
          │   if not found:
          │       ├── bot.api.createForumTopic(groupId, title)
          │       │   title: "<tool> — <paneId> — <date>"
          │       └── stateStore.setTopicMap(paneId, topicId)
          │           (persisted to disk immediately)
          │
          ▼
 PaneExited event received
          │
          ├── send final message to topic: "[exited: code N]"
          └── bot.api.closeForumTopic(groupId, topicId)
              (topic remains accessible in archive; not deleted)
```

### 8.2 Message Routing

```
 Inbound message routing (user → pane):
 ┌─────────────────────────────────────────────────────────┐
 │  grammY message handler                                  │
 │                                                          │
 │  ctx.message.message_thread_id → topicId                │
 │       │                                                  │
 │       ▼                                                  │
 │  stateStore.getPaneByTopicId(topicId) → paneId           │
 │       │                                                  │
 │  if not found: reply "No active session for this topic"  │
 │       │                                                  │
 │  if found:                                               │
 │    tmuxClient.sendKeys(paneId, ctx.message.text)         │
 │    stateStore.setNotificationState(paneId, 'idle')       │
 │    bus.emit({ type: 'InputDelivered', ... })             │
 └─────────────────────────────────────────────────────────┘
```

### 8.3 Output Streaming

**IMPORTANT — verify before Phase 3**: Confirm `sendMessageDraft` existence in the Bot API 9.3+ spec before writing any streaming code (see Section 10, Phase 3 start action). Two paths are documented:

#### Path A: `sendMessageDraft` (preferred, if confirmed available in Bot API 9.3+)

```
 PaneOutput event arrives (bus subscriber)
          │
          ▼
 OutputStreamBuffer[paneId]
   - append ctx.text to buffer
   - if no pending flush timer: schedule flush(paneId) in 100ms (debounce)
          │
          ▼ (100ms later, or buffer > 3000 chars)
 flush(paneId):
   - format buffer as HTML: <pre><code>...</code></pre>
   - truncate/chunk to Telegram limits (see Long Output Strategy)
   - if existing draft message for this topic:
       bot.api.sendMessageDraft(chatId, threadId, draftId, newText)  [update]
   - else:
       bot.api.sendMessageDraft(chatId, threadId, text)  [create new draft]
       store draftId for this paneId
   - reset buffer and timer
          │
          ▼
 On awaiting-input notification:
   - finalize current draft (pin it, or just leave it)
   - send a new discrete message: "Agent is waiting for input..."
   - the notification message is NOT a draft (it must be persistent)
```

#### Path B: `editMessageText` fallback (rate-limit-aware, ~1 edit per 3 seconds per message)

If `sendMessageDraft` is not available, the adapter falls back to sending a regular message and editing it in place with accumulated output.

```
 PaneOutput event arrives (bus subscriber)
          │
          ▼
 OutputStreamBuffer[paneId]
   - append ctx.text to buffer
   - if no pending flush: schedule flush in 3000ms (rate-aware debounce)
   - if buffer > 3000 chars: flush immediately
          │
          ▼
 flush(paneId):
   - format buffer as HTML: <pre><code>...</code></pre>
   - truncate to 4096-char Telegram limit
   - if existing message AND last-edit was < 3s ago:
       re-schedule flush for (3s - elapsed) ms, return
   - if existing message AND last-edit >= 3s:
       bot.api.editMessageText(chatId, messageId, newText)
       record last-edit timestamp
   - if no existing message:
       bot.api.sendMessage(chatId, threadId, text)
       store messageId for this paneId
   - reset buffer and timer
```

**Throttle invariant**: at most 1 `editMessageText` call per 3 seconds per pane-message. On a burst of output, the buffer accumulates and flushes as a single edit — a pane with continuous output shows updates approximately every 3 seconds in Telegram.

### 8.4 Long Output Strategy

```
 Output text length decision tree:

 len(text) <= 4096?
   └── send as regular message in <pre><code>

 4096 < len(text) <= 12000?
   └── split into paragraphs
       first paragraph: <pre><code>...</code></pre>
       remaining text: <blockquote expandable>...</blockquote>
       (collapsed by default, user taps to expand)

 len(text) > 12000?
   └── upload as .txt file attachment
       bot.api.sendDocument(chatId, threadId, {
         source: Buffer.from(text),
         filename: '<paneId>-<timestamp>.txt'
       })
       + short message: "Output too long — see attached file"
```

### 8.5 Rate Limiting Queue

```
 ┌──────────────────────────────────────────────────────────┐
 │                  RateLimitQueue                           │
 │                                                          │
 │  Two buckets enforced via token bucket algorithm:        │
 │                                                          │
 │  Global bucket: 30 API requests/second                   │
 │    - refills at 30 tokens/second                         │
 │    - all Telegram API calls draw from this bucket        │
 │                                                          │
 │  Per-chat bucket: 20 messages/minute per group/topic     │
 │    - separate bucket per chatId+threadId pair            │
 │    - only message-send calls draw from this bucket       │
 │                                                          │
 │  Queue behavior:                                         │
 │    - enqueue(fn: () => Promise<T>): Promise<T>           │
 │    - if bucket has tokens: execute immediately           │
 │    - if bucket empty: enqueue, execute when tokens refill│
 │    - max queue depth: 100 entries (drop oldest on exceed)│
 │                                                          │
 │  sendMessageDraft calls use the global bucket only       │
 │  (they update an existing message, not a new message)    │
 └──────────────────────────────────────────────────────────┘
```

---

## 9. State Persistence

### 9.1 In-Memory State Model

```
StateStore (in memory)
│
├── panes: Map<paneId, PaneState>
│   ├── %0 → PaneState { ... }
│   ├── %1 → PaneState { ... }
│   └── %3 → PaneState { ... }
│
├── topicMap: Map<paneId, topicId>  (Telegram forum topic ID)
│   ├── %0 → 42
│   └── %3 → 87
│
└── sessions: Map<sessionId, SessionInfo>
    ├── $1 → { name: 'main', createdAt: ... }
    └── $2 → { name: 'work', createdAt: ... }
```

`PaneState.xtermInstance` is the only field that is NOT serialized to disk — it is an in-memory object that is recreated on restart.

### 9.2 File-Based Persistence

```
~/.sirko/                    (configurable via SIRKO_DATA_DIR env var)
├── state.json               current runtime state snapshot
├── state.json.bak           previous snapshot (for crash recovery)
└── logs/
    ├── $1/
    │   ├── %0.log           pane output log (append-only)
    │   └── %3.log
    └── $2/
        └── %1.log
```

**`state.json` format**:
```json
{
  "schemaVersion": 1,
  "savedAt": 1234567890123,
  "panes": [
    {
      "paneId": "%3",
      "sessionId": "$1",
      "windowId": "@2",
      "tool": "claude-code",
      "pid": 12345,
      "status": "running",
      "notificationState": "idle",
      "lastOutputTime": 1234567890000,
      "telegramTopicId": 42,
      "schemaVersion": 1,
      "createdAt": 1234567800000,
      "updatedAt": 1234567890000
    }
  ],
  "topicMap": { "%3": 42 },
  "sessions": [
    { "sessionId": "$1", "name": "main", "createdAt": 1234567800000 }
  ]
}
```

**`schemaVersion` field**: Both the top-level `state.json` object and each `PaneState` entry carry a `schemaVersion: number` field (currently `1`). On load, `stateStore.load()` compares the stored `schemaVersion` against the current code version. If they differ, a migration function is applied before populating the in-memory maps. Migration functions are additive-only (never destructive) for v1. If migration fails, the corrupted state file is moved to `state.json.corrupt.<timestamp>` and the store starts empty.

**Persistence schedule**:
- Periodic: every 30 seconds via `setInterval`
- On graceful shutdown: `SIGTERM` / `SIGINT` handler calls `store.persist()` before exit
- Write strategy: write to `state.json.tmp`, then `rename()` to `state.json` (atomic on POSIX)
- Backup: before each write, copy current `state.json` to `state.json.bak`

### 9.3 Recovery on Restart

```
 Orchestrator startup sequence:
 1. stateStore.load()
    ├── read state.json (fall back to state.json.bak if corrupt)
    ├── validate schemaVersion (migrate if needed)
    └── populate in-memory maps
         (xtermInstance = null for all panes — recreated on first output)

 2. TmuxClient.connect()
    ├── attach to existing tmux server
    ├── enumerate current sessions/windows/panes
    └── reconcile against stored panes:
         - pane still exists: update PID, keep topic mapping
         - pane gone: mark as exited, notify Telegram

 3. For each recovered pane:
    ├── re-instantiate @xterm/headless
    ├── call capturePane() to populate xtermBuffer
    └── resume normal pipeline operation
```

### 9.4 When to Introduce Neon DB

The file-based state store is sufficient for v1 (single host, personal use). Introduce Neon (serverless Postgres) only when:
- Audit log querying is needed (e.g., "show all notifications sent last week")
- Multi-host deployment is required (shared state across instances)
- The JSON state file exceeds ~10MB (many pane histories)

If introduced, the `StateStore` interface does not change — a `NeonStateStore` implementation replaces the file-based backend behind the same API. The schema mirrors the JSON format: `panes` table, `topic_map` table, `sessions` table.

---

## 10. Implementation Plan

### Phase 1 — Foundation (Week 1–2)

**Goal**: A working monorepo with tmux event streaming piped through a minimal pipeline.

**Deliverables**:
- Turborepo + Bun workspaces configured; `turbo.json` with `build`, `test`, `typecheck` tasks
- `packages/shared`: all event types, `PaneStatus`, `ToolName` enums
- `packages/tmux-client`: control-mode connect, `%output` parsing, `sendKeys`; mock tmux for tests
- `packages/pipeline`: `compose()`, `EventContext` type, `buildContext()`; logger middleware only
- `packages/state-store`: in-memory `Map`, `PaneState` type, disk persist/load
- `apps/orchestrator`: event loop skeleton — `for await (event of tmuxClient.events())`

**Test criteria**:
- `bun test` passes across all packages
- Manual: attach to a real tmux server, observe `%output` events logged to stdout
- `sendKeys` routes text to a pane
- State persists to disk and reloads on restart

**Spike (Week 1)**:
- `@xterm/headless` Bun compatibility spike: write a minimal test that imports `@xterm/headless` under Bun, writes ANSI escape sequences to it, and reads back the buffer. If the import or buffer-read fails, `BufferEmulator` (line-buffer + `strip-ansi`) is confirmed as the v1 `TerminalEmulator` implementation. Result documented before any xterm-interpret middleware code is written.

**Risks**:
- `@xterm/headless` Bun compatibility — resolved by Week 1 spike above
  - Fallback: `BufferEmulator` using `strip-ansi` (already designed in Section 5)
- Bun workspace dependency resolution edge cases — validate `turbo.json` task graph early

---

### Phase 2 — Core Intelligence (Week 3–4)

**Goal**: The detection pipeline is operational end-to-end. Events flow through all core middleware.

**Deliverables**:
- `packages/detector`: `WchanInspector` (Linux + macOS), `PromptMatcher`, `QuiescenceTracker`
- `packages/tool-plugins`: `SkillDefinition` interface, Claude Code / Codex / Aider built-ins
- `packages/pipeline`: all middleware implemented (`xterm-interpret`, `state-manager`, `detection`, `dedup`, `output-archive`)
- `packages/event-bus`: typed `EventBus` wrapper
- Quiescence scheduler in `apps/orchestrator`
- `notification-fanout` middleware emitting to bus (no subscribers yet — events are logged)

**Test criteria**:
- Unit test: each middleware with mock `EventContext`
- Unit test: `DetectorEngine.computeScore()` with known signal values, verify formula
- Integration test: full pipeline with mock tmux producing a sequence of output events → quiescence → `PaneAwaitingInput` emitted on bus
- Manual: run Claude Code in tmux, observe `PaneAwaitingInput` logged when Claude prompts for input

**Risks**:
- Detection false positives / false negatives during Claude Code usage — require empirical calibration of `quiescenceThresholdMs` and prompt patterns
- macOS wchan via `ps` may be unreliable; build `lsof` fallback in this phase

---

### Phase 3 — Telegram (Week 5–6)

**Goal**: Full Telegram integration. User can monitor pane output and respond to agent prompts via Telegram.

**Phase 3 start action (before writing any streaming code)**:
Verify `sendMessageDraft` existence in the official Telegram Bot API 9.3+ documentation and changelog. If confirmed: implement Path A (Section 8.3). If not available or removed: implement Path B (`editMessageText` with 3-second throttle). This decision gates the output streaming implementation.

**Deliverables**:
- `apps/telegram-bot`: grammY setup, topic lifecycle management, output streaming (Path A or B per spike result)
- Long output handling (expandable blockquotes, file upload)
- Rate-limiting queue (token bucket)
- Bidirectional message routing: inbound Telegram → `tmuxClient.sendKeys`
- `InputDelivered` event emitted on reply; dedup reset

**Test criteria**:
- Unit test: `RateLimitQueue` respects 20 msg/min and 30 req/s limits
- Unit test: message truncation and blockquote splitting at 4096-char boundary
- Integration test: grammY test mode (no real Telegram) — simulate output events, assert formatted messages are produced
- Manual: real Telegram group + real Claude Code session; observe live output in topic and successfully route a reply

**Risks**:
- `sendMessageDraft` API availability — if not yet live on Bot API 9.3, fall back to edit-last-message approach
- Topic creation requires bot admin in supergroup; document setup steps

---

### Phase 4 — Voice MVP (Week 7–8)

**Goal**: Outbound voice calls to the operator when a pane awaits input. User can speak a response.

**Deliverables**:
- `packages/voice-pipeline`: `transcribe()`, `summarize()`, `synthesize()`
- Audio format conversion utilities (μ-law ↔ PCM16)
- `apps/voice-server`: TwilioTransport, Fastify webhook routes, media stream WebSocket
- Outbound call trigger on `PaneAwaitingInput` event
- STT → `sendKeys` routing for spoken replies
- Graceful fallback: Telegram notification if voice fails (NFR-REL-04)

**Test criteria**:
- Unit test: `transcribe()` with recorded Deepgram response fixture
- Unit test: `synthesize()` with mocked ElevenLabs response; verify output is non-empty audio buffer
- Unit test: `summarize()` with terminal context fixture; verify spoken-style output
- Integration test: mock Twilio WebSocket; verify full audio in → text out → TTS audio out pipeline
- Manual: real outbound Twilio call; verify voice prompt and successful spoken reply routing

**Risks**:
- End-to-end latency (target 800ms, acceptable up to 1.5s) — profile each stage against the latency budget in Section 7.4; Deepgram and ElevenLabs are the highest-variance stages
- Twilio μ-law resampling quality — verify transcription quality is acceptable at 8kHz
- ElevenLabs streaming chunk size vs. latency tradeoff needs empirical tuning

---

### Phase 5 — Production Voice (Week 9–10)

**Goal**: LiveKit transport for persistent, low-latency voice connection (iOS-compatible).

**Deliverables**:
- `LiveKitTransport` implementing `VoiceTransport` interface
- Scoped JWT token generation via `livekit-server-sdk`
- LiveKit room lifecycle management in `apps/voice-server`
- iOS CallKit app foundation (or defer if out of scope)
- End-to-end test with LiveKit Cloud

**Test criteria**:
- Unit test: `LiveKitTransport` room creation, token scoping
- Integration test: mock LiveKit WebRTC connection; verify audio stream routing
- Manual: LiveKit Cloud test room; full voice round-trip at target latency

**Spike (Phase 5, Week 9 start)**:
- LiveKit SDK Bun compatibility spike: attempt to import `livekit-server-sdk` and `livekit-agents` under Bun. Test room creation and JWT token generation. If native Node.js add-ons are present, evaluate running the voice-server under Node.js while the rest of the system stays on Bun (cross-process via HTTP). Document result before beginning LiveKit transport implementation.

**Risks**:
- LiveKit Agents SDK Bun compatibility — resolved by Week 9 spike above
  - Fallback: run `apps/voice-server` as a separate Node.js process; the `VoiceTransport` interface boundary makes this transparent to the orchestrator
- iOS CallKit app may be deferred; core voice functionality ships without native app in this phase

---

### Phase 6 — Polish (Week 11–12)

**Goal**: Production readiness, optional web dashboard, operational tooling.

**Deliverables**:
- `apps/web`: React dashboard (session overview, pane status, detection confidence, log viewer) using TanStack Query + TanStack Router
- Operational runbook: startup, configuration, common failure diagnosis
- Schema versioning and migration for `state.json`
- Metrics emission (structured log parsing or lightweight Prometheus endpoint)
- Full documentation review

**Test criteria**:
- E2E test: full scenario from tmux pane creation → agent output → detection → Telegram notification → reply → pane resumed
- Load test: 10 concurrent panes with simulated burst output; verify ≤50ms pipeline latency (NFR-PERF-02) and ≤3s detection latency (NFR-PERF-04)

**Risks**:
- Web dashboard is optional; skip if time-constrained
- Neon DB introduction (if needed) is additive and does not block Phase 6 completion

---

## 11. Testing Strategy

### 11.1 Unit Tests

Each package has its own test suite using Bun's built-in test runner (`bun test`).

**`packages/pipeline` middleware tests**:
- Each middleware function is tested in isolation by constructing a minimal `EventContext` with the relevant fields populated
- `next()` is a mock that records whether it was called
- Assertions: context mutations, side-effect accumulation, `ctx.aborted` state
- Example: `dedup` test — given `ctx.pane.notificationState = 'notified'` and `ctx.detectionResult.awaiting = true`, assert `next` is NOT called and `ctx.aborted = true`

**`packages/detector` unit tests**:
- `WchanInspector`: mock `/proc` filesystem (Bun's fs override or temp files); test Linux and macOS paths
- `PromptMatcher`: given a set of terminal buffer strings, assert correct match/no-match results for each skill's prompt patterns
- `DetectorEngine.computeScore()`: table-driven tests with known signal values; verify weighted formula produces expected scores

**`packages/tool-plugins` unit tests**:
- Validate each `SkillDefinition` has required fields
- `detectTool()`: given mock `ProcessInfo` arrays, assert correct tool identification

**`packages/state-store` unit tests**:
- CRUD operations on in-memory state
- Persistence round-trip: `persist()` → `load()` → assert equality
- Schema migration: load a v0 fixture, assert it is migrated to current schema

**`packages/tmux-client` unit tests**:
- Protocol parser: feed raw control-mode line sequences, assert correct `TmuxEvent` objects produced
- Reconnection: mock a disconnected socket, assert exponential backoff timing

### 11.2 Integration Tests

**Full pipeline with mock tmux** (`apps/orchestrator/test/pipeline-integration.test.ts`):
```
Setup:
  - create StateStore (in-memory, no disk)
  - create EventBus
  - assemble full middleware pipeline
  - create TmuxClient with mock socket (feeds pre-recorded event sequences)

Test scenarios:
  1. "Output burst then quiet": feed 5 PaneOutput events in rapid succession,
     then silence for 2×quiescenceThreshold. Assert: PaneAwaitingInput emitted
     on bus exactly once.

  2. "Prompt pattern match": feed a PaneOutput with a known Claude Code prompt
     pattern in the text. Assert: PaneAwaitingInput emitted before quiescence
     timer fires (high prompt-pattern score alone crosses threshold).

  3. "Dedup suppression": emit PaneAwaitingInput via bus, then feed additional
     PaneOutput events. Assert: second PaneAwaitingInput NOT emitted on bus.

  4. "Input resets dedup": after step 3, send InputDelivered event. Feed more
     output. Assert: next quiescence cycle emits PaneAwaitingInput again.

  5. "PaneExited": feed pane-exited event. Assert: PaneExited emitted on bus;
     PaneState.status = 'exited'.
```

**Telegram adapter test mode** (`apps/telegram-bot/test/adapter-integration.test.ts`):
- Construct TelegramAdapter with a mock `bot.api` that records API calls
- Subscribe to a mock EventBus
- Feed PaneOutput and PaneAwaitingInput events
- Assert: correct API methods called with correct parameters; rate limit respected

**Voice pipeline mock test** (`apps/voice-server/test/voice-integration.test.ts`):
- Construct TwilioTransport with a mock WebSocket
- Feed recorded μ-law audio (a spoken utterance)
- Mock Deepgram to return a known transcript
- Mock ElevenLabs to return a known audio buffer
- Assert: `sendOutboundAudio` is called with audio within the latency budget

### 11.3 E2E Tests

E2E tests run against a real tmux server with a test CLI program (not a real AI agent) that simulates agent behavior:

```bash
# Test fixture: packages/tmux-client/fixtures/fake-agent.sh
#!/usr/bin/env bash
# Simulates an agent: prints output, then waits for input
echo "Analyzing codebase..."
sleep 1
echo "Found 3 issues."
echo "> "   # prompt pattern
read -r user_input
echo "User said: $user_input"
```

**E2E test flow**:
1. Start Sirko orchestrator with a real tmux server (test config)
2. Create a new tmux pane running `fake-agent.sh`
3. Subscribe a test subscriber to the EventBus
4. Assert `PaneAwaitingInput` is emitted within 5 seconds of `> ` appearing
5. Route a response: `tmuxClient.sendKeys(paneId, 'continue')`
6. Assert `InputDelivered` is emitted; assert `PaneState.notificationState = 'idle'`
7. Assert no second `PaneAwaitingInput` is emitted during the final `echo` output

### 11.4 Testing the Voice Pipeline Without Real Phone Calls

```
Level 1 — Mocked transport:
  TwilioTransport replaced with MockTransport
  MockTransport.getInboundAudio() yields pre-recorded PCM audio fixture
  MockTransport.sendOutboundAudio() records received audio
  → Validates full pipeline logic without any network calls

Level 2 — Mocked external APIs:
  Deepgram SDK replaced with MockDeepgram (returns hardcoded transcript)
  ElevenLabs SDK replaced with MockElevenLabs (returns silent audio)
  → Validates pipeline wiring and latency arithmetic

Level 3 — Real APIs, no phone:
  Use Deepgram and ElevenLabs sandbox/test modes
  Feed real PCM audio files as input
  Assert transcript and audio output quality
  → Validates API integration without incurring Twilio call costs

Level 4 — Full E2E (manual):
  Real Twilio outbound call to developer's own phone
  Manual verification of voice quality and latency
  Run once per release, not in CI
```

---

## 12. Security Considerations (v1)

### 12.1 Authentication and Access Control

Sirko v1 has no formal authentication (NFR-SEC-01: deferred). Access is controlled by the following implicit boundaries:

- **Telegram bot**: only users who are members of the configured supergroup can interact with the bot. The supergroup is private. Telegram's platform enforces membership. No additional bot-side user ID allowlist is required for personal use; for small-team use, an explicit allowlist of `userId` values should be added to the grammY middleware (`allow-user.ts`).

- **Voice calls**: outbound calls are placed only to the phone number(s) in `SIRKO_VOICE_AUTHORIZED_NUMBERS` env var. This list is read at startup and treated as immutable. No Telegram message can trigger a call to an arbitrary number (NFR-SEC-06).

- **Twilio webhooks**: all incoming Twilio HTTP requests must pass HMAC-SHA1 signature validation using the Twilio Auth Token (`twilio.validateRequest()`). Requests without a valid signature are rejected with 403 before any processing. This satisfies NFR-SEC-02.

- **LiveKit tokens**: room tokens are generated per-call with minimum required permissions: join a specific room, publish audio, subscribe audio. Tokens expire in 1 hour. No room management permissions are granted (NFR-SEC-03).

### 12.2 Secret Management

All secrets are stored as environment variables. No secrets are committed to source control.

```
Required environment variables:
  TELEGRAM_BOT_TOKEN        grammY bot token
  TELEGRAM_GROUP_ID         supergroup ID for forum topics
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  TWILIO_PHONE_NUMBER       outbound caller ID
  TWILIO_WEBHOOK_BASE_URL   publicly accessible URL for TwiML callbacks
  DEEPGRAM_API_KEY
  ELEVENLABS_API_KEY
  ELEVENLABS_VOICE_ID
  LIVEKIT_URL               (Phase 5)
  LIVEKIT_API_KEY           (Phase 5)
  LIVEKIT_API_SECRET        (Phase 5)
  SIRKO_VOICE_AUTHORIZED_NUMBERS  comma-separated E.164 format numbers
  SIRKO_DATA_DIR            path for state.json and logs (default: ~/.sirko)
  SIRKO_TMUX_SOCKET         path to tmux server socket (default: system default)
```

`.env.example` documents all variables. `.env` is in `.gitignore`. In production, use a secrets manager (1Password, HashiCorp Vault, or the host's secret store).

### 12.3 tmux Socket Permissions

When Sirko manages its own tmux server (rather than attaching to an existing one), the socket is created with restricted permissions:

- Socket path: `~/.sirko/tmux.sock` (owned by the process user)
- File permissions: `0600` (NFR-SEC-05) — only the process owner can read/write
- Socket is NOT in `/tmp` (world-accessible directory)

When attaching to an existing tmux server, Sirko does not change socket permissions. The operator is responsible for ensuring the existing socket has appropriate permissions.

### 12.4 Input Sanitization for `sendKeys`

Text routed from Telegram or voice to `tmuxClient.sendKeys` is sanitized before transmission:

- **Maximum length**: 4096 characters per `sendKeys` call; longer input is truncated with a warning
- **Escape sequences**: the tmux `send-keys` command requires special characters to be escaped. All non-printable characters (control codes, escape sequences) in user-provided text are stripped before sending. The tmux client uses the `-l` (literal) flag where supported to avoid tmux key name interpretation
- **Rate limiting**: `sendKeys` calls are throttled to a maximum of 5 per second per pane to prevent accidental input floods from automated or malformed messages
- **Injection prevention**: text sent via `sendKeys` cannot escape the target pane's terminal context — it is treated as literal keystrokes by the pane process. No shell injection is possible beyond what the user could type manually

### 12.5 Output Log Security

Pane output logs (`~/.sirko/logs/`) may contain sensitive information (API keys, credentials) that the CLI agent printed to its terminal.

- Log directory permissions: `0700` (only process owner)
- Log files: `0600`
- Logs are not transmitted to any remote service — they are local-only append files
- The voice pipeline terminal context snapshot (sent to the LLM for summarization) is limited to the last ~2000 characters of output, reducing the risk of inadvertently sending long credential-containing output to an LLM API. The prompt explicitly instructs the LLM to omit technical details from its voice summary.

### 12.6 Threat Model Summary (v1)

| Threat | Severity | Mitigation |
|---|---|---|
| Unauthorized Telegram access | Low | Private group membership enforced by Telegram platform |
| Spoofed Twilio webhook | High | HMAC-SHA1 signature validation on all webhook requests |
| Voice call to arbitrary number | High | Static `SIRKO_VOICE_AUTHORIZED_NUMBERS` allowlist; no dynamic number input |
| Exposed secrets in source/logs | High | Env vars only; `.gitignore`; logs are local only |
| Input injection via sendKeys | Medium | Literal flag; control-char stripping; rate limiting |
| Credential exfiltration via LLM | Low | 2000-char context cap; summarization prompt strips technical details |
| tmux socket unauthorized access | Medium | `0600` permissions; socket in user home directory |

---

## 13. Runtime Topology

### 13.1 Single-Process Design (v1)

Sirko v1 runs as a **single process**. Despite the monorepo containing `apps/orchestrator`, `apps/telegram-bot`, and `apps/voice-server` as separate packages, these are **not** separate processes — they are libraries imported and wired together inside `apps/orchestrator`.

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                  SINGLE PROCESS: apps/orchestrator                       │
 │                                                                          │
 │   ┌──────────────────────────────────────────────────────────────────┐  │
 │   │  orchestrator/src/index.ts  (entry point)                        │  │
 │   │                                                                  │  │
 │   │  import { createTelegramAdapter } from 'apps/telegram-bot'       │  │
 │   │  import { createVoiceServer }     from 'apps/voice-server'       │  │
 │   │                                                                  │  │
 │   │  ┌──────────────────────┐  ┌──────────────────────────────────┐  │  │
 │   │  │  telegram-bot        │  │  voice-server                    │  │  │
 │   │  │  (imported library)  │  │  (imported library)              │  │  │
 │   │  │                      │  │                                  │  │  │
 │   │  │  grammY bot          │  │  TwilioTransport / LiveKit       │  │  │
 │   │  │  Telegram API calls  │  │  Fastify webhook routes          │  │  │
 │   │  └──────────┬───────────┘  └──────────────┬───────────────────┘  │  │
 │   │             │                             │                       │  │
 │   │             └──────────────┬──────────────┘                       │  │
 │   │                            │                                      │  │
 │   │                     EventBus (in-process)                         │  │
 │   │                     single shared instance                        │  │
 │   │                                                                  │  │
 │   └──────────────────────────────────────────────────────────────────┘  │
 │                                                                          │
 │   Single Bun process   PID: <N>   Port: 3000 (Twilio webhooks)          │
 └─────────────────────────────────────────────────────────────────────────┘
```

### 13.2 Key Invariants

- **`apps/orchestrator` is the sole entry point**: `bun run apps/orchestrator/src/index.ts` starts the entire system.
- **`apps/telegram-bot` and `apps/voice-server` are libraries**: their `index.ts` exports factory functions (`createTelegramAdapter`, `createVoiceServer`) that accept the shared `EventBus`, `StateStore`, and `TmuxClient` as constructor arguments. They do not have their own `bun run` entry points in v1.
- **EventBus is in-process by design**: `bus.emit()` dispatches synchronously within the same Bun event loop turn. There is no serialization, no IPC, and no network hop. This is the correct design for a single-host personal tool.
- **Port exposure**: only one HTTP port is opened — for Twilio TwiML webhook callbacks. The Telegram bot uses long polling (no inbound port required).

### 13.3 Future Multi-Process Path (post-v1)

If the system needs to scale beyond a single host (e.g., `telegram-bot` on a different machine), the `EventBus` interface can be swapped for a distributed event bus (Redis Pub/Sub, NATS) without changing the adapter code — the `AdapterSink` interface and `SirkoEvent` discriminated union remain the same. This is the value of the EventBus abstraction seam.

---

## 14. Backpressure & Queueing

Without explicit backpressure controls, bursty tmux output from 10+ concurrent panes could overwhelm the single-threaded pipeline. This section documents the five backpressure mechanisms built into the system.

### 14.1 Per-Pane Output Coalescing (50ms window)

**Problem**: A CLI agent printing rapidly can emit dozens of `%output` events per second per pane. Running the full middleware pipeline for each event at 10+ panes = hundreds of pipeline executions per second.

**Solution**: The `TmuxClient` (or a coalescing layer at the orchestrator event loop entry) batches `%output` events for the same pane within a 50ms window into a single `PaneOutputEvent` with concatenated `raw` text. Only one pipeline execution runs per pane per 50ms window.

```
 %output %3 "line 1"   ─┐
 %output %3 "line 2"    ├── within 50ms → single PaneOutputEvent { raw: "line1
line2
line3" }
 %output %3 "line 3"   ─┘

 %output %4 "other"    ─── separate event for different pane (not coalesced with %3)
```

**Implementation**: `Map<paneId, { buffer: string; timer: ReturnType<typeof setTimeout> }>` in the event-loop layer. On each `%output`, append to buffer and (re)set a 50ms timer. On timer fire, emit a single coalesced event.

### 14.2 Per-Pane Pipeline Serialization (Mutex)

**Problem**: Even after coalescing, rapid events for the same pane could have a second pipeline run start before the first completes (e.g., a quiescence check fires while an output event is still in the detection middleware). This could bypass deduplication and produce duplicate `PaneAwaitingInput` events.

**Solution**: A `Map<PaneId, Promise<void>>` serialization lock. Before starting a pipeline run for a pane, chain it onto the existing promise for that pane. This ensures at-most-one concurrent pipeline execution per pane.

```typescript
// In apps/orchestrator/src/index.ts
const paneQueue = new Map<string, Promise<void>>()

function enqueueForPane(paneId: string, run: () => Promise<void>): void {
  const existing = paneQueue.get(paneId) ?? Promise.resolve()
  const next = existing.then(run).catch(err => logger.error('pipeline error', err))
  paneQueue.set(paneId, next)
}
```

**Concurrency invariant**: Pipeline runs for the same pane are always sequential. Runs for different panes are concurrent. This exploits Bun's single-threaded model — no actual thread synchronization is needed; the `Promise` chain provides the ordering guarantee.

### 14.3 Bounded EventBus Queue per Subscriber

**Problem**: If a slow adapter subscriber (e.g., the Telegram adapter is blocked on a rate-limit wait) falls behind on processing `PaneOutput` events, the in-process event queue grows unboundedly.

**Solution**: The `EventBus` wrapper maintains a per-subscriber bounded queue with a configurable capacity (default: 1000 events). When the queue is full, the **oldest event is dropped** (head-drop strategy). A `QueueDropped` warning is logged with the dropped event type and subscriber name.

```
 Subscriber queue (capacity: 1000):
 [oldest] ← head-drop on overflow   [newest] ← new events enqueue here
```

**Drop strategy**: `PaneOutput` events are dropped preferentially over `PaneAwaitingInput` events (output is lossy by design — some terminal output not appearing in Telegram is acceptable; missing an awaiting-input notification is not). The EventBus subscriber can declare an event priority hint to influence drop order.

**Non-critical sinks**: The logger sink uses an unbounded queue (it is never slow) and the file output-archive writes are fire-and-forget (non-blocking).

### 14.4 Telegram Rate-Limit Queue (Token Bucket)

**Problem**: Telegram Bot API enforces 20 messages/minute per group/topic and 30 API calls/second globally. Exceeding these limits causes 429 errors and potential bot bans.

**Solution**: Token bucket algorithm in `RateLimitQueue` (Section 8.5). Two token buckets:
- Global: 30 tokens/second, refills at 30/s
- Per-chat (per `chatId+threadId`): 20 tokens/minute, refills at 20/60s

Queued calls wait for token availability. Max queue depth: 100 entries per bucket. On overflow: drop oldest entry, log warning.

**For output streaming**: `sendMessageDraft` updates (Path A) or `editMessageText` calls (Path B) consume from the global bucket only — they do not count toward per-chat message limits. This allows continuous output streaming without hitting the per-chat 20/minute cap.

### 14.5 Voice Call Queue (Max 1 Active + Queue)

**Problem**: If multiple panes trigger `PaneAwaitingInput` simultaneously, the system should not initiate multiple concurrent outbound calls (which would be confusing to the user and waste Twilio resources).

**Solution**: A simple call queue in `apps/voice-server`:
- Maximum 1 active call at a time
- Subsequent `PaneAwaitingInput` events are queued (FIFO, max depth: 5; drop oldest on overflow)
- When the active call ends (`VoiceCallEnded`), the next queued notification is dequeued and a new call is initiated
- If `InputDelivered` is received for a queued (not yet active) pane, it is removed from the queue without initiating a call

```
 PaneAwaitingInput(pane A) → call initiated for A (active)
 PaneAwaitingInput(pane B) → queued [B]
 PaneAwaitingInput(pane C) → queued [B, C]
 VoiceCallEnded(pane A)    → dequeue B, initiate call for B
 InputDelivered(pane C)    → remove C from queue; no call needed
 VoiceCallEnded(pane B)    → queue empty; system idle
```

**Telegram fallback during queue overflow**: If the voice call queue is full (5 pending), additional `PaneAwaitingInput` events are routed as Telegram notifications only (no voice call queued).

---

*End of Sirko architecture document.*
*Full design saved at: /Users/jack/mag/magai/sirko/ai-docs/sessions/dev-arch-20260316-124106-081b4c45/architecture.md*
