# Sirko — Concrete Implementation Plan

**Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Architecture Source**: dev-arch-20260316-124106-081b4c45/architecture.md (validated, approved)
**Date**: 2026-03-16
**Stack**: Bun + TypeScript strict + Turborepo + Bun workspaces

> This document translates the validated architecture into a phase-by-phase coding plan. The architecture is already finalized — do NOT re-design. Implement exactly as specified.

---

## 1. Monorepo Scaffold

### 1.1 Root Directory Layout

Every file listed below must exist before `bun install` succeeds and `turbo build` produces output.

```
sirko/
├── package.json                    (root — workspace host, no source code)
├── turbo.json                      (pipeline: build, test, typecheck, lint, format)
├── tsconfig.base.json              (strict TS config inherited by all packages)
├── .env.example                    (all required env vars documented)
├── .gitignore
│
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── events.ts
│   │       ├── types.ts
│   │       └── utils.ts
│   │
│   ├── tmux-client/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── client.ts
│   │       ├── parser.ts
│   │       ├── coalescer.ts
│   │       └── types.ts
│   │
│   ├── pipeline/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── compose.ts
│   │       ├── context.ts
│   │       └── middleware/
│   │           ├── xterm-interpret.ts
│   │           ├── state-manager.ts
│   │           ├── detection.ts
│   │           ├── dedup.ts
│   │           ├── notification-fanout.ts
│   │           ├── output-archive.ts
│   │           └── logger.ts
│   │
│   ├── event-bus/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── bus.ts
│   │
│   ├── detector/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── engine.ts
│   │       ├── wchan.ts
│   │       ├── prompt-matcher.ts
│   │       └── quiescence.ts
│   │
│   ├── tool-plugins/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts
│   │       ├── registry.ts
│   │       ├── detect.ts
│   │       └── plugins/
│   │           ├── claude-code.ts
│   │           ├── codex.ts
│   │           ├── aider.ts
│   │           └── unknown.ts
│   │
│   ├── state-store/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── store.ts
│   │       └── migrations.ts
│   │
│   └── voice-pipeline/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── transcribe.ts
│           ├── summarize.ts
│           ├── synthesize.ts
│           ├── audio-convert.ts
│           ├── circuit-breaker.ts
│           ├── sentence-buffer.ts
│           ├── transport.ts
│           └── prompts/
│               └── terminal-summary.txt
│
└── apps/
    ├── orchestrator/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts
    │       ├── pipeline.ts
    │       ├── config.ts
    │       └── scheduler.ts
    │
    ├── telegram-bot/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts
    │       ├── adapter.ts
    │       ├── topic-manager.ts
    │       ├── output-buffer.ts
    │       ├── rate-limit-queue.ts
    │       └── format.ts
    │
    ├── voice-server/
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts
    │       ├── adapter.ts
    │       ├── call-queue.ts
    │       └── transports/
    │           ├── twilio.ts
    │           └── livekit.ts
    │
    └── web/
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── main.tsx
            ├── router.tsx
            └── routes/
                └── index.tsx
```

### 1.2 Root `package.json`

```json
{
  "name": "sirko",
  "private": true,
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "format": "turbo run format",
    "dev": "turbo run dev --parallel",
    "start": "bun run apps/orchestrator/src/index.ts"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.4.0",
    "@types/bun": "latest"
  }
}
```

### 1.3 `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"],
      "env": [
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_GROUP_ID",
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_PHONE_NUMBER",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
        "ELEVENLABS_VOICE_ID",
        "SIRKO_DATA_DIR",
        "SIRKO_TMUX_SOCKET"
      ]
    },
    "lint": {
      "outputs": []
    },
    "format": {
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

### 1.4 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["bun-types"]
  }
}
```

### 1.5 Per-Package `tsconfig.json` (template — same for every package/app)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

For packages nested two levels deep (`packages/*`): path is `../../tsconfig.base.json`.
For apps (`apps/*`): path is `../../tsconfig.base.json`.

### 1.6 Per-Package `package.json` Templates

**Library package** (e.g., `packages/shared`):
```json
{
  "name": "@sirko/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "lint": "echo 'no linter configured'",
    "format": "echo 'no formatter configured'"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

For Bun workspaces, set `"main"` and `"exports"` to the TypeScript source directly — Bun resolves `.ts` files without a build step during development. The `build` script compiles for distribution only.

**App package** (e.g., `apps/orchestrator`):
```json
{
  "name": "@sirko/orchestrator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts",
    "lint": "echo 'no linter configured'",
    "format": "echo 'no formatter configured'"
  },
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@sirko/tmux-client": "workspace:*",
    "@sirko/pipeline": "workspace:*",
    "@sirko/event-bus": "workspace:*",
    "@sirko/detector": "workspace:*",
    "@sirko/tool-plugins": "workspace:*",
    "@sirko/state-store": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

### 1.7 `.env.example`

```bash
# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_ID=

# Twilio (Voice MVP)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_WEBHOOK_BASE_URL=

# Deepgram (STT)
DEEPGRAM_API_KEY=

# ElevenLabs (TTS)
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=

# LiveKit (Phase 5, production voice)
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# Sirko
SIRKO_VOICE_AUTHORIZED_NUMBERS=+15555550100
SIRKO_DATA_DIR=~/.sirko
SIRKO_TMUX_SOCKET=
SIRKO_LOG_LEVEL=info
```

### 1.8 `.gitignore`

```
node_modules/
dist/
.env
*.env.local
.sirko/
coverage/
*.js.map
```

### 1.9 Verification: monorepo works

After creating all scaffold files, run:
```bash
bun install
turbo run typecheck
```
Both must exit 0 before any phase work begins.

---

## 2. Implementation Phases

---

### Phase 1: Monorepo Scaffold + Shared Types

**Depends on**: nothing (first phase)
**Packages**: root scaffold + `packages/shared`
**Estimated session time**: ~25 minutes

**Files to create**:
```
package.json
turbo.json
tsconfig.base.json
.env.example
.gitignore
packages/shared/package.json
packages/shared/tsconfig.json
packages/shared/src/index.ts
packages/shared/src/events.ts
packages/shared/src/types.ts
packages/shared/src/utils.ts
packages/shared/src/events.test.ts
```

**Key types/interfaces in `packages/shared/src/types.ts`**:

```typescript
export type PaneStatus = 'running' | 'awaiting-input' | 'idle' | 'exited'

export type ToolName = 'claude-code' | 'codex' | 'aider' | 'unknown'

export type Platform = 'macos' | 'linux'

export interface PaneState {
  paneId: string
  sessionId: string
  windowId: string
  tool: ToolName
  pid: number | null
  status: PaneStatus
  exitCode: number | null
  notificationState: 'idle' | 'notified'
  lastNotifiedAt: number | null
  lastOutputTime: number
  processingCount: number
  xtermInstance: TerminalEmulator | null   // NOT serialized to disk; use TerminalEmulator from @sirko/shared
  lastBufferSnapshot: string
  telegramTopicId: number | null
  schemaVersion: number
  createdAt: number
  updatedAt: number
}

export interface SessionInfo {
  sessionId: string
  name: string
  createdAt: number
}

export interface CursorState {
  row: number
  col: number
  visible: boolean
}

export interface SignalBreakdown {
  promptPattern: { matched: boolean; pattern: string | null; weight: number; contribution: number }
  wchan:         { value: string | null; isWaiting: boolean; weight: number; contribution: number }
  quiescence:    { silenceMs: number; threshold: number; weight: number; contribution: number }
}

export interface DetectionResult {
  score: number
  awaiting: boolean
  tool: ToolName
  confidence: number
  signals: SignalBreakdown
}

export interface AudioFormat {
  codec: 'mulaw' | 'pcm16' | 'opus'
  sampleRate: 8000 | 16000 | 48000
  channels: 1 | 2
}

export interface ProcessInfo {
  pid: number
  ppid: number
  name: string
  argv: string[]
}

// Terminal emulator abstraction — defined in @sirko/shared (not @sirko/tmux-client) so PaneState
// can reference it without a circular dependency.
export interface TerminalEmulator {
  write(raw: string): void
  getBuffer(): string       // current full screen as plain text
  getCursor(): CursorState
}

// Adapter sink contract — both TelegramAdapter and VoiceAdapter must implement this interface.
// The orchestrator maintains an AdapterSink[] array for uniform start/stop lifecycle management.
export interface AdapterSink {
  readonly name: string
  handlePaneOutput(event: Extract<SirkoEvent, { type: 'PaneOutput' }>): Promise<void>
  handlePaneAwaitingInput(event: Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>): Promise<void>
  handlePaneExited(event: Extract<SirkoEvent, { type: 'PaneExited' }>): Promise<void>
  handleInputDelivered(event: Extract<SirkoEvent, { type: 'InputDelivered' }>): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  isHealthy(): boolean
}```

**Key types in `packages/shared/src/events.ts`**:

```typescript
export type SirkoEvent =
  | {
      type: 'PaneOutput'
      paneId: string
      sessionId: string
      text: string
      raw: string
      timestamp: number
    }
  | {
      type: 'PaneAwaitingInput'
      paneId: string
      sessionId: string
      tool: ToolName
      confidence: number
      score: number
      context: string
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
      callSid: string
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

**Key functions in `packages/shared/src/utils.ts`**:

```typescript
export function formatTimestamp(ms: number): string
export function truncateForTelegram(text: string, maxLen?: number): string
export function paneIdFromString(raw: string): string | null
export function sanitizeForSendKeys(text: string): string
```

**Test targets** (`packages/shared/src/events.test.ts`):
- Assert every SirkoEvent `type` string is unique (prevent discriminant collision)
- Assert `truncateForTelegram` respects the 4096-char limit
- Assert `sanitizeForSendKeys` strips control characters

**Quality gate**:
```bash
cd packages/shared && bun test
turbo run typecheck --filter=@sirko/shared
```

---

### Phase 2: State Store

**Depends on**: Phase 1
**Packages**: `packages/state-store`
**Estimated session time**: ~30 minutes

**Files to create**:
```
packages/state-store/package.json
packages/state-store/tsconfig.json
packages/state-store/src/index.ts
packages/state-store/src/store.ts
packages/state-store/src/migrations.ts
packages/state-store/src/store.test.ts
```

**Package dependencies** (add to `packages/state-store/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*"
  }
}
```

**Key types in `packages/state-store/src/store.ts`**:

```typescript
export interface StateStoreOptions {
  persistPath: string     // path to state.json directory (e.g., ~/.sirko)
  persistIntervalMs?: number  // default 30000
}

export interface PersistedState {
  schemaVersion: number
  savedAt: number
  panes: Omit<PaneState, 'xtermInstance'>[]
  topicMap: Record<string, number>
  sessions: SessionInfo[]
}
```

**Key class: `StateStore`** in `packages/state-store/src/store.ts`:

```typescript
export class StateStore {
  constructor(options: StateStoreOptions)

  // Pane CRUD — synchronous, in-memory
  getPane(paneId: string): PaneState | undefined
  setPane(paneId: string, state: PaneState): void
  deletePane(paneId: string): void
  allPanes(): PaneState[]

  // Topic map — synchronous, in-memory
  getTopicId(paneId: string): number | undefined
  setTopicId(paneId: string, topicId: number): void
  getPaneByTopicId(topicId: number): string | undefined

  // Session info — synchronous, in-memory
  getSession(sessionId: string): SessionInfo | undefined
  setSession(sessionId: string, info: SessionInfo): void
  allSessions(): SessionInfo[]

  // Notification state helpers
  setNotificationState(paneId: string, state: 'idle' | 'notified'): void

  // Persistence — async
  persist(): Promise<void>
  load(): Promise<void>

  // Lifecycle
  startAutoSave(): void   // starts setInterval for periodic persist
  stopAutoSave(): void
}

export function createStateStore(options: StateStoreOptions): StateStore
```

**Persistence implementation details** (in `store.ts`):
- Write path: `{persistPath}/state.json.tmp` then `rename()` to `{persistPath}/state.json` (atomic)
- Before each write: copy `state.json` to `state.json.bak`
- `xtermInstance` field is always `null` in serialized form
- Create directory `{persistPath}/logs/` if it does not exist

**Migration function signature** in `packages/state-store/src/migrations.ts`:

```typescript
export function migrate(raw: unknown): PersistedState
// - Accepts any shape loaded from disk (unknown)
// - Returns current-schema PersistedState
// - If schemaVersion == current: return as-is
// - If schemaVersion < current: apply incremental migrations
// - If parse fails: throw MigrationError (caller handles by discarding)
```

**Test targets** (`packages/state-store/src/store.test.ts`):
- `setPane` / `getPane` round-trip
- `setTopicId` / `getPaneByTopicId` reverse lookup
- `persist()` + `load()` round-trip (use `tmpdir()` as persistPath)
- `persist()` creates `.bak` file
- `load()` on missing file: starts with empty state (no throw)
- `load()` on corrupt JSON: starts with empty state (no throw)
- `migrate()` with a v0 fixture produces valid current-schema output

**Quality gate**:
```bash
cd packages/state-store && bun test
turbo run typecheck --filter=@sirko/state-store
```

---

### Phase 3: tmux Client

**Depends on**: Phase 1 (shared types), Phase 2 (state-store for integration test setup)
**Packages**: `packages/tmux-client`
**Estimated session time**: ~30 minutes

**Files to create**:
```
packages/tmux-client/package.json
packages/tmux-client/tsconfig.json
packages/tmux-client/src/index.ts
packages/tmux-client/src/types.ts
packages/tmux-client/src/client.ts
packages/tmux-client/src/parser.ts
packages/tmux-client/src/coalescer.ts
packages/tmux-client/src/parser.test.ts
packages/tmux-client/src/coalescer.test.ts
packages/tmux-client/fixtures/fake-agent.sh
```

**Package dependencies** (`packages/tmux-client/package.json`):
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

**Key types in `packages/tmux-client/src/types.ts`**:

```typescript
export type TmuxEvent =
  | { type: 'pane-output';     paneId: string; sessionId: string; raw: string; timestamp: number }
  | { type: 'pane-exited';     paneId: string; sessionId: string }
  | { type: 'session-created'; sessionId: string; name: string }
  | { type: 'session-closed';  sessionId: string }
  | { type: 'window-add';      windowId: string; sessionId: string }
  | { type: 'window-close';    windowId: string; sessionId: string }
  | { type: 'quiescence-check'; paneId: string; sessionId: string }  // synthetic

export interface TmuxClientOptions {
  socketPath?: string          // if omitted: use tmux default
  reconnectInitialMs?: number  // default 1000
  reconnectMaxMs?: number      // default 30000
  coalesceWindowMs?: number    // default 50
}

// TerminalEmulator is defined in @sirko/shared/src/types.ts and re-exported here for convenience.
// This avoids a circular dependency: @sirko/shared cannot depend on @sirko/tmux-client.
export type { TerminalEmulator } from '@sirko/shared'
```

**Key class: `TmuxClient`** in `packages/tmux-client/src/client.ts`:

```typescript
export class TmuxClient {
  constructor(options?: TmuxClientOptions)

  // Connect to tmux control mode; spawns `tmux -C attach` or `tmux -C new-session`
  connect(): Promise<void>

  // Async generator: yields TmuxEvents as they arrive from control-mode stdin
  events(): AsyncGenerator<TmuxEvent>

  // Send keystrokes to a pane (uses `send-keys -t <paneId> -l <text>`)
  sendKeys(paneId: string, text: string): Promise<void>

  // Pane management
  capturePane(paneId: string): Promise<string>       // returns plain text content
  getPanePid(paneId: string): Promise<number | null>

  // Session/window/pane creation
  newSession(name: string): Promise<string>    // returns sessionId
  newWindow(sessionId: string): Promise<string> // returns windowId
  newPane(windowId: string): Promise<string>   // returns paneId

  // Enumerate current state
  listSessions(): Promise<Array<{ sessionId: string; name: string }>>
  listPanes(): Promise<Array<{ paneId: string; windowId: string; sessionId: string }>>

  // Reconnect with exponential backoff (called internally on disconnect)
  disconnect(): Promise<void>

  // Create a TerminalEmulator for a pane.
  // Attempts XtermEmulator first; falls back to BufferEmulator if @xterm/headless fails.
  createTerminalEmulator(): TerminalEmulator
}

export function createTmuxClient(options?: TmuxClientOptions): TmuxClient
```

**Parser (`packages/tmux-client/src/parser.ts`)** — parses raw control-mode lines:

```typescript
// Parses a single line from tmux control-mode output
// Returns null for lines that are not actionable events (e.g., %begin/%end delimiters)
export function parseControlModeLine(line: string): TmuxEvent | null

// Examples of lines parsed:
//   "%output %3 line of output\n"   → { type: 'pane-output', paneId: '%3', raw: 'line of output\n' }
//   "%pane-exited %3 $1"            → { type: 'pane-exited', paneId: '%3', sessionId: '$1' }
//   "%session-created $1 main"      → { type: 'session-created', sessionId: '$1', name: 'main' }
//   "%session-closed $1"            → { type: 'session-closed', sessionId: '$1' }
//   "%window-add @2"                → { type: 'window-add', windowId: '@2', sessionId: ... }
//   "%window-close @2"              → { type: 'window-close', windowId: '@2', sessionId: ... }

// Unescapes tmux's control-mode output encoding:
//   \\ → backslash, \n → newline, \r → carriage return
export function unescapeTmuxOutput(raw: string): string
```

**Coalescer (`packages/tmux-client/src/coalescer.ts`)**:

```typescript
// Coalesces rapid %output events for the same pane within a time window.
// Calls onEvent with a single merged PaneOutputEvent per window per pane.
export class OutputCoalescer {
  constructor(windowMs: number, onEvent: (event: TmuxEvent) => void)
  push(event: Extract<TmuxEvent, { type: 'pane-output' }>): void
  flush(): void  // force-flush all pending buffers (for shutdown)
}
```

**`fake-agent.sh` fixture** (`packages/tmux-client/fixtures/fake-agent.sh`):
```bash
#!/usr/bin/env bash
# Simulates an AI agent: prints output, then blocks waiting for input
echo "Analyzing codebase..."
sleep 1
echo "Found 3 issues."
printf "> "   # prompt — no newline, cursor stays at end
read -r user_input
echo "User said: $user_input"
echo "Done."
```

**Test targets**:

`packages/tmux-client/src/parser.test.ts`:
- `parseControlModeLine('%output %3 hello world')` returns correct event
- `parseControlModeLine('%pane-exited %3 $1')` returns correct event
- `parseControlModeLine('%session-created $1 main')` returns correct event
- `parseControlModeLine('%begin 123 456 1')` returns null
- `unescapeTmuxOutput('line1\\nline2')` returns `'line1\nline2'`
- `unescapeTmuxOutput('back\\\\slash')` returns `'back\\slash'`

`packages/tmux-client/src/coalescer.test.ts`:
- Three rapid events for same pane → single callback with concatenated raw
- Events for different panes → separate callbacks each
- Window timeout fires callback even without a new event

**Quality gate**:
```bash
cd packages/tmux-client && bun test
turbo run typecheck --filter=@sirko/tmux-client
# Manual spike: bun run packages/tmux-client/src/index.ts (requires tmux running)
# Observe: events logged to stdout when a pane produces output
```

---

### Phase 4: Event Bus + Tool Plugins

**Depends on**: Phase 1
**Packages**: `packages/event-bus`, `packages/tool-plugins`
**Estimated session time**: ~20 minutes

#### `packages/event-bus`

**Files to create**:
```
packages/event-bus/package.json
packages/event-bus/tsconfig.json
packages/event-bus/src/index.ts
packages/event-bus/src/bus.ts
packages/event-bus/src/bus.test.ts
```

**Package dependencies** (`packages/event-bus/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*"
  }
}
```

**Key class: `EventBus`** in `packages/event-bus/src/bus.ts`:

```typescript
export type UnsubscribeFn = () => void

export interface EventBusOptions {
  subscriberQueueCapacity?: number  // default 1000
}

export class EventBus {
  constructor(options?: EventBusOptions)

  // Emit a typed event — dispatches synchronously to all subscribers
  emit<T extends SirkoEvent>(event: T): void

  // Subscribe to events of a specific type
  on<K extends SirkoEvent['type']>(
    type: K,
    handler: (event: Extract<SirkoEvent, { type: K }>) => void | Promise<void>
  ): UnsubscribeFn

  // Subscribe to next event of a specific type, then unsubscribe
  once<K extends SirkoEvent['type']>(
    type: K,
    handler: (event: Extract<SirkoEvent, { type: K }>) => void | Promise<void>
  ): UnsubscribeFn

  // Unsubscribe all handlers for a type
  off(type: SirkoEvent['type']): void
}

export function createEventBus(options?: EventBusOptions): EventBus
```

**Test targets** (`packages/event-bus/src/bus.test.ts`):
- `emit` calls all registered handlers for that event type
- `emit` does NOT call handlers for other event types
- `once` handler fires exactly once
- `UnsubscribeFn` returned by `on` stops future calls when invoked
- Async handler errors are caught and do not crash the bus
- Handler receives correctly typed payload (TypeScript compile-time check via `tsc --noEmit`)

#### `packages/tool-plugins`

**Files to create**:
```
packages/tool-plugins/package.json
packages/tool-plugins/tsconfig.json
packages/tool-plugins/src/index.ts
packages/tool-plugins/src/types.ts
packages/tool-plugins/src/registry.ts
packages/tool-plugins/src/detect.ts
packages/tool-plugins/src/plugins/claude-code.ts
packages/tool-plugins/src/plugins/codex.ts
packages/tool-plugins/src/plugins/aider.ts
packages/tool-plugins/src/plugins/unknown.ts
packages/tool-plugins/src/registry.test.ts
packages/tool-plugins/src/detect.test.ts
```

**Package dependencies** (`packages/tool-plugins/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*"
  }
}
```

**Key interface: `SkillDefinition`** in `packages/tool-plugins/src/types.ts`:

```typescript
export interface SkillDefinition {
  name: ToolName
  displayName: string

  // Process identification
  binaryPattern: RegExp
  processNamePattern: RegExp

  // Prompt pattern signal
  promptPatterns: RegExp[]
  promptPatternWeight: number        // 0.0–1.0

  // Quiescence signal
  quiescenceThresholdMs: number
  quiescenceWeight: number           // 0.0–1.0

  // Wait-channel signal
  wchanWaitValues: string[]
  wchanWeight: number                // 0.0–1.0

  // Aggregation
  scoringThreshold: number           // weighted score threshold (0.0–1.0)

  // Behavior hooks
  preInputDelayMs?: number           // ms to wait before routing input
  inputSuffix?: string               // appended to input (e.g., '\n')
  outputStreamingDelayMs?: number    // ms debounce for output burst
}
```

**Built-in skills** — exact values to use:

`packages/tool-plugins/src/plugins/claude-code.ts`:
```typescript
export const claudeCodeSkill: SkillDefinition = {
  name: 'claude-code',
  displayName: 'Claude Code',
  binaryPattern: /claude$/i,
  processNamePattern: /claude/i,
  promptPatterns: [/^> $/m, /^❯ $/m, /^> \s*$/m],
  promptPatternWeight: 0.45,
  quiescenceThresholdMs: 1800,
  quiescenceWeight: 0.20,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read', 'futex'],
  wchanWeight: 0.35,
  scoringThreshold: 0.60,
  inputSuffix: '\n',
}
```

`packages/tool-plugins/src/plugins/aider.ts`:
```typescript
export const aiderSkill: SkillDefinition = {
  name: 'aider',
  displayName: 'Aider',
  binaryPattern: /aider$/i,
  processNamePattern: /aider/i,
  promptPatterns: [/^> /m, /\(y\/n\)/i, /\[Yes\]/i, /\[No\]/i],
  promptPatternWeight: 0.50,
  quiescenceThresholdMs: 3000,
  quiescenceWeight: 0.20,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read'],
  wchanWeight: 0.30,
  scoringThreshold: 0.55,
  inputSuffix: '\n',
}
```

`packages/tool-plugins/src/plugins/codex.ts`:
```typescript
export const codexSkill: SkillDefinition = {
  name: 'codex',
  displayName: 'Codex CLI',
  binaryPattern: /codex$/i,
  processNamePattern: /codex/i,
  promptPatterns: [/^\? /m, /Continue\?/i, /Proceed\?/i],
  promptPatternWeight: 0.55,
  quiescenceThresholdMs: 1500,
  quiescenceWeight: 0.15,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read'],
  wchanWeight: 0.30,
  scoringThreshold: 0.65,
  inputSuffix: '\n',
}
```

`packages/tool-plugins/src/plugins/unknown.ts`:
```typescript
export const unknownSkill: SkillDefinition = {
  name: 'unknown',
  displayName: 'Unknown Tool',
  binaryPattern: /.*/,
  processNamePattern: /.*/,
  promptPatterns: [/^> /m, /^\? /m, /\(y\/n\)/i],
  promptPatternWeight: 0.50,
  quiescenceThresholdMs: 2000,
  quiescenceWeight: 0.20,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read', 'futex'],
  wchanWeight: 0.30,
  scoringThreshold: 0.60,
}
```

**Key functions** in `packages/tool-plugins/src/registry.ts`:

```typescript
export function getSkill(toolName: ToolName): SkillDefinition
// Returns the SkillDefinition for the given tool name.
// Falls back to unknownSkill if not found.
```

**Key function** in `packages/tool-plugins/src/detect.ts`:

```typescript
export function detectTool(processes: ProcessInfo[]): ToolName
// Iterates registered skills in priority order (claude-code, codex, aider).
// Matches against binaryPattern and processNamePattern on each ProcessInfo.
// Returns the first match or 'unknown'.
```

**Test targets**:
- `getSkill('claude-code')` returns the claude-code skill
- `getSkill('nonexistent' as ToolName)` returns unknownSkill
- `detectTool([{ name: 'claude', argv: ['/usr/local/bin/claude'], ... }])` returns `'claude-code'`
- `detectTool([{ name: 'aider', argv: ['/usr/bin/aider'], ... }])` returns `'aider'`
- `detectTool([{ name: 'bash', argv: ['/bin/bash'], ... }])` returns `'unknown'`
- Each SkillDefinition has all required fields (validation test)
- promptPatternWeight + wchanWeight + quiescenceWeight are all > 0 for each skill

**Quality gate**:
```bash
turbo run test --filter=@sirko/event-bus
turbo run test --filter=@sirko/tool-plugins
turbo run typecheck --filter=@sirko/event-bus
turbo run typecheck --filter=@sirko/tool-plugins
```

---

### Phase 5: Detector + Pipeline Core

**Depends on**: Phase 1, 2, 4
**Packages**: `packages/detector`, `packages/pipeline`
**Estimated session time**: ~35 minutes

#### `packages/detector`

**Files to create**:
```
packages/detector/package.json
packages/detector/tsconfig.json
packages/detector/src/index.ts
packages/detector/src/engine.ts
packages/detector/src/wchan.ts
packages/detector/src/prompt-matcher.ts
packages/detector/src/quiescence.ts
packages/detector/src/engine.test.ts
packages/detector/src/wchan.test.ts
packages/detector/src/prompt-matcher.test.ts
```

**Package dependencies** (`packages/detector/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@sirko/tool-plugins": "workspace:*",
    "@sirko/state-store": "workspace:*"
  }
}
```

**Key class: `WchanInspector`** in `packages/detector/src/wchan.ts`:

```typescript
export interface WchanInspector {
  readWchan(pid: number): Promise<string | null>
}

// Linux: reads /proc/<pid>/wchan
export class LinuxWchan implements WchanInspector {
  readWchan(pid: number): Promise<string | null>
  // Returns null if file not found (process exited)
  // Uses Bun.file(`/proc/${pid}/wchan`).text()
}

// macOS: runs `ps -o wchan= -p <pid>`, caches result for 500ms
export class MacosWchan implements WchanInspector {
  constructor(cacheMs?: number)  // default 500
  readWchan(pid: number): Promise<string | null>
}

// Factory: returns correct inspector for current platform
export function createWchanInspector(): WchanInspector
// platform detection: process.platform === 'linux' ? LinuxWchan : MacosWchan
```

**Key class: `PromptMatcher`** in `packages/detector/src/prompt-matcher.ts`:

```typescript
export class PromptMatcher {
  // Check whether any of the skill's promptPatterns match the given buffer text
  match(buffer: string, skill: SkillDefinition): { matched: boolean; pattern: string | null }
  // Tests each pattern against buffer. Returns first match or { matched: false, pattern: null }.
}
```

**Key class: `QuiescenceTracker`** in `packages/detector/src/quiescence.ts`:

```typescript
export class QuiescenceTracker {
  // Returns quiescence signal score in [0, 1].
  // score = min(silenceMs / skill.quiescenceThresholdMs, 1.0)
  computeScore(pane: PaneState, skill: SkillDefinition): {
    silenceMs: number
    threshold: number
    score: number
  }
}
```

**Key class: `DetectorEngine`** in `packages/detector/src/engine.ts`:

```typescript
export interface DetectorEngineOptions {
  wchanInspector?: WchanInspector   // injectable for testing
}

export class DetectorEngine {
  constructor(options?: DetectorEngineOptions)

  // Main method: computes weighted detection score for a pane
  computeScore(
    pane: PaneState,
    xtermBuffer: string,
    skill: SkillDefinition
  ): Promise<DetectionResult>

  // Scoring formula:
  //   score = (S_prompt * skill.promptPatternWeight)
  //         + (S_wchan  * skill.wchanWeight)
  //         + (S_quiescence * skill.quiescenceWeight)
  //   awaiting = score >= skill.scoringThreshold
}
```

**Test targets**:
- `DetectorEngine.computeScore()` with all three signals returning 1.0 → score = sum of weights, awaiting = true
- `DetectorEngine.computeScore()` with all signals 0.0 → score = 0.0, awaiting = false
- `PromptMatcher.match('> ', claudeCodeSkill)` → `{ matched: true, pattern: ... }`
- `PromptMatcher.match('computing...', claudeCodeSkill)` → `{ matched: false, pattern: null }`
- `QuiescenceTracker.computeScore()` with silenceMs = threshold → score = 1.0
- `QuiescenceTracker.computeScore()` with silenceMs = 0 → score = 0.0
- `LinuxWchan.readWchan()` with a temp file simulating `/proc/<pid>/wchan` → returns file content
- `MacosWchan.readWchan()` is tested with a mock child process spawn

#### `packages/pipeline`

**Files to create**:
```
packages/pipeline/package.json
packages/pipeline/tsconfig.json
packages/pipeline/src/index.ts
packages/pipeline/src/compose.ts
packages/pipeline/src/context.ts
packages/pipeline/src/middleware/xterm-interpret.ts
packages/pipeline/src/middleware/state-manager.ts
packages/pipeline/src/middleware/detection.ts
packages/pipeline/src/middleware/dedup.ts
packages/pipeline/src/middleware/notification-fanout.ts
packages/pipeline/src/middleware/output-archive.ts
packages/pipeline/src/middleware/logger.ts
packages/pipeline/src/compose.test.ts
packages/pipeline/src/middleware/dedup.test.ts
packages/pipeline/src/middleware/detection.test.ts
packages/pipeline/src/middleware/notification-fanout.test.ts
```

**Package dependencies** (`packages/pipeline/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@sirko/state-store": "workspace:*",
    "@sirko/tool-plugins": "workspace:*",
    "@sirko/event-bus": "workspace:*",
    "@sirko/detector": "workspace:*",
    "@sirko/tmux-client": "workspace:*"
  },
  "optionalDependencies": {
    "@xterm/headless": "^5.0.0",
    "strip-ansi": "^7.1.0"
  }
}
```

**Key types in `packages/pipeline/src/context.ts`**:

```typescript
export type SideEffect =
  | { kind: 'send-keys';    paneId: string; text: string }
  | { kind: 'file-append';  path: string;   content: string }
  | { kind: 'bus-emit';     event: SirkoEvent }
  | { kind: 'telegram-api'; method: string; params: unknown }

export interface EventContext {
  readonly event: TmuxEvent
  readonly startedAt: number           // Date.now() milliseconds at context creation

  pane: PaneState | null               // null for session events

  // Populated by xterm-interpret (pane-output events only)
  parsedText?: string
  cursorState?: CursorState
  xtermBuffer?: string

  // Populated by detection middleware
  detectionResult?: DetectionResult

  // Pipeline control
  aborted: boolean
  sideEffects: SideEffect[]
  middlewareDurations: Record<string, number>
}

export function buildContext(event: TmuxEvent, pane: PaneState | null): EventContext
// Creates a fresh EventContext with defaults: aborted=false, sideEffects=[], etc.

export function buildQuiescenceContext(pane: PaneState): EventContext
// Creates a synthetic quiescence-check context (event.type = 'quiescence-check')
```

**Key types and functions in `packages/pipeline/src/compose.ts`**:

```typescript
export type Middleware = (ctx: EventContext, next: () => Promise<void>) => Promise<void>

export interface Pipeline {
  run(ctx: EventContext): Promise<void>
}

export function compose(middlewares: Middleware[]): Pipeline
// Koa-style compose: calls each middleware in order, passing next() to advance.
// Returns a Pipeline with a run() method.
// If a middleware does not call next(), remaining middleware do not execute.
```

**Middleware signatures** (each file exports a factory function):

`packages/pipeline/src/middleware/xterm-interpret.ts`:
```typescript
export interface XtermInterpretOptions {
  emulatorType?: 'xterm' | 'buffer'  // 'buffer' = degraded BufferEmulator fallback
}
export function createXtermInterpretMiddleware(
  tmuxClient: TmuxClient,
  options?: XtermInterpretOptions
): Middleware
// - Runs AFTER state-manager (which populates ctx.pane); requires ctx.pane to be set
// - Only acts on pane-output events; calls next() immediately for others
// - Retrieves or lazily creates TerminalEmulator from pane.xtermInstance
// - Sets ctx.parsedText, ctx.cursorState, ctx.xtermBuffer
// - On error: sets ctx.parsedText = ctx.event.raw (fallback); calls next()
```

`packages/pipeline/src/middleware/state-manager.ts`:
```typescript
export function createStateManagerMiddleware(store: StateStore, tmuxClient: TmuxClient): Middleware
// PRE (before next()): load pane from store → ctx.pane; increment processingCount
// POST (after next()): write ctx.pane back to store; decrement processingCount
// Uses try/finally to ensure POST always runs
```

`packages/pipeline/src/middleware/detection.ts`:
```typescript
export function createDetectionMiddleware(engine: DetectorEngine): Middleware
// Reads ctx.pane, ctx.xtermBuffer
// Calls engine.computeScore(pane, xtermBuffer, skill)
// Sets ctx.detectionResult, ctx.pane.status (if awaiting)
// Only runs for pane-output and quiescence-check events
```

`packages/pipeline/src/middleware/dedup.ts`:
```typescript
export function createDedupMiddleware(): Middleware
// If ctx.pane.notificationState == 'notified' AND ctx.detectionResult.awaiting:
//   sets ctx.aborted = true; returns WITHOUT calling next()
// If ctx.pane.notificationState == 'notified' AND NOT awaiting:
//   resets notificationState to 'idle'; calls next()
// Otherwise: calls next()
```

`packages/pipeline/src/middleware/notification-fanout.ts`:
```typescript
export function createNotificationFanoutMiddleware(bus: EventBus): Middleware
// Always emits PaneOutput event (for pane-output events)
// If !ctx.aborted && ctx.detectionResult?.awaiting: emits PaneAwaitingInput; sets notificationState='notified'
// For pane-exited events: emits PaneExited
// Records bus-emit in ctx.sideEffects
```

`packages/pipeline/src/middleware/output-archive.ts`:
```typescript
export interface OutputArchiveOptions {
  logDir: string   // base directory, e.g., ~/.sirko/logs
}
export function createOutputArchiveMiddleware(options: OutputArchiveOptions): Middleware
// Appends ctx.parsedText to {logDir}/{sessionId}/{paneId}.log
// Format: "[<ISO8601>] <text>\n"
// Fire-and-forget (does not await disk flush)
// On pane-exited: appends "[<ISO8601>] [exited: code <N>]\n"
```

`packages/pipeline/src/middleware/logger.ts`:
```typescript
export function createLoggerMiddleware(): Middleware
// Runs after all other middleware (last in compose array)
// Emits one JSON line to stdout per event processed
// JSON shape:
// {
//   "ts": number,
//   "event": string,
//   "paneId": string | undefined,
//   "sessionId": string | undefined,
//   "tool": ToolName | undefined,
//   "detectionScore": number | undefined,
//   "awaiting": boolean | undefined,
//   "aborted": boolean,
//   "durations": Record<string, number>,
//   "totalMs": number
// }
// Swallows all errors (must never crash the pipeline)
```

**Test targets**:
- `compose([m1, m2, m3])`: all three called in order with correct ctx
- `compose`: if m2 does NOT call next(), m3 is NOT called
- `dedup`: `notified + awaiting` → aborted=true, next NOT called
- `dedup`: `notified + not awaiting` → notificationState reset to 'idle', next called
- `dedup`: `idle + awaiting` → next called, aborted=false
- `notification-fanout`: awaiting+not aborted → PaneAwaitingInput emitted on bus
- `notification-fanout`: aborted → PaneAwaitingInput NOT emitted
- `notification-fanout`: always emits PaneOutput for pane-output events
- `detection`: computeScore called with correct pane and buffer

**Quality gate**:
```bash
turbo run test --filter=@sirko/detector
turbo run test --filter=@sirko/pipeline
turbo run typecheck --filter=@sirko/detector
turbo run typecheck --filter=@sirko/pipeline
```

---

### Phase 6: Orchestrator (Main App)

**Depends on**: Phase 2, 3, 4, 5
**Packages**: `apps/orchestrator`
**Estimated session time**: ~30 minutes

**Files to create**:
```
apps/orchestrator/package.json
apps/orchestrator/tsconfig.json
apps/orchestrator/src/index.ts
apps/orchestrator/src/config.ts
apps/orchestrator/src/pipeline.ts
apps/orchestrator/src/scheduler.ts
apps/orchestrator/test/pipeline-integration.test.ts
```

**Package dependencies** (`apps/orchestrator/package.json`):
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

> **Note (Phase 7 integration)**: Add  to the dependencies above.
> **Note (Phase 8 integration)**: Add  to the dependencies above.

**Config schema** in `apps/orchestrator/src/config.ts`:

```typescript
export interface OrchestratorConfig {
  // Data storage
  dataDir: string           // from SIRKO_DATA_DIR, default ~/.sirko
  logDir: string            // derived: dataDir/logs

  // tmux
  tmuxSocketPath: string | undefined   // from SIRKO_TMUX_SOCKET

  // Quiescence scheduler
  quiescenceCheckIntervalMs: number    // default 500

  // Coalescing
  outputCoalesceWindowMs: number       // default 50

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error'  // from SIRKO_LOG_LEVEL
}

export function loadConfig(): OrchestratorConfig
// Reads from process.env; applies defaults; throws if required vars are missing
```

**Pipeline assembly** in `apps/orchestrator/src/pipeline.ts`:

```typescript
export interface PipelineDeps {
  store: StateStore
  bus: EventBus
  tmuxClient: TmuxClient
  config: OrchestratorConfig
}

export function assemblePipeline(deps: PipelineDeps): Pipeline
// Creates all middleware with correct deps and returns compose([...]) result
// Order: [state-manager, xterm-interpret, detection, dedup, notification-fanout, output-archive, logger]
// NOTE: state-manager MUST come before xterm-interpret because xterm-interpret reads ctx.pane.xtermInstance,
//       which state-manager loads from the store in its PRE phase.
```

**Quiescence scheduler** in `apps/orchestrator/src/scheduler.ts`:

```typescript
export class QuiescenceScheduler {
  constructor(
    store: StateStore,
    pipeline: Pipeline,
    intervalMs: number
  )
  start(): void    // calls setInterval
  stop(): void     // calls clearInterval
}
// Every intervalMs:
//   for each pane in store.allPanes():
//     const elapsed = Date.now() - pane.lastOutputTime
//     const skill = getSkill(pane.tool)
//     if elapsed >= skill.quiescenceThresholdMs
//     && pane.processingCount === 0
//     && pane.status !== 'awaiting-input'
//     && pane.status !== 'exited':
//       pipeline.run(buildQuiescenceContext(pane))
```

**Main entry point** in `apps/orchestrator/src/index.ts`:

```typescript
// Startup sequence:
// 1. loadConfig()
// 2. createStateStore(config.dataDir) → await store.load()
// 3. createEventBus()
// 4. createTmuxClient({ socketPath: config.tmuxSocketPath })
// 5. await tmuxClient.connect()
// 6. Reconcile restored panes with current tmux state (capturePane for each)
// 7. assemblePipeline({ store, bus, tmuxClient, config })
// 8. Register telegram and voice adapters on EventBus (Phase 7, 8)
//    (Phase 6: just log events to stdout)
// 9. new QuiescenceScheduler(store, pipeline, config.quiescenceCheckIntervalMs).start()
// 10. store.startAutoSave()
// 11. Register SIGTERM/SIGINT handlers:
//       scheduler.stop()
//       store.stopAutoSave()
//       await store.persist()
//       await tmuxClient.disconnect()
//       process.exit(0)
// 12. for await (const event of tmuxClient.events()):
//       enqueueForPane(event.paneId ?? 'session', () => pipeline.run(buildContext(event, null)))
// NOTE: Pass null as pane — state-manager middleware loads the PaneState from the store in its PRE phase.

// Per-pane serialization queue:
const paneQueue = new Map<string, Promise<void>>()
function enqueueForPane(key: string, run: () => Promise<void>): void {
  const existing = paneQueue.get(key) ?? Promise.resolve()
  const next = existing.then(run).catch(err => console.error('pipeline error', err))
  paneQueue.set(key, next)
}
```

**Integration test** (`apps/orchestrator/test/pipeline-integration.test.ts`):

Five scenarios (implemented as `describe` / `test` blocks with Bun's test runner):

1. **"Output burst then quiescence"**: Create StateStore (in-memory, tmpdir), EventBus, TmuxClient with a mock event source (an AsyncGenerator yielding pre-recorded events). Feed 5 pane-output events rapidly, then trigger quiescence manually via scheduler. Assert `PaneAwaitingInput` emitted on bus exactly once.

2. **"Prompt pattern fires before quiescence"**: Feed one pane-output event with `> ` in the raw text. Assert `PaneAwaitingInput` emitted immediately (before any quiescence timer, because prompt pattern score alone crosses threshold — requires adjusting test skill weights to ensure this).

3. **"Dedup suppression"**: After `PaneAwaitingInput` is emitted (notificationState = 'notified'), feed additional pane-output events. Assert no second `PaneAwaitingInput`.

4. **"Input resets dedup"**: After step 3, fire `InputDelivered` event via bus (simulating user reply). Trigger quiescence. Assert `PaneAwaitingInput` fires again.

5. **"PaneExited"**: Feed a pane-exited event. Assert `PaneExited` emitted on bus. Assert `PaneState.status === 'exited'`.

**Quality gate**:
```bash
turbo run test --filter=@sirko/orchestrator
turbo run typecheck --filter=@sirko/orchestrator
# Manual smoke test:
bun run apps/orchestrator/src/index.ts
# (requires tmux running; observe events logged as JSON to stdout)
```

---

### Phase 7: Telegram Bot Adapter

**Depends on**: Phase 1, 2, 4, 6
**Packages**: `apps/telegram-bot`
**Estimated session time**: ~35 minutes

**Files to create**:
```
apps/telegram-bot/package.json
apps/telegram-bot/tsconfig.json
apps/telegram-bot/src/index.ts
apps/telegram-bot/src/adapter.ts
apps/telegram-bot/src/topic-manager.ts
apps/telegram-bot/src/output-buffer.ts
apps/telegram-bot/src/rate-limit-queue.ts
apps/telegram-bot/src/format.ts
apps/telegram-bot/test/adapter.test.ts
apps/telegram-bot/test/rate-limit-queue.test.ts
apps/telegram-bot/test/format.test.ts
```

**Package dependencies** (`apps/telegram-bot/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@sirko/event-bus": "workspace:*",
    "@sirko/state-store": "workspace:*",
    "@sirko/tmux-client": "workspace:*",
    "grammy": "^1.27.0"
  }
}
```

**Key class: `RateLimitQueue`** in `apps/telegram-bot/src/rate-limit-queue.ts`:

```typescript
export interface RateLimitQueueOptions {
  globalRps: number           // requests per second, default 30
  perChatMpm: number          // messages per minute per chat, default 20
  maxQueueDepth: number       // default 100
}

export class RateLimitQueue {
  constructor(options?: RateLimitQueueOptions)

  // Enqueue a Telegram API call. Resolves when the call completes.
  // Deducts from global token bucket for all calls.
  // Deducts from per-chat bucket for sendMessage/editMessageText calls.
  enqueue<T>(
    fn: () => Promise<T>,
    opts?: { chatId?: string | number; countAsMessage?: boolean }
  ): Promise<T>
}
```

**Token bucket implementation**: use a simple counter that resets on a timer. For each bucket:
- Keep `tokens: number` and `lastRefill: number`
- On each `enqueue`: call `refill()` first (add tokens proportional to elapsed time), then check if tokens > 0; if yes, decrement and execute; if no, queue the call for later.
- Queued calls are executed when the next `setInterval` tick refills tokens.

**Key class: `OutputStreamBuffer`** in `apps/telegram-bot/src/output-buffer.ts`:

```typescript
export interface OutputStreamBufferOptions {
  debounceMs: number       // default 100 for Path A (sendMessageDraft), 3000 for Path B (edit)
  maxBufferChars: number   // default 3000 (flush early if exceeded)
  onFlush: (paneId: string, text: string) => Promise<void>
}

export class OutputStreamBuffer {
  constructor(options: OutputStreamBufferOptions)
  push(paneId: string, text: string): void    // append text, (re)start debounce timer
  flush(paneId: string): void                 // force immediate flush
  flushAll(): void                            // flush all panes (shutdown)
}
```

**Key formatting functions** in `apps/telegram-bot/src/format.ts`:

```typescript
// Returns one of three formats based on text length:
// - len <= 4096: '<pre><code>' + escapeHtml(text) + '</code></pre>'
// - 4096 < len <= 12000: first 4096 chars as <pre>, rest as <blockquote expandable>
// - len > 12000: returns null (caller should send as file)
export function formatOutput(text: string): string | null

// Format an awaiting-input notification message (HTML)
export function formatAwaitingInput(tool: ToolName, confidence: number, contextSnippet: string): string

// Escape HTML special chars for Telegram HTML parse mode
export function escapeHtml(text: string): string
```

**Key class: `TopicManager`** in `apps/telegram-bot/src/topic-manager.ts`:

```typescript
export class TopicManager {
  constructor(bot: Bot, store: StateStore, groupId: number)

  // Returns existing topicId or creates a new forum topic
  ensureTopic(paneId: string, tool: ToolName, sessionName: string): Promise<number>

  // Closes the forum topic (marks as archived, not deleted)
  closeTopic(paneId: string): Promise<void>
}
```

**Key class: `TelegramAdapter`** in `apps/telegram-bot/src/adapter.ts`:

```typescript
export interface TelegramAdapterOptions {
  botToken: string
  groupId: number
  streamingMode?: 'draft' | 'edit'   // from TELEGRAM_STREAMING_MODE env var; default 'edit'
}

export class TelegramAdapter implements AdapterSink {
  constructor(
    options: TelegramAdapterOptions,
    store: StateStore,
    bus: EventBus,
    tmuxClient: TmuxClient
  )

  start(): Promise<void>   // initializes bot, subscribes to bus events, starts polling
  stop(): Promise<void>

  // EventBus handlers (called by bus.on subscriptions)
  private handlePaneOutput(event: Extract<SirkoEvent, { type: 'PaneOutput' }>): void
  private handlePaneAwaitingInput(event: Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>): Promise<void>
  private handlePaneExited(event: Extract<SirkoEvent, { type: 'PaneExited' }>): Promise<void>

  // grammY message handler (user reply in topic → sendKeys)
  private handleIncomingMessage(ctx: Context): Promise<void>
}

export function createTelegramAdapter(
  options: TelegramAdapterOptions,
  store: StateStore,
  bus: EventBus,
  tmuxClient: TmuxClient
): TelegramAdapter
```

**Bus subscription setup** (inside `TelegramAdapter.start()`):
```typescript
bus.on('PaneOutput', (e) => this.handlePaneOutput(e))
bus.on('PaneAwaitingInput', (e) => this.handlePaneAwaitingInput(e))
bus.on('PaneExited', (e) => this.handlePaneExited(e))
```

**sendMessageDraft vs editMessageText**: implement BOTH paths behind a feature flag `TELEGRAM_STREAMING_MODE=draft|edit`. Default to `edit` until `sendMessageDraft` is confirmed available in Bot API 9.3+. The flag controls which OutputStreamBuffer debounce timing and flush method is used.

**Test targets**:

`apps/telegram-bot/test/rate-limit-queue.test.ts`:
- 30 rapid calls finish in >= 1 second (global rate limit respected)
- Per-chat: 21 message calls to same chatId → 21st is delayed by ~3 seconds
- Queue overflow: 101 enqueued calls → 1st is dropped; 100 remain

`apps/telegram-bot/test/format.test.ts`:
- `formatOutput('x'.repeat(100))` → contains `<pre><code>`
- `formatOutput('x'.repeat(5000))` → contains `<blockquote expandable>`
- `formatOutput('x'.repeat(13000))` → returns null
- `escapeHtml('<b>&"test"</b>')` → `'&lt;b&gt;&amp;&quot;test&quot;&lt;/b&gt;'`

`apps/telegram-bot/test/adapter.test.ts`:
- Mock `bot.api` that records calls; feed `PaneOutput` event → assert `sendMessage` or `editMessageText` called with correct chatId and threadId
- Feed `PaneAwaitingInput` → assert notification message sent
- Mock Telegram incoming message in topic → assert `tmuxClient.sendKeys` called with message text
- Feed `PaneExited` → assert topic closed

**Integration with orchestrator**: in `apps/orchestrator/src/index.ts`, after bus is created:
```typescript
import { createTelegramAdapter } from '@sirko/telegram-bot'
const telegramAdapter = createTelegramAdapter(
  { botToken: process.env.TELEGRAM_BOT_TOKEN!, groupId: Number(process.env.TELEGRAM_GROUP_ID!) },
  store, bus, tmuxClient
)
await telegramAdapter.start()
```

**Library exports** (`apps/telegram-bot/src/index.ts`) — module API used by the orchestrator:
```typescript
export { TelegramAdapter, createTelegramAdapter } from './adapter'
export type { TelegramAdapterOptions } from './adapter'
// TelegramAdapter implements AdapterSink from @sirko/shared
```

**Note**: When integrating Phase 7, update  to add:
```json
"@sirko/telegram-bot": "workspace:*"
```

**Quality gate**:
```bash
turbo run test --filter=@sirko/telegram-bot
turbo run typecheck --filter=@sirko/telegram-bot
# Manual test: TELEGRAM_BOT_TOKEN=... TELEGRAM_GROUP_ID=... bun run apps/orchestrator/src/index.ts
# Then run fake-agent.sh in a tmux pane; observe Telegram topic receiving output + await-input notification
```

---

### Phase 8: Voice Pipeline + Voice Server (Twilio MVP)

**Depends on**: Phase 1, 2, 4, 6
**Packages**: `packages/voice-pipeline`, `apps/voice-server`
**Estimated session time**: ~35 minutes

#### `packages/voice-pipeline`

**Files to create**:
```
packages/voice-pipeline/package.json
packages/voice-pipeline/tsconfig.json
packages/voice-pipeline/src/index.ts
packages/voice-pipeline/src/transport.ts
packages/voice-pipeline/src/transcribe.ts
packages/voice-pipeline/src/summarize.ts
packages/voice-pipeline/src/synthesize.ts
packages/voice-pipeline/src/audio-convert.ts
packages/voice-pipeline/src/circuit-breaker.ts
packages/voice-pipeline/src/sentence-buffer.ts
packages/voice-pipeline/src/prompts/terminal-summary.txt
packages/voice-pipeline/test/transcribe.test.ts
packages/voice-pipeline/test/synthesize.test.ts
packages/voice-pipeline/test/circuit-breaker.test.ts
packages/voice-pipeline/test/audio-convert.test.ts
```

**Package dependencies** (`packages/voice-pipeline/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@deepgram/sdk": "^3.9.0",
    "elevenlabs": "^1.50.0",
    "ai": "^4.0.0"
  }
}
```

**Transport interface** in `packages/voice-pipeline/src/transport.ts`:

```typescript
export interface VoiceTransport {
  readonly name: 'twilio' | 'livekit'
  readonly inboundFormat: AudioFormat
  readonly outboundFormat: AudioFormat

  initiateCall(to: string, callbackUrl: string): Promise<string>  // returns callSid
  hangup(callId: string): Promise<void>
  getInboundAudio(callId: string): AsyncIterable<Buffer>
  sendOutboundAudio(callId: string, audio: AsyncIterable<Buffer>): Promise<void>
  onCallConnected(callId: string, handler: () => void): void
  onCallEnded(callId: string, handler: (reason: string) => void): void
}
```

**Transcribe function** in `packages/voice-pipeline/src/transcribe.ts`:

```typescript
export interface TranscribeOptions {
  deepgramApiKey: string
  model?: string            // default 'nova-2'
  language?: string         // default 'en'
}

// Streams PCM16 audio to Deepgram; yields final transcript segments
export async function* transcribe(
  audioStream: AsyncIterable<Buffer>,
  opts: TranscribeOptions
): AsyncGenerator<string>
```

**Summarize function** in `packages/voice-pipeline/src/summarize.ts`:

```typescript
export interface SummarizeOptions {
  modelId?: string         // default 'openai/gpt-4o-mini' or similar fast model
  maxTokens?: number       // default 100
}

// Uses Vercel AI SDK generateText() to produce a spoken summary of terminal context
export async function summarize(
  terminalContext: string,
  opts: SummarizeOptions
): Promise<string>
// Reads system prompt from prompts/terminal-summary.txt
```

**`prompts/terminal-summary.txt`** content:
```
You are a voice assistant reading terminal output aloud. The user is a developer
who is away from their computer. Summarize the following terminal context in 1-2
spoken sentences, maximum 30 words. Focus on: what the tool is asking for, any
error or decision. Omit code snippets, file paths, and technical details.
Do not say "the terminal shows" — speak directly.
```

**Synthesize function** in `packages/voice-pipeline/src/synthesize.ts`:

```typescript
export interface SynthesizeOptions {
  elevenlabsApiKey: string
  voiceId: string
  modelId?: string         // default 'eleven_turbo_v2'
  outputFormat?: string    // default 'pcm_16000'
}

// Streams text to ElevenLabs; yields PCM16 audio chunks
export async function* synthesize(
  text: string,
  opts: SynthesizeOptions
): AsyncGenerator<Buffer>
```

**Circuit breaker** in `packages/voice-pipeline/src/circuit-breaker.ts`:

```typescript
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerOptions {
  failureThreshold: number   // default 3
  windowMs: number           // default 30000
  openDurationMs: number     // default 60000
}

export class CircuitBreaker {
  constructor(name: string, options?: CircuitBreakerOptions)

  readonly state: CircuitState

  // Wrap a function call. Throws CircuitOpenError if circuit is OPEN.
  execute<T>(fn: () => Promise<T>): Promise<T>
}

export class CircuitOpenError extends Error {
  constructor(name: string)
}
```

**Audio conversion** in `packages/voice-pipeline/src/audio-convert.ts`:

```typescript
// Convert μ-law (G.711) encoded buffer to PCM16 at a new sample rate
export function mulawToPcm16(mulaw: Buffer, inputSampleRate: 8000): Buffer

// Resample PCM16 audio from one sample rate to another (linear interpolation)
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer

// Convert PCM16 to μ-law (G.711)
export function pcm16ToMulaw(pcm: Buffer): Buffer
```

**Sentence boundary buffer** in `packages/voice-pipeline/src/sentence-buffer.ts`:

```typescript
export interface SentenceBufferOptions {
  minChunkChars?: number   // default 80; don't flush until accumulated this many chars
}

// Accumulates text tokens; yields complete sentences for TTS
export class SentenceBoundaryBuffer {
  constructor(options?: SentenceBufferOptions)
  push(token: string): string | null  // returns a sentence to synthesize, or null
  flush(): string | null              // force-flush remaining buffer
}
```

#### `apps/voice-server`

**Files to create**:
```
apps/voice-server/package.json
apps/voice-server/tsconfig.json
apps/voice-server/src/index.ts
apps/voice-server/src/adapter.ts
apps/voice-server/src/call-queue.ts
apps/voice-server/src/transports/twilio.ts
apps/voice-server/src/transports/livekit.ts
apps/voice-server/test/voice-adapter.test.ts
```

**Package dependencies** (`apps/voice-server/package.json`):
```json
{
  "dependencies": {
    "@sirko/shared": "workspace:*",
    "@sirko/event-bus": "workspace:*",
    "@sirko/state-store": "workspace:*",
    "@sirko/voice-pipeline": "workspace:*",
    "@sirko/tmux-client": "workspace:*",
    "twilio": "^5.3.0",
    "livekit-server-sdk": "^2.6.0",
    "fastify": "^5.1.0"
  }
}
```

**Key class: `CallQueue`** in `apps/voice-server/src/call-queue.ts`:

```typescript
export interface CallQueueOptions {
  maxActive?: number     // default 1
  maxQueued?: number     // default 5
}

export class CallQueue {
  constructor(options?: CallQueueOptions)
  enqueue(paneId: string, handler: () => Promise<void>): boolean  // false if queue full
  remove(paneId: string): boolean     // remove from queue (if not yet active)
  onCallEnded(): void                 // called when active call completes; dequeues next
}
```

**Key class: `TwilioTransport`** in `apps/voice-server/src/transports/twilio.ts`:

```typescript
export interface TwilioTransportOptions {
  accountSid: string
  authToken: string
  phoneNumber: string
  webhookBaseUrl: string
}

export class TwilioTransport implements VoiceTransport {
  constructor(options: TwilioTransportOptions)
  readonly name = 'twilio'
  readonly inboundFormat: AudioFormat = { codec: 'mulaw', sampleRate: 8000, channels: 1 }
  readonly outboundFormat: AudioFormat = { codec: 'mulaw', sampleRate: 8000, channels: 1 }

  // Registers Fastify route handlers for TwiML callbacks and WebSocket media stream
  registerRoutes(fastify: FastifyInstance): void

  // Validates Twilio request HMAC signature; throws if invalid
  validateSignature(req: FastifyRequest): void

  initiateCall(to: string, callbackUrl: string): Promise<string>
  hangup(callId: string): Promise<void>
  getInboundAudio(callId: string): AsyncIterable<Buffer>
  sendOutboundAudio(callId: string, audio: AsyncIterable<Buffer>): Promise<void>
  onCallConnected(callId: string, handler: () => void): void
  onCallEnded(callId: string, handler: (reason: string) => void): void
}
```

**`apps/voice-server/src/transports/livekit.ts`**: Stub only in Phase 8. Exports a `LiveKitTransport` class that implements `VoiceTransport` but throws `NotImplementedError` on all methods. Full implementation in Phase 9 (post-v1 scope, not part of this session plan).

**Key class: `VoiceAdapter`** in `apps/voice-server/src/adapter.ts`:

```typescript
export interface VoiceAdapterOptions {
  transport: VoiceTransport
  authorizedNumbers: string[]    // E.164 format phone numbers
  httpPort?: number              // from SIRKO_VOICE_HTTP_PORT env var; default 3000
  deepgramApiKey: string
  elevenlabsApiKey: string
  elevenlabsVoiceId: string
}

export class VoiceAdapter implements AdapterSink {
  constructor(
    options: VoiceAdapterOptions,
    store: StateStore,
    bus: EventBus,
    tmuxClient: TmuxClient
  )

  start(): Promise<void>   // subscribes to bus events, starts Fastify server on options.httpPort (default 3000)
  stop(): Promise<void>

  private handlePaneAwaitingInput(event: Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>): void
  private handleInputDelivered(event: Extract<SirkoEvent, { type: 'InputDelivered' }>): void
}

export function createVoiceAdapter(
  options: VoiceAdapterOptions,
  store: StateStore,
  bus: EventBus,
  tmuxClient: TmuxClient
): VoiceAdapter
```

**Voice call flow** (inside `handlePaneAwaitingInput`):
1. Check `authorizedNumbers` — skip if none configured
2. `callQueue.enqueue(paneId, async () => { ... })` — skip if queue full, log warning, fall back to Telegram-only
3. Inside the handler:
   - `const callSid = await transport.initiateCall(authorizedNumbers[0], webhookUrl)`
   - `bus.emit({ type: 'VoiceCallStarted', paneId, callSid, transport: transport.name })`
   - `transport.onCallConnected(callSid, () => runVoicePipeline(callSid, paneId))`
   - `transport.onCallEnded(callSid, () => { bus.emit(VoiceCallEnded); callQueue.onCallEnded() })`

**`runVoicePipeline(callSid, paneId)`**:
1. Get `pane.lastBufferSnapshot` from store (up to 2000 chars)
2. `const summary = await summarize(snapshot, opts)` — catches CircuitOpenError → falls back to Telegram
3. `const audioStream = synthesize(summary, opts)` — convert to transport format
4. `await transport.sendOutboundAudio(callSid, convertedAudioStream)`
5. `for await (const transcript of transcribe(transport.getInboundAudio(callSid), opts))`:
   - `sanitizeForSendKeys(transcript)` → `tmuxClient.sendKeys(paneId, sanitized)`
   - `bus.emit({ type: 'InputDelivered', paneId, sessionId, source: 'voice', text: sanitized })`
   - `store.setNotificationState(paneId, 'idle')`
   - `break` (one utterance per call)

**Test targets** (`apps/voice-server/test/voice-adapter.test.ts`):
- `CircuitBreaker`: 3 failures in window → state becomes 'OPEN'; 60s later → 'HALF_OPEN'; probe success → 'CLOSED'
- `CallQueue`: enqueue 6 calls → 6th returns false; `remove(paneId)` removes from queue
- `TwilioTransport.validateSignature()`: valid signature → no throw; invalid → throws
- `audio-convert`: `mulawToPcm16` produces a Buffer with length > 0; `resamplePcm16(buf, 8000, 16000)` produces buffer with doubled sample count
- Voice pipeline mock test: `MockTransport` yields pre-recorded PCM; mock Deepgram returns known transcript; mock ElevenLabs returns silent audio; assert `sendKeys` called with transcript

**Integration with orchestrator** (add to `apps/orchestrator/src/index.ts`):
```typescript
import { createVoiceAdapter } from '@sirko/voice-server'
const voiceAdapter = createVoiceAdapter(
  {
    transport: new TwilioTransport({ ... }),
    authorizedNumbers: process.env.SIRKO_VOICE_AUTHORIZED_NUMBERS?.split(',') ?? [],
    deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY!,
    elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID!,
  },
  store, bus, tmuxClient
)
await voiceAdapter.start()
```

**Library exports** (`apps/voice-server/src/index.ts`) — module API used by the orchestrator:
```typescript
export { VoiceAdapter, createVoiceAdapter } from './adapter'
export type { VoiceAdapterOptions } from './adapter'
// VoiceAdapter implements AdapterSink from @sirko/shared
```

**Note**: When integrating Phase 8, update `apps/orchestrator/package.json` to add:
```json
"@sirko/voice-server": "workspace:*"
```

**Quality gate**:
```bash
turbo run test --filter=@sirko/voice-pipeline
turbo run test --filter=@sirko/voice-server
turbo run typecheck --filter=@sirko/voice-pipeline
turbo run typecheck --filter=@sirko/voice-server
# Manual: TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... bun run apps/orchestrator/src/index.ts
# curl http://localhost:3000/twilio/webhook (returns valid TwiML)
```

---

## 3. Dependency Graph

```
Phase 1: Monorepo Scaffold + Shared Types
         [packages/shared]
              │
    ┌─────────┼──────────┬────────────┐
    │         │          │            │
Phase 2:   Phase 3:   Phase 4:      Phase 4:
State      tmux-      event-bus    tool-plugins
Store      client
    │         │          │            │
    └────┬────┘          └──────┬─────┘
         │                     │
    Phase 5: Detector + Pipeline Core
    [packages/detector, packages/pipeline]
              │
         Phase 6: Orchestrator
         [apps/orchestrator]
         (event loop, scheduler, wiring)
              │
    ┌─────────┴──────────┐
    │                    │
Phase 7:             Phase 8:
Telegram Bot         Voice Pipeline + Voice Server
[apps/telegram-bot]  [packages/voice-pipeline, apps/voice-server]
```

**Phases 7 and 8 are independent** — they both depend only on Phase 6 and can be developed in parallel (or in either order in separate sessions).

---

## 4. API Contracts

### 4.1 Internal Function Boundaries (cross-package)

**`TmuxClient.events()`** → yields `TmuxEvent` (defined in `@sirko/tmux-client`)

**`Pipeline.run(ctx)`** → returns `Promise<void>` (defined in `@sirko/pipeline`)

**`EventBus.emit(event)`** → synchronous dispatch to all `SirkoEvent` subscribers (defined in `@sirko/event-bus`)

**`StateStore.getPane(paneId)`** → `PaneState | undefined` (synchronous, in-memory)

**`DetectorEngine.computeScore(pane, xtermBuffer, skill)`** → `Promise<DetectionResult>`

**`VoiceTransport`** interface (defined in `@sirko/voice-pipeline/src/transport.ts`):
- `initiateCall(to, callbackUrl): Promise<string>` — string is callSid or roomName
- `getInboundAudio(callId): AsyncIterable<Buffer>` — raw audio per transport format
- `sendOutboundAudio(callId, audio): Promise<void>`

### 4.2 HTTP Endpoints (voice-server, port 3000)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/twilio/webhook` | TwiML response for outbound call setup |
| `POST` | `/twilio/status` | Twilio call status callback |
| `GET`  | `/twilio/stream` | WebSocket upgrade for Twilio Media Streams |
| `GET`  | `/health` | Returns `{ status: 'ok', ts: number }` |

**`POST /twilio/webhook`** — TwiML response body:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://{TWILIO_WEBHOOK_BASE_URL}/twilio/stream?callSid={callSid}" />
  </Connect>
</Response>
```

**`GET /twilio/stream`** — WebSocket protocol: Twilio Media Streams v1. Receives JSON messages:
- `{ event: 'connected', protocol: 'Call', version: '1.0' }`
- `{ event: 'media', media: { track: 'inbound', payload: '<base64-mulaw>' } }`
- `{ event: 'stop', ... }`

Sends JSON messages:
- `{ event: 'media', streamSid: '...', media: { payload: '<base64-mulaw>' } }`
- `{ event: 'clear', streamSid: '...' }` (to stop playing audio)

### 4.3 Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/sessions` | List all active pane sessions with their topic links |
| `/new <name>` | Create a new tmux session and associated topic |
| `/kill <paneId>` | Send SIGTERM to the process in a pane |
| `/status` | Show orchestrator health: pane count, voice status, error count |

---

## 5. Configuration Schema

### 5.1 Environment Variables

Variables are parsed by the orchestrator's `loadConfig()` function or by the respective adapter's constructor from `process.env`. Adapter-specific vars (`TELEGRAM_STREAMING_MODE`, `SIRKO_VOICE_HTTP_PORT`) are mapped into their adapter options struct, not into `OrchestratorConfig`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes (Phase 7) | — | grammY bot token |
| `TELEGRAM_GROUP_ID` | Yes (Phase 7) | — | Supergroup ID with Topics enabled |
| `TELEGRAM_STREAMING_MODE` | No | `edit` | `draft` or `edit` (output streaming mode) |
| `TWILIO_ACCOUNT_SID` | Yes (Phase 8) | — | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes (Phase 8) | — | Twilio auth token (for signature validation) |
| `TWILIO_PHONE_NUMBER` | Yes (Phase 8) | — | Outbound caller ID in E.164 format |
| `TWILIO_WEBHOOK_BASE_URL` | Yes (Phase 8) | — | Publicly accessible URL for TwiML callbacks |
| `DEEPGRAM_API_KEY` | Yes (Phase 8) | — | Deepgram API key |
| `ELEVENLABS_API_KEY` | Yes (Phase 8) | — | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | Yes (Phase 8) | — | ElevenLabs voice ID |
| `LIVEKIT_URL` | No | — | LiveKit server URL (post-v1) |
| `LIVEKIT_API_KEY` | No | — | LiveKit API key (post-v1) |
| `LIVEKIT_API_SECRET` | No | — | LiveKit API secret (post-v1) |
| `SIRKO_VOICE_AUTHORIZED_NUMBERS` | No | — | Comma-separated E.164 phone numbers for outbound calls |
| `SIRKO_DATA_DIR` | No | `~/.sirko` | Directory for state.json and logs |
| `SIRKO_TMUX_SOCKET` | No | tmux default | Path to tmux server socket |
| `SIRKO_LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `SIRKO_OUTPUT_COALESCE_MS` | No | `50` | Output event coalescing window in ms |
| `SIRKO_QUIESCENCE_INTERVAL_MS` | No | `500` | Quiescence scheduler polling interval in ms |
| `SIRKO_VOICE_HTTP_PORT` | No | `3000` | Port for Twilio webhook server |

### 5.2 Data Directory Structure

```
$SIRKO_DATA_DIR/                 (default: ~/.sirko)
├── state.json                   current runtime state (persisted every 30s)
├── state.json.bak               previous snapshot (backup)
├── state.json.tmp               write-in-progress (renamed atomically)
├── tmux.sock                    managed tmux server socket (if Sirko creates its own)
└── logs/
    ├── $1/                      per-session log directory (sessionId)
    │   ├── %0.log               per-pane output log (paneId)
    │   └── %3.log
    └── $2/
        └── %1.log
```

Permissions:
- `$SIRKO_DATA_DIR`: `0700`
- `state.json`, `*.bak`, `*.log`: `0600`
- `tmux.sock` (if managed): `0600`

### 5.3 `state.json` Schema (v1)

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
      "exitCode": null,
      "notificationState": "idle",
      "lastNotifiedAt": null,
      "lastOutputTime": 1234567890000,
      "processingCount": 0,
      "lastBufferSnapshot": "last 2000 chars of terminal",
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

---

## 6. Build and Run Commands

### 6.1 First-time setup

```bash
# Install all workspace dependencies
bun install

# Verify monorepo is wired correctly
turbo run typecheck

# Verify all tests pass (after Phase 6)
turbo run test
```

### 6.2 Development

```bash
# Run orchestrator with file watching (reloads on source change)
bun --watch run apps/orchestrator/src/index.ts

# Run tests for a specific package
turbo run test --filter=@sirko/pipeline
turbo run test --filter=@sirko/tmux-client

# Run typecheck for a specific package
turbo run typecheck --filter=@sirko/shared

# Run all checks
turbo run typecheck && turbo run test
```

### 6.3 Per-Phase Quality Gates

**After Phase 1**:
```bash
turbo run typecheck --filter=@sirko/shared
turbo run test --filter=@sirko/shared
```

**After Phase 2**:
```bash
turbo run test --filter=@sirko/state-store
# Create ~/.sirko-test, run persist+load round-trip manually
```

**After Phase 3**:
```bash
turbo run test --filter=@sirko/tmux-client
# Manual: bun run packages/tmux-client/src/index.ts (requires tmux)
# Observe JSON events on stdout when pane produces output
```

**After Phase 4**:
```bash
turbo run test --filter=@sirko/event-bus
turbo run test --filter=@sirko/tool-plugins
```

**After Phase 5**:
```bash
turbo run test --filter=@sirko/detector
turbo run test --filter=@sirko/pipeline
# Verify detection formula test passes:
# DetectorEngine with all signals 1.0 → score >= threshold → awaiting = true
```

**After Phase 6**:
```bash
# Full integration test
turbo run test --filter=@sirko/orchestrator
# Manual smoke test (no Telegram/voice credentials needed yet):
SIRKO_DATA_DIR=/tmp/sirko-test bun run apps/orchestrator/src/index.ts
# In a separate terminal: tmux new-session -s test -d
# Run fake-agent.sh in a pane
# Observe PaneOutput and PaneAwaitingInput events logged to stdout as JSON
```

**After Phase 7**:
```bash
turbo run test --filter=@sirko/telegram-bot
# Real integration test:
TELEGRAM_BOT_TOKEN=<token> TELEGRAM_GROUP_ID=<id> SIRKO_DATA_DIR=/tmp/sirko-test \
  bun run apps/orchestrator/src/index.ts
# Run fake-agent.sh; observe Telegram topic receiving output and await-input notification
# Reply in the topic; verify text appears in the pane
```

**After Phase 8**:
```bash
turbo run test --filter=@sirko/voice-pipeline
turbo run test --filter=@sirko/voice-server
# Validate Twilio webhook endpoint:
TWILIO_ACCOUNT_SID=<sid> TWILIO_AUTH_TOKEN=<token> TWILIO_PHONE_NUMBER=+1... \
  TWILIO_WEBHOOK_BASE_URL=https://your-ngrok.ngrok.io \
  DEEPGRAM_API_KEY=<key> ELEVENLABS_API_KEY=<key> ELEVENLABS_VOICE_ID=<id> \
  bun run apps/orchestrator/src/index.ts
curl -X POST http://localhost:3000/twilio/webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "CallSid=CA123&From=+15555550100&To=+15555550101"
# Expected: valid TwiML XML response
```

### 6.4 Full System Start (all phases complete)

```bash
# Copy .env.example to .env and fill in all values
cp .env.example .env

# Start the orchestrator (includes Telegram + Voice adapters)
bun run start

# Or equivalently:
bun run apps/orchestrator/src/index.ts
```

### 6.5 Running Individual Tests by Scenario

```bash
# Run only the pipeline integration tests
bun test apps/orchestrator/test/pipeline-integration.test.ts

# Run only dedup middleware tests
bun test packages/pipeline/src/middleware/dedup.test.ts

# Run with verbose output
bun test --reporter=verbose packages/detector/src/engine.test.ts
```

---

*End of Sirko Implementation Plan*
*Architecture source: ai-docs/sessions/dev-arch-20260316-124106-081b4c45/architecture.md*
