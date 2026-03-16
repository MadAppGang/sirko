# Code Review Report: Sirko Project

**Review Date:** 2026-03-16
**Reviewer:** Claude Code (Automated Review)
**Scope:** All source files in packages/shared, packages/tmux-client, packages/state-store, packages/event-bus, packages/tool-plugins, packages/detector, packages/pipeline, apps/orchestrator, apps/telegram-bot, apps/voice-server
**Level:** Very Thorough

---

## Executive Summary

**Verdict:** CONDITIONAL

This is a well-architected monorepo implementing a hybrid pipeline+eventbus system for monitoring AI coding tool sessions (Claude Code, Codex, Aider) via tmux, with Telegram and Voice (Twilio) notification adapters. The codebase demonstrates strong TypeScript practices, good separation of concerns, and thoughtful design patterns (circuit breakers, rate limiting, bounded queues).

However, the review identified **1 CRITICAL** security issue (command injection risk in tmux client) and **3 HIGH** severity issues related to input validation, error handling, and state management. These should be addressed before production deployment.

---

## CRITICAL Issues (1)

### Issue 1: Command Injection Risk in Tmux Client
- **Location:** /Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts
- **Lines:** 112-149 (multiple locations)
- **Problem:** The sendKeys, capturePane, getPanePid, and other methods construct tmux commands with unsanitized paneId and sessionId parameters.

**Why problematic:**

The paneId parameter is interpolated directly into the command string. While JSON.stringify(text) protects the text input, paneId receives no validation. A malicious pane ID like %3; rm -rf ~ could execute arbitrary shell commands.

Similar patterns exist in:
- Line 116: capture-pane -t ${paneId} -p
- Line 122: display-message -t ${paneId} -p "#{pane_pid}"
- Line 132: new-session -d -s ${name} -P -F "#{session_id}"
- Line 139: new-window -t ${sessionId} -P -F "#{window_id}"
- Line 145: split-window -t ${windowId} -P -F "#{pane_id}"

**Impact:** If an attacker can control pane/session/window IDs (e.g., through the Telegram bot's /kill command or session creation), they could achieve arbitrary command execution on the host.

**Suggestion:**
1. Add strict validation for pane ID format using a regex like /^%[0-9]+$/ for pane IDs and /^\$[0-9]+$/ for session IDs
2. For new-session, validate the session name to only allow safe characters (alphanumeric, dash, underscore)
3. Add a test case for malicious input in client.test.ts

---

## HIGH Issues (3)

### Issue 2: Telegram Bot /kill Command Allows Arbitrary Pane Termination
- **Location:** /Users/jack/mag/magai/sirko/apps/telegram-bot/src/commands.ts
- **Lines:** 67-84
- **Problem:** The /kill command accepts any paneId from user input without validation or authorization check.

**Why problematic:**

Any user who can send messages to the bot can kill any tmux pane, not just those created by the orchestrator.

**Impact:** Privilege escalation - users can kill arbitrary tmux panes on the system.

**Suggestion:**
1. Validate paneId against known panes in the StateStore before allowing termination
2. Add an authorization check to ensure the user is authorized to kill that specific pane
3. Consider adding a confirmation step for destructive commands

### Issue 3: Unbounded Cache in MacosWchan
- **Location:** /Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts
- **Lines:** 30-63
- **Problem:** The MacosWchan class uses a Map for caching that grows without bounds.

**Why problematic:**

The cache has a TTL per entry, but there's no mechanism to clean up old entries when the map grows large. In a long-running process monitoring many panes, this will cause a memory leak.

**Impact:** Memory leak leading to eventual out-of-memory crash in long-running orchestrator.

**Suggestion:**
Add periodic cleanup of expired entries or limit the maximum cache size.

### Issue 4: Orchestrator Ignores Shutdown Errors
- **Location:** /Users/jack/mag/magai/sirko/apps/orchestrator/src/index.ts
- **Lines:** 96-116
- **Problem:** The shutdown handler always calls process.exit(0) regardless of whether cleanup succeeded.

**Why problematic:**

If persist() or disconnect() fails, the error is logged but process.exit(0) still runs after the catch block in shutdown().

**Impact:** Failed state persistence or tmux disconnection is not reported as a failure, making debugging difficult. CI/CD systems cannot detect shutdown failures.

**Suggestion:**
Wrap the entire shutdown logic in a try/catch and exit with code 1 on any error.

---

## MEDIUM Issues (3)

### Issue 5: Missing Input Sanitization in Message Router
- **Location:** /Users/jack/mag/magai/sirko/apps/telegram-bot/src/message-router.ts
- **Lines:** 24-43
- **Problem:** User text from Telegram messages is sent directly to tmux without sanitization.

**Why problematic:**

While sendKeys uses JSON.stringify for the text, control characters (like newlines) could affect tmux state unexpectedly.

**Impact:** Users can send special characters/sequences that may affect terminal state in unexpected ways.

**Suggestion:** Apply the sanitizeForSendKeys utility from @sirko/shared to user input before sending to tmux.

### Issue 6: Fire-and-Forget in Output Archive Middleware
- **Location:** /Users/jack/mag/magai/sirko/packages/pipeline/src/middleware/output-archive.ts
- **Lines:** 44-56
- **Problem:** File I/O operations are initiated but errors are silently swallowed.

**Why problematic:**

This pattern is used throughout. If disk is full or permissions are wrong, output will be silently lost with no visibility.

**Impact:** Silent data loss - output logs may be incomplete without any indication to operators.

**Suggestion:** At minimum, log a warning when file operations fail.

### Issue 7: Regex Pattern State Issues in PromptMatcher
- **Location:** /Users/jack/mag/magai/sirko/packages/detector/src/prompt-matcher.ts
- **Lines:** 13-20
- **Problem:** RegExp objects have internal state that persists across .test() calls when using the g (global) flag.

**Why problematic:**

While the current patterns in skill.promptPatterns don't use the g flag, this is a fragile pattern - if someone adds a pattern with g flag, it will cause incorrect behavior.

**Impact:** Potential false negatives in detection if patterns are modified to use global flag.

**Suggestion:** Document this constraint in code comments, or use pattern.test(String(buffer)) with explicit lastIndex = 0 reset.

---

## LOW Issues (3)

### Issue 8: No API Key Validation on Startup
- **Location:** Multiple files (twilio-transport.ts, voice-pipeline.ts, context-summarizer.ts)
- **Problem:** API keys (Twilio auth token, Deepgram, ElevenLabs, OpenAI) are passed to constructors but never validated. The service will fail at runtime when making the first API call.

**Impact:** Delayed failure discovery - only discovered when first making an outbound call or transcription request.

**Suggestion:** Add a validate() method to each transport/adapter that tests credentials on startup.

### Issue 9: Duplicate Exports in Format Module
- **Location:** /Users/jack/mag/magai/sirko/apps/telegram-bot/src/format.ts
- **Lines:** 49, 16
- **Problem:** escapeHtml is both exported at line 49 and re-exported within the function at line 16.

**Impact:** Confusing code structure (though functional).

### Issue 10: Hardcoded Magic Numbers
- **Location:** Multiple files
- **Problem:** Various magic numbers are used without explanation (e.g., queue size 1000, debounce 100ms, thresholds).

**Impact:** Maintainability - future developers must hunt for these values to tune performance.

**Suggestion:** Create a dedicated constants.ts file with documented values.

---

## Positive Observations

The codebase demonstrates several excellent patterns:

1. **Good TypeScript Practices:** Strong typing throughout, proper use of discriminated unions for events, generic type constraints in middleware.

2. **Security-Conscious HTML Handling:** Proper HTML escaping in html-utils.ts prevents XSS in Telegram messages.

3. **Defensive Programming:** Circuit breakers protect external API calls (Deepgram, ElevenLabs, Twilio).

4. **Clean Architecture:** Clear separation between packages (tmux-client, detector, pipeline, event-bus) with well-defined interfaces.

5. **Graceful Degradation:** BufferEmulator fallback when @xterm/headless is unavailable.

6. **Event Isolation:** EventBus uses Promise.allSettled so one handler's error doesn't break others.

7. **State Management:** PaneSerializer ensures per-pane serialization while allowing concurrent pane processing.

8. **Proper Error Handling:** Most async operations have try/catch with meaningful error messages.

---

## Verdict Details

- **CRITICAL:** 1
- **HIGH:** 3
- **MEDIUM:** 3
- **LOW:** 3
- **Total:** 10 issues (clustered to 7 priority findings)

**Result:** CONDITIONAL

The project has 1 critical command injection vulnerability that must be fixed before any production deployment. The 3 HIGH issues should also be addressed as they represent significant runtime risks (memory leak, failed shutdown detection, privilege escalation).

---

## Recommendations

### Immediate (Before Production)
1. Fix command injection in tmux client (Issue 1)
2. Add pane ID validation to /kill command (Issue 2)
3. Fix shutdown error handling (Issue 4)

### Short-term (Next Sprint)
4. Fix unbounded cache in MacosWchan (Issue 3)
5. Add input sanitization to message router (Issue 5)
6. Improve error visibility in output archive (Issue 6)

### Long-term (Backlog)
7. Add startup API key validation (Issue 8)
8. Document magic numbers in constants
9. Add comprehensive integration tests with malicious input

---

## Test Coverage Assessment

The codebase includes unit tests for:
- events.test.ts (packages/shared)
- parser.test.ts, coalescer.test.ts, client.test.ts (packages/tmux-client)
- state-store.test.ts, migrations.test.ts (packages/state-store)
- event-bus.test.ts (packages/event-bus)
- registry.test.ts, detect.test.ts (packages/tool-plugins)
- wchan.test.ts, prompt-matcher.test.ts, engine.test.ts (packages/detector)
- compose.test.ts, assemble.test.ts, dedup.test.ts, detection.test.ts (packages/pipeline)
- orchestrator.test.ts (apps/orchestrator)
- voice-adapter.test.ts (apps/voice-server)

**Gap:** No security-focused tests for command injection, input validation, or malicious payload handling. Recommend adding fuzzing tests for message router and tmux command inputs.
