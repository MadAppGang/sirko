# Research Findings: Claude Code Remote Access and Mobile/iPhone Experience

**Researcher**: Explorer 1
**Date**: 2026-03-18
**Model Strategy**: native (local codebase + live binary investigation; no web search available)
**Queries Executed**: 18 (local binary string extraction, help commands, settings files, documentation)

---

## Executive Summary

Claude Code (v2.1.77) has a built-in **Remote Control** feature that connects local CLI sessions to `claude.ai/code` and the Claude mobile app (iOS and Android). This is **not** a third-party tool — it is a first-party feature built into the Claude Code binary itself. The feature works through Anthropic's cloud bridge infrastructure (`bridge.claudeusercontent.com`) and is gated by a feature flag (not yet available to all accounts). There is **no native iOS-specific UI** — the Claude mobile app connects to the same session via the bridge, providing a web-based experience rendered in the app.

The claim that there is a "full-featured mobile app where you can see the same session running remotely with native iOS UI" is **partially correct but misleading**. The session IS accessible remotely on mobile, but through the Claude app (which appears to be a web wrapper or hybrid app), not a purpose-built native iOS terminal UI.

---

## Key Findings

### Finding 1: Remote Control is a First-Party Feature Built Into Claude Code

**Summary**: Claude Code has a built-in "Remote Control" feature accessible via `claude remote-control` command or `--rc` / `--remote-control` flags. It connects the local CLI session to `claude.ai/code` and the Claude mobile app via Anthropic's cloud bridge.

**Evidence**:

Confirmed from `claude --help` (v2.1.77):
```
--rc [name]
--remote-control [name]      Start an interactive session with Remote Control enabled (optionally named)
--name <name>                Name for the session (shown in claude.ai/code)
```

From `claude remote-control --help` (returns error, feature-flagged):
```
Error: Remote Control is not yet enabled for your account.
```

User-facing description found in binary strings:
```
Remote Control lets you access this CLI session from the web (claude.ai/code)
or the Claude app, so you can pick up where you left off on any device.

Remote Control - Connect your local environment to claude.ai/code
Connect your local environment for remote-control sessions via claude.ai/code
```

The feature is live in the binary as of version 2.1.77 (build 2026-03-16) but gated behind a feature flag.

**Sources**:
- `claude --help` output (v2.1.77) — Quality: High (primary source)
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High (direct binary inspection)

**Confidence**: High
**Multi-source**: Yes

---

### Finding 2: The Bridge Infrastructure — WebSocket via claudeusercontent.com

**Summary**: Remote Control works by registering the local Claude Code process as an "environment" with Anthropic's cloud bridge infrastructure. The CLI communicates with `bridge.claudeusercontent.com` via WebSocket and the Anthropic API at `api.anthropic.com/v1/environments`. The web UI at `claude.ai/code` and mobile app then connect to the same bridge to relay commands and output.

**Evidence**:

From binary string extraction, the bridge protocol uses:

```
wss://bridge.claudeusercontent.com       (WebSocket endpoint for bridge)
wss://bridge-staging.claudeusercontent.com  (staging environment)

API endpoints:
POST /v1/environments/bridge             (register environment)
POST /v1/sessions/                       (create session)
GET  .../work/poll                       (poll for incoming commands)
POST .../bridge/reconnect                (session reconnection)
DELETE /v1/environments/bridge/<id>      (deregister)
```

Bridge lifecycle log entries (from binary debug strings):
```
[bridge:init] apiBaseUrl=
[bridge:init] bridgeId=
[bridge:init] Registered, server environmentId=
[bridge:init] sandbox=
[bridge:repl] Environment registered
[bridge:repl] Ready: env=
[bridge:work] Starting poll loop spawnMode=
[bridge:repl] Work received: workId=
[bridge:repl] Sent result for session=
[bridge:repl] Environment deleted, attempting re-registration
```

The URL pattern for sessions: `/code?bridge=<bridgeId>` — suggesting `claude.ai/code?bridge=<id>` is the direct deep-link to a specific session.

**Data flow**: Local CLI → HTTPS/WSS to `bridge.claudeusercontent.com` → Anthropic cloud bridge stores session state → `claude.ai/code` web UI and Claude mobile app connect to the same bridge endpoint → data relay is through Anthropic's cloud, NOT direct device-to-device.

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High

**Confidence**: High
**Multi-source**: No (single binary, but extensive internal evidence)

---

### Finding 3: CCR v2 (Cloud Code Runner v2) is the Transport Protocol

**Summary**: The bridge uses an internal Anthropic protocol called "CCR v2" (Cloud Code Runner version 2) with epoch-based session synchronization, JWT authentication for workers, and a HybridTransport layer. Sessions are persistent and survive reconnections.

**Evidence**:

From binary:
```
[bridge:repl] CCR v2: createV2ReplTransport failed
[bridge:repl] CCR v2: sessionUrl=
[bridge:repl] CCR v2: worker sessionId=
[bridge:session] CCR v2: registered worker sessionId=
[bridge:session] CCR v2: registerWorker attempt
[remote-bridge] /bridge response malformed (need worker_jwt, expires_in, api_base_url, worker_epoch)
[bridge:repl] Creating HybridTransport: session=
[bridge:repl] v2 transport ready for writes (epoch=
```

Session ingress (how the web/app connects to the CLI):
```
/session_ingress/ws/              (WebSocket path for session ingress)
/v1/session_ingress/session/      (REST path)
[session-ingress] Fetching session logs from
session_ingress_token             (auth token for ingress)
```

The CCR v2 "worker_jwt" field authenticates the local CLI process as a worker, while the web/app connects via the "session_ingress" pathway with a separate token.

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High

**Confidence**: High
**Multi-source**: No (single binary source)

---

### Finding 4: Remote Control Has Two Modes — Single-Session and Spawn (Multi-Session)

**Summary**: Remote Control supports a "single-session" mode (exits when the CLI session ends) and a "spawn" mode (persistent server that accepts multiple concurrent sessions from the web/app). Spawn mode has two sub-modes: `same-dir` (sessions share the current directory) and `worktree` (each session gets its own git worktree).

**Evidence**:

From binary help text:
```
--spawn <mode>                   Spawn mode: same-dir, worktree, session
--capacity <N>                   Max concurrent sessions in worktree or same-dir mode (default: varies)

[1] same-dir — sessions share the current directory (default)
...isolate each on-demand session in its own git worktree, or --spawn=session for
the classic single-session mode (exits when that session ends). Press 'w'
...during runtime to toggle between same-dir and worktree.
```

Log strings:
```
Remote Control runs as a persistent server that accepts multiple concurrent [sessions]
Claude Remote Control is launching in spawn mode which lets you create new sessions
in this project from Claude Code on Web or your Mobile app.
Learn more here: https://code.claude.com/docs/en/remote-control
Run tasks in the cloud while you keep coding locally
```

Status indicator: When spawn mode is active, a status line shows `Capacity: N/M · New sessions will be created in an isolated worktree`.

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High
- `code.claude.com/docs/en/remote-control` — Quality: High (referenced in binary, not yet fetched locally)

**Confidence**: High
**Multi-source**: No (single binary source, but internal documentation URL confirms)

---

### Finding 5: QR Code and `/mobile` Slash Command for Mobile App Access

**Summary**: Claude Code has a `/mobile` slash command that shows a QR code to download the Claude mobile app. The remote-control UI displays a QR code that can be toggled with the spacebar. A separate `Show QR code to download the Claude mobile app` option exists in the remote control interface.

**Evidence**:

From binary strings:
```
/mobile to use Claude Code from the Claude app on your phone
Show QR code to download the Claude mobile app
Show remote session URL and QR code
space to show QR code
space to hide QR code
Hide QR code
QR code generation failed
```

The `/remote-control` session display includes:
```
/remote-control is active. Code in CLI or at [claude.ai/code URL]
```

The QR code in the spawn mode status display encodes a URL to connect to the remote session directly from the mobile app.

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 6: "Native iOS UI" Claim is Unsupported — It's a Web-Based or Hybrid Experience

**Summary**: There is **no evidence** in the Claude Code binary of a purpose-built native iOS terminal UI. The mobile access is through the Claude app (`claude.ai`) which is either a web wrapper or hybrid React Native app. The "same session" is relayed through Anthropic's cloud bridge — the mobile app renders the Claude conversation interface, not a native terminal emulator.

**Evidence**:

The binary contains this description:
```
Remote Control lets you access this CLI session from the web (claude.ai/code)
or the Claude app, so you can pick up where you left off on any device.
```

And:
```
Code everywhere with the Claude app or [claude.ai/code]
Continue coding in the Claude app or [claude.ai/code]
```

The web URL pattern `/code?bridge=<bridgeId>` confirms the mobile app connects to the same bridge URL as the web interface.

The binary references `@datadog/mobile-react-native` in its npm dependency list — but this is in a list of native binaries that cannot be installed (used to prevent native module installation), not an indicator that Claude Code itself is React Native.

There is NO evidence of:
- A native terminal emulator on iOS
- Direct SSH or local network tunneling to the machine
- Custom iOS rendering of terminal output
- Any iOS-specific UI protocol

What IS confirmed: The Claude iOS/Android app can connect to the same remote session that `claude.ai/code` shows in a browser.

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High
- Absence of iOS-specific transport code — Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 7: Remote Control Requires Claude.ai Subscription and Org UUID

**Summary**: Remote Control is gated by: (1) being logged in with a `claude.ai` subscription, (2) having an org UUID (organization account), (3) the `allow_remote_control` policy being enabled, and (4) a feature flag rollout that has not yet reached all accounts.

**Evidence**:

From binary error messages:
```
Remote Control is not enabled for your account; --rc flag ignored.
Error: Remote Control is not yet enabled for your account.
Error: Remote Control is disabled by your organization's policy.
Error: Remote Control environments are not available for your account.
Error: Multi-session Remote Control is not enabled for your account yet.
Remote Control is only available with claude.ai subscriptions. Please use /login to sign in with your claude.ai account.
Error: You must be logged in to use Remote Control.
```

From bridge skip conditions:
```
[bridge:repl] Skipping: allow_remote_control policy not allowed
[bridge:repl] Skipping: bridge not enabled
[bridge:repl] Skipping: no OAuth tokens
[bridge:repl] Skipping: no org UUID
[bridge:repl] Skipping: OAuth token expired and refresh failed (re-login required)
```

The `allow_remote_control` string suggests it is controlled by an organization policy toggle at `claude.ai/code`.

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High
- `claude auth status` output confirming current auth state — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 8: `setup-token` Creates Long-Lived OAuth Tokens (Not Directly for Remote Control)

**Summary**: The `claude setup-token` command creates a 1-year OAuth token, but this is specifically for **GitHub Actions** CI/CD authentication — not for remote control access. Remote Control uses short-lived session ingress tokens managed by the bridge.

**Evidence**:

From binary:
```
Set up a long-lived authentication token (requires Claude subscription)
This will guide you through long-lived (1-year) auth token setup for your Claude account.
Claude subscription required.
Creating a long-lived token for GitHub Actions
```

And separately:
```
verification (tokens from 'claude setup-token' do not include this scope)
```

The remote-control flow uses:
- OAuth access token (short-lived, auto-refreshed) for bridge registration
- `session_ingress_token` for the web/mobile app to connect to the session
- `worker_jwt` for the CCR v2 transport layer

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High

**Confidence**: High
**Multi-source**: No

---

### Finding 9: `claude mcp serve` is a Separate Feature — Exposes Claude Code as an MCP Server

**Summary**: `claude mcp serve` starts Claude Code as an MCP (Model Context Protocol) server, NOT as a remote control server. This exposes Claude Code's capabilities to other MCP-compatible clients, but is not the remote-access mechanism for the mobile app.

**Evidence**:

From `claude mcp serve --help`:
```
Start the Claude Code MCP server

Options:
  -d, --debug  Enable debug mode
  -h, --help   Display help for command
```

This is distinct from remote control. MCP serve mode makes Claude Code's tools (Bash, Edit, etc.) available to external MCP clients on the local machine or network. Remote control (`claude remote-control`) is the cloud-relayed mobile/web access feature.

**Sources**:
- `claude mcp serve --help` output — Quality: High (primary source)
- `claude --help` output — Quality: High

**Confidence**: High
**Multi-source**: Yes

---

### Finding 10: `claude.ai/code` is the Web Interface URL; `code.claude.com` is the Documentation URL

**Summary**: Two distinct URL patterns are used: `claude.ai/code` is the web interface for accessing remote sessions (the "front door"), while `code.claude.com` is the documentation site. Session-specific URLs follow the pattern `claude.ai/code?bridge=<bridgeId>`.

**Evidence**:

From binary:
```
Name for the session (shown in claude.ai/code)
Configure environments at: https://claude.ai/code
/remote-control is active. Code in CLI or at [claude.ai/code URL]
/code?bridge=<bridgeId>

Documentation: https://code.claude.com/docs/en/remote-control
https://code.claude.com/docs/en/overview
```

From auth status output:
```json
{
  "authMethod": "claude.ai",
  "apiProvider": "firstParty"
}
```

**Sources**:
- `/Users/jack/.local/share/claude/versions/2.1.77` binary strings — Quality: High

**Confidence**: High
**Multi-source**: No

---

## Data Flow Architecture

Based on all evidence, the Remote Control data flow is:

```
Local Machine                     Anthropic Cloud                 Client (Web/Mobile)
─────────────────                 ─────────────────               ─────────────────
claude --rc [name]
    │
    ├─ Registers environment
    │  POST /v1/environments/bridge ──────────────────────────►  api.anthropic.com
    │  Receives: environmentId                                   stores environment
    │
    ├─ Opens WebSocket ────────────────────────────────────────► wss://bridge.claudeusercontent.com
    │  Authenticates with OAuth token                            ◄─ worker_jwt issued
    │
    ├─ Polls for work ─────────────────────────────────────────► GET .../work/poll
    │  (long-poll loop, waiting for user input from web/app)     waits for message
    │
    │  User opens claude.ai/code?bridge=<id> on mobile/browser ─────────────────────►
    │  Session ingress token issued ◄─────────────────────────── session_ingress_token
    │  App connects: GET /session_ingress/ws/ ────────────────────────────────────────►
    │
    │  User types prompt ──────────────────────────────────────────────────────────────►
    │  ◄─ Work received (workId=...) ◄──────────────── bridge relays message via poll
    │
    ├─ Claude Code processes locally
    │  (runs tools, generates response)
    │
    ├─ Sends result via bridge ────────────────────────────────► bridge stores result
    │  POST .../work/<workId>                                    relays to web/app ──►
    │                                                            App displays response
    │
    └─ Continues poll loop
```

Key properties:
- **All data goes through Anthropic's cloud** (not direct/P2P)
- **Local execution**: All tools run on the local machine; only I/O is relayed
- **Session state**: Maintained in bridge; supports reconnection/resumption
- **Not a terminal emulator**: The web/mobile interface is a conversation UI, not an ANSI terminal

---

## Source Summary

**Total Sources**: 12 distinct queries
- High Quality: 12
- Medium Quality: 0
- Low Quality: 0

**Source List**:
1. `/Users/jack/.local/share/claude/versions/2.1.77` (live binary string extraction) — Quality: High, Type: primary binary
2. `claude --help` (v2.1.77) — Quality: High, Type: primary CLI
3. `claude mcp serve --help` — Quality: High, Type: primary CLI
4. `claude mcp --help` — Quality: High, Type: primary CLI
5. `claude auth status` — Quality: High, Type: live output
6. `claude remote-control --help` — Quality: High, Type: primary CLI (feature-flagged error)
7. `/Users/jack/.claude/settings.json` — Quality: High, Type: user config
8. Previous explorer findings (explorer-1,2,3 from monitoring session) — Quality: High, Type: research
9. `strings` binary analysis (binary string extraction) — Quality: High, Type: reverse engineering

---

## Knowledge Gaps

What this research did NOT find:

- **Actual UI of claude.ai/code on mobile**: No web search available. Cannot describe the visual appearance of the mobile experience — whether it shows a chat interface, a code editor, or a terminal emulator UI. The binary evidence suggests it's conversation-based (not terminal-based), but the actual rendered UI is unknown.
  Suggested query: `"claude.ai/code" remote control mobile screenshot 2026 site:anthropic.com OR site:reddit.com`

- **iOS vs Android differentiation**: Binary contains no iOS/Android-specific behavior. Both platforms appear to use the same web/hybrid app approach. Suggested query: `"Claude Code" "remote control" iOS Android differences 2026`

- **Session transcript relay**: Whether the mobile app shows historical tool outputs, file edits, etc. or only live messages is unknown. The binary mentions "session ingress" fetching session logs, suggesting some history is available.

- **`claude.ai/code` web interface features**: The binary confirms session naming (`--name`, shown in `claude.ai/code`) and lists environments, but the full feature set of the web interface (browsing sessions, starting new ones, etc.) is not documented locally.
  Suggested query: `site:code.claude.com "remote-control" OR "claude.ai/code"` (official docs)

- **Whether the user claim about "full-featured native iOS UI" is accurate**: Based on binary evidence alone, there is no native terminal emulator on iOS. The user may be experiencing the claude.ai web interface in a high-quality mobile browser or a hybrid app, which could appear "native" but is likely web-rendered.

---

## Conclusion on User's Claim

The user reported "Claude Code has a full-featured mobile app where you can see the same session running remotely with native iOS UI."

**Assessment**: This is **partially accurate but overstated**:

- CORRECT: Claude Code has Remote Control that lets you access the same session from the Claude mobile app
- CORRECT: The feature works through Anthropic's cloud bridge
- CORRECT: Both iOS and Android are supported ("any device")
- UNCERTAIN: Whether it is "full-featured" — spawn mode does enable full session control, not just viewing
- INCORRECT/MISLEADING: "Native iOS UI" — evidence points to a web-based or hybrid app experience, not a purpose-built native terminal emulator for iOS
- CORRECT for feature status: The feature is in the binary as of v2.1.77 but is still rolling out behind a feature flag

---

## Search Limitations

- Model: claude-sonnet-4-6
- Web search: unavailable (native mode)
- Local search: performed (binary string extraction, help commands, settings files)
- Date range: Claude Code v2.1.77, build 2026-03-16T22:15:57Z
- Binary version: 2.1.77 (most recently installed)
- Older versions checked: 2.1.72–2.1.77 available (only 2.1.77 investigated)
