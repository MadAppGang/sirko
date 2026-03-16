# Sirko Implementation Requirements

**Feature Session**: dev-feature-sirko-orchestrator-20260316-165429-c4a5ae8f
**Architecture Session**: dev-arch-20260316-124106-081b4c45
**Scope**: Full system (all 6 implementation phases)

> Requirements inherited from architecture session. See architecture.md for detailed design.

---

# Sirko — Requirements Document

**Session**: dev-arch-20260316-124106-081b4c45
**Date**: 2026-03-16
**Status**: Draft

---

## 1. Functional Requirements

### 1.1 tmux Control-Mode Client

**FR-TMUX-01**: The system MUST connect to tmux using control mode (`tmux -C`) to receive structured event streams without polling.

**FR-TMUX-02**: The client MUST model the tmux object hierarchy: Server → Session → Window → Pane, with each level independently addressable.

**FR-TMUX-03**: Pane IDs (format `%N`) MUST be treated as permanent and never reused within a server lifetime. The client MUST use pane IDs (not indices) as stable references.

**FR-TMUX-04**: The client MUST parse and handle control-mode protocol messages including:
- `%output` — pane output events
- `%begin` / `%end` — command response delimiters
- `%session-created`, `%session-closed`
- `%window-add`, `%window-close`
- `%pane-exited`

**FR-TMUX-05**: The client MUST use `@xterm/headless` (or equivalent) to interpret ANSI/VT escape sequences in pane output, exposing plain text and cursor state.

**FR-TMUX-06**: The client MUST support sending input to a pane (simulating keystrokes / typed text) to deliver human responses to CLI agents.

**FR-TMUX-07**: The client MUST support spawning new sessions, windows, and panes programmatically.

**FR-TMUX-08**: The client MUST support attaching to existing tmux servers (not only servers it created).

### 1.2 Agent Input Detection

**FR-DETECT-01**: The orchestrator MUST detect when a CLI agent is waiting for human input using a weighted combination of three signals:

1. **Process wait channel signal** — inspect the process's kernel wait channel:
   - Linux (prod): read `/proc/<pid>/wchan`
   - macOS (dev): use `ps -o wchan= -p <pid>` or `lsof` as equivalent
2. **Output quiescence signal** — detect when `%output` events from a pane have stopped for a configurable period (no new output for N milliseconds)
3. **Prompt pattern signal** — match the pane's current terminal content against regex patterns known to indicate input prompts (e.g., `> `, `? `, `(y/n)`, tool-specific prompt patterns)

**FR-DETECT-02**: Each signal MUST carry a configurable weight. The combined weighted score MUST cross a configurable threshold before the orchestrator classifies a pane as "awaiting input."

**FR-DETECT-03**: The orchestrator MUST support a plugin/skill system that provides per-CLI-tool configurations including:
- Tool identification (name, binary path, process name)
- Custom prompt patterns specific to that tool
- Signal weight overrides for that tool
- Any tool-specific pre/post-input behavior

**FR-DETECT-04**: The plugin system MUST support at minimum the following CLI agents out of the box:
- Claude Code (`claude`)
- OpenAI Codex CLI (`codex`)
- Aider (`aider`)

**FR-DETECT-05**: When a pane is detected as awaiting input, the orchestrator MUST emit a structured event containing: pane ID, session ID, inferred tool, confidence score, and a snapshot of relevant terminal context.

### 1.3 Telegram Interface

**FR-TG-01**: The system MUST implement a Telegram bot using the grammY framework.

**FR-TG-02**: Each CLI agent session (pane) MUST map to exactly one Telegram forum topic (supergroup with topics enabled). The mapping MUST be persisted across restarts.

**FR-TG-03**: Agent output MUST be streamed to the corresponding Telegram topic using the Bot API 9.3+ `sendMessageDraft` (or equivalent streaming/edit-based approach) to provide live output feedback without spamming discrete messages.

**FR-TG-04**: Messages MUST be sent using HTML parse mode.

**FR-TG-05**: Long output blocks (content that would exceed Telegram's 4096-character message limit) MUST use expandable blockquotes (`<blockquote expandable>`) to keep messages readable.

**FR-TG-06**: Output that exceeds 12,000 characters MUST be uploaded as a file attachment rather than embedded in a message.

**FR-TG-07**: The Telegram bot MUST handle incoming messages from authorized users and route them as input to the appropriate pane (matched by forum topic).

**FR-TG-08**: The bot MUST support commands for basic session management: creating new agent sessions, listing active sessions, and terminating sessions.

**FR-TG-09**: The system MUST respect Telegram rate limits:
- Maximum 20 messages per minute per group/topic
- Maximum 30 API requests per second globally
Rate limiting MUST be enforced internally via a request queue.

### 1.4 Voice Interface — MVP (Twilio)

**FR-VOICE-01**: The MVP voice interface MUST support outbound calls initiated by the system to a configured phone number via Twilio.

**FR-VOICE-02**: Voice calls MUST use bidirectional WebSocket media streams (Twilio Media Streams API) for real-time audio I/O.

**FR-VOICE-03**: The voice pipeline MUST implement the following stages in sequence:
1. Receive inbound audio from call (Twilio WebSocket → μ-law 8kHz PCM)
2. Speech-to-text via Deepgram (streaming STT, preferably Nova-2 model)
3. LLM summarization/intent extraction (route to appropriate agent session context)
4. Text-to-speech via ElevenLabs (streaming TTS)
5. Return synthesized audio to Twilio WebSocket

**FR-VOICE-04**: The voice interface MUST notify the user (via call) when a CLI agent is awaiting input, reading out a summary of the agent's current state and the prompt context.

**FR-VOICE-05**: The user MUST be able to speak a response during the call, which the system transcribes and routes as text input to the waiting pane.

### 1.5 Voice Interface — Production (LiveKit)

**FR-VOICE-06**: The production voice interface MUST use LiveKit Agents framework for voice pipeline orchestration.

**FR-VOICE-07**: The system MUST support a custom iOS CallKit app as the user-facing client, providing native incoming/outgoing call UI on iPhone.

**FR-VOICE-08**: The LiveKit-based pipeline MUST use the same STT (Deepgram) and TTS (ElevenLabs) providers as the Twilio MVP, enabling provider reuse.

**FR-VOICE-09**: The LiveKit implementation MUST be designed so the Twilio MVP and LiveKit production paths share the core voice pipeline logic (STT → LLM → TTS), differing only in the transport/signaling layer.

### 1.6 Orchestrator Core

**FR-ORCH-01**: The orchestrator MUST maintain a real-time state model of all managed panes, tracking: pane ID, associated CLI tool, current status (running / awaiting-input / idle / exited), last-seen output timestamp, and pending notification state.

**FR-ORCH-02**: When an awaiting-input event is detected, the orchestrator MUST fan out a notification to all configured interfaces (Telegram topic and/or voice call) that are active for that session.

**FR-ORCH-03**: The orchestrator MUST prevent duplicate notifications: if a pane has already triggered a notification for the current input-wait event, further notifications MUST be suppressed until the pane resumes running (input was delivered).

**FR-ORCH-04**: The orchestrator MUST handle the case where the user responds via one interface (e.g., Telegram) and suppress/cancel the pending notification on other interfaces (e.g., an outbound call that was about to be placed).

**FR-ORCH-05**: The orchestrator MUST log all pane output to durable storage (file-based, per-session) for later retrieval and audit.

---

## 2. Non-Functional Requirements

### 2.1 Performance

**NFR-PERF-01**: End-to-end voice pipeline latency (user speech ends → synthesized response begins playing) MUST target 500–800ms under normal network conditions.

**NFR-PERF-02**: tmux control-mode event processing MUST add no more than 50ms of additional latency from event receipt to orchestrator state update.

**NFR-PERF-03**: Telegram message delivery for agent output MUST occur within 2 seconds of the output being emitted by the pane, subject to Telegram API rate limits.

**NFR-PERF-04**: Input detection (the point at which the orchestrator decides a pane is awaiting input) MUST occur within 3 seconds of the agent actually stopping and waiting, to ensure prompt user notification.

**NFR-PERF-05**: The system MUST handle at least 10 concurrent active panes (each streaming output) without degrading performance below the above targets.

### 2.2 Security

**NFR-SEC-01**: No authentication is required for v1. Telegram bot access is controlled at the network/bot-token level (only people with the bot token or group membership can interact). Formal user authentication is deferred to a future version.

**NFR-SEC-02**: Twilio webhook endpoints MUST validate Twilio request signatures (using the Twilio Auth Token) before processing any incoming request.

**NFR-SEC-03**: LiveKit room tokens MUST be scoped to the minimum required permissions (join specific room, publish/subscribe audio only).

**NFR-SEC-04**: All secrets (Telegram bot token, Twilio credentials, Deepgram API key, ElevenLabs API key, LiveKit API key) MUST be stored in environment variables or a secrets manager and MUST NOT be hardcoded in source or committed to version control.

**NFR-SEC-05**: The tmux server socket path MUST be restricted to the process owner (file permissions 0600 or equivalent) when the system manages its own tmux server.

**NFR-SEC-06**: Voice calls MUST only be placed to the pre-configured authorized phone number(s). Dynamic number input from Telegram MUST NOT be allowed without explicit allowlist validation.

### 2.3 Reliability and Availability

**NFR-REL-01**: The orchestrator MUST reconnect to the tmux control-mode socket automatically on disconnect, with exponential backoff (initial 1s, max 30s).

**NFR-REL-02**: The Telegram bot MUST resume polling or webhook processing after transient API errors, with exponential backoff and jitter.

**NFR-REL-03**: Pane-to-topic mappings and orchestrator state MUST be persisted to disk so that the system can recover its full operational state after a restart without data loss.

**NFR-REL-04**: A failed voice pipeline (e.g., STT timeout, ElevenLabs error) MUST fall back gracefully: log the error, notify the user via Telegram that voice is unavailable, and continue operating the Telegram interface.

**NFR-REL-05**: The system MUST handle pane exits (process completion) cleanly: mark the pane as exited, send a final status message to the Telegram topic, and release associated resources.

### 2.4 Maintainability

**NFR-MAINT-01**: The plugin/skill system for CLI tool support MUST be structured so that adding a new CLI tool requires only adding a new plugin file without modifying core orchestrator logic.

**NFR-MAINT-02**: The voice transport layer (Twilio vs. LiveKit) MUST be abstracted behind a common interface so that swapping transports does not require changes to the pipeline (STT/LLM/TTS) logic.

**NFR-MAINT-03**: The system MUST emit structured logs (JSON format) at configurable verbosity levels, including: pane events, detection decisions (with signal weights), Telegram API calls, and voice pipeline stage timings.

---

## 3. Constraints

### 3.1 Technology Stack

**CON-STACK-01**: Runtime MUST be Bun. Node.js compatibility is acceptable for library use, but the primary runtime is Bun.

**CON-STACK-02**: Language MUST be TypeScript with strict mode enabled.

**CON-STACK-03**: Monorepo MUST use Turborepo with Bun workspaces for package management and build orchestration.

**CON-STACK-04**: AI/LLM integration MUST use a popular LLM-agnostic framework (e.g., Vercel AI SDK, LangChain.js, or similar) to avoid vendor lock-in to any specific LLM provider.

**CON-STACK-05**: Telegram bot MUST use the grammY framework (not Telegraf or raw HTTP).

**CON-STACK-06**: Voice MVP MUST use Twilio Programmable Voice with Media Streams.

**CON-STACK-07**: Voice production MUST use LiveKit Agents SDK for TypeScript/Node.js.

**CON-STACK-08**: STT provider MUST be Deepgram (swappable via the LLM-agnostic framework).

**CON-STACK-09**: TTS provider MUST be ElevenLabs (swappable via the LLM-agnostic framework).

**CON-STACK-10**: Terminal emulation for ANSI interpretation MUST use `@xterm/headless` or a compatible headless xterm implementation.

**CON-STACK-11**: The development environment is macOS; the production environment is Linux. The codebase MUST support both, with platform-specific branches for process inspection (`/proc` vs. `ps`/`lsof`).

**CON-STACK-12**: Frontend (if needed for dashboard/admin) MUST use React with TanStack Query (data fetching) and TanStack Router (routing).

**CON-STACK-13**: Database (if needed) MUST use Neon (serverless Postgres).

**CON-STACK-14**: No authentication required for v1. System is personal/small-team use behind network-level access controls.

### 3.2 External API Constraints

**CON-API-01**: Telegram Bot API version MUST be 9.3 or later to support `sendMessageDraft` streaming message delivery.

**CON-API-02**: Telegram message body MUST NOT exceed 4096 characters (hard platform limit).

**CON-API-03**: Telegram rate limits are externally enforced: 20 messages/min per group, 30 requests/s globally. Internal queuing MUST respect these limits.

**CON-API-04**: Twilio Media Streams deliver audio as μ-law encoded, 8kHz, mono PCM. The pipeline MUST handle this format at ingress.

### 3.3 Budget / Cost

**CON-COST-01**: The cascaded voice pipeline (Deepgram + ElevenLabs) targets a cost of approximately $0.02–$0.05 per minute of voice conversation. Architecture decisions that would substantially increase this cost (e.g., switching to OpenAI Realtime API at ~$0.30/min) MUST be explicitly justified.

**CON-COST-02**: The system is designed for personal/small-team use. Scaling beyond ~10 concurrent users is out of scope for v1.

---

## 4. Assumptions

**ASM-01**: A tmux server is already running (or can be started) on the host machine where the orchestrator runs. The orchestrator does not need to manage tmux installation.

**ASM-02**: The CLI agents (Claude Code, Codex, Aider, etc.) are already installed and authenticated on the host machine. The orchestrator does not manage agent credentials.

**ASM-03**: The Telegram bot is configured with a supergroup that has Topics enabled. The bot has admin privileges in that supergroup to create and manage forum topics.

**ASM-04**: Twilio account is pre-configured with a phone number capable of outbound PSTN calls and Media Streams. The Twilio webhook URL is publicly accessible (e.g., via ngrok in dev, a real domain in prod).

**ASM-05**: LiveKit server is available (either self-hosted or LiveKit Cloud) for the production voice implementation. LiveKit SDK compatibility with Bun is assumed or workarounds are acceptable.

**ASM-06**: The operator of the system is also the sole authorized user (personal tool), or a small fixed set of users with known Telegram user IDs are pre-configured.

**ASM-07**: Output quiescence threshold (the silence period before "awaiting input" is inferred from lack of output) is tunable per tool and will require empirical calibration during development.

**ASM-08**: Pane output is line-buffered or at least reasonably chunked by the CLI agent. Extremely high-frequency character-by-character output (e.g., raw typing simulation) is not a primary use case and may degrade performance.

**ASM-09**: The system runs as a single process on a single host. Distributed/multi-host deployment is out of scope for v1.

**ASM-10**: `@xterm/headless` is compatible with Bun's runtime. If not, an alternative ANSI parsing library (e.g., `ansi-escapes`, `strip-ansi` + a custom VT state machine) will be substituted.

---

## 5. Dependencies

### 5.1 Runtime Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| Bun runtime | Primary JavaScript/TypeScript runtime | Replaces Node.js |
| TypeScript | Language | Strict mode required |
| Turborepo | Monorepo build orchestration | With Bun workspaces |
| LLM-agnostic framework (e.g., Vercel AI SDK) | LLM integration without vendor lock-in | Evaluate in design phase |
| grammY | Telegram Bot API framework | v1.x |
| `@xterm/headless` | Headless terminal emulator for ANSI interpretation | Bun compatibility assumed |
| Deepgram SDK (`@deepgram/sdk`) | Streaming speech-to-text | Node.js-compatible |
| ElevenLabs SDK | Text-to-speech | Node.js-compatible |
| Twilio SDK (`twilio`) | Outbound calls and Media Streams (MVP voice) | Node.js-compatible |
| LiveKit Agents SDK | Voice pipeline orchestration (production voice) | Node.js-compatible |
| LiveKit Server SDK (`livekit-server-sdk`) | Token generation for LiveKit rooms | Node.js-compatible |
| React | Frontend framework (dashboard/admin if needed) | |
| TanStack Query | Server state / data fetching | |
| TanStack Router | Client-side routing | |
| Neon (`@neondatabase/serverless`) | Serverless Postgres database (if needed) | |

### 5.2 Development Dependencies

| Dependency | Purpose |
|---|---|
| TypeScript compiler (`tsc`) | Type checking and compilation |
| Turborepo | Task orchestration, caching, parallel builds |
| Bun test runner | Unit and integration tests |
| `@types/*` | TypeScript type definitions for dependencies |

### 5.3 External Service Dependencies

| Service | Used For | SLA / Availability |
|---|---|---|
| Telegram Bot API | Message delivery, forum topic management | Telegram platform uptime |
| Deepgram API | Streaming STT in voice pipeline | Deepgram platform uptime |
| ElevenLabs API | TTS in voice pipeline | ElevenLabs platform uptime |
| Twilio | Outbound calls, Media Streams (MVP) | Twilio platform uptime |
| LiveKit | Room/WebRTC transport (production) | LiveKit Cloud or self-hosted |

### 5.4 System / Infrastructure Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| tmux (≥ 2.4) | Control-mode protocol, session management | Must be installed on host |
| Linux `/proc` filesystem | Process wait channel inspection (prod) | Not available on macOS |
| `ps` / `lsof` | Process wait channel inspection (dev, macOS) | macOS alternative to `/proc` |
| POSIX filesystem | Durable log and state storage | Local disk |
| Public HTTPS endpoint | Twilio webhook delivery | ngrok (dev), reverse proxy (prod) |
| iOS device / TestFlight | CallKit app (production voice client) | Out of scope for v1 implementation |
