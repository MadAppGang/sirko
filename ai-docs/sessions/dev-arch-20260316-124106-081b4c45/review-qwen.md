# Sirko Architecture Review

**Reviewer**: Qwen 3.5 Plus
**Date**: 2026-03-16
**Document Reviewed**: `ai-docs/sessions/dev-arch-20260316-124106-081b4c45/architecture.md`

---

## Executive Summary

This is an exceptionally detailed architecture document for a tmux orchestration system. The hybrid Pipeline/EventBus pattern is well-justified and appropriate for the use case. The document demonstrates deep thinking about edge cases, failure modes, and implementation details.

**Verdict: CONDITIONAL APPROVE**

The architecture is sound, but several HIGH-severity issues should be addressed before implementation begins.

---

## Findings by Severity

### CRITICAL

#### 1. Single Point of Failure: Orchestrator Process

**Issue**: The entire system depends on a single orchestrator process. If it crashes, dies, or becomes unresponsive:
- No new notifications are sent to users
- Voice calls are never initiated
- State may be lost between persistence intervals
- Running tmux panes continue but become unmonitored

**Why Critical**: For a system designed to notify users when agents are waiting, the notification system itself being a single point of failure undermines the core value proposition.

**Recommendation**:
- Add health monitoring with automatic restart (systemd, PM2, or Bun's built-in process management)
- Consider a watchdog that can detect orchestrator failure and send a Telegram alert
- Document expected uptime requirements and recovery procedures

---

### HIGH

#### 2. Race Condition in Quiescence Scheduler

**Issue**: The document acknowledges the `processingCount` race condition but the proposed solution may not be sufficient:

```
setInterval(checkIntervalMs = 500)
  if elapsed >= skill.quiescenceThresholdMs
  && !active  // processingCount check
  && !already
```

The race: `lastOutputTime` is updated when the event arrives, but `processingCount` is only decremented after `next()` resolves. If the scheduler fires between pipeline entry and `state-manager (POST)`, it will see:
- `lastOutputTime` = new timestamp (appears active)
- `processingCount` > 0 (correctly indicates active)

But if the pane has been quiet for a long time BEFORE this event, and this event is the first in a new burst, the scheduler might incorrectly skip a quiescence check that should have fired.

**Recommendation**: Add explicit quiescence timer state to `PaneState`:
```typescript
interface PaneState {
  quiescenceTimerActive: boolean  // true when scheduler is tracking this pane
  quiescenceTimerStart: number | null  // when silence window began
}
```

---

#### 3. EventBus Backpressure Not Addressed

**Issue**: The document states "Bun's native EventEmitter" is used, but doesn't address:
- What happens if a subscriber handler throws and isn't caught?
- What happens if a subscriber is slow (e.g., voice synthesis takes 5 seconds)?
- Are events processed synchronously or asynchronously?

From the document: "Uses `bus.emit()` which is synchronous in Bun"

If synchronous: a slow voice subscriber blocks the logger and telegram subscribers, and blocks the next pipeline event from being processed.

**Recommendation**:
- Make event delivery async with `Promise.allSettled()` for parallel subscriber execution
- Add timeout wrapping for subscribers (e.g., 5-second max per handler)
- Add `SinkError` event emission for subscriber failures with retry metadata
- Document the expected latency budget per subscriber

---

#### 4. Telegram Bot API Version Dependency

**Issue**: The architecture depends on `sendMessageDraft` which is documented as "Telegram Bot API 9.3+". This is:
- A very recent API version (check current stable)
- May not be available in all regions or for all bot tiers
- No fallback is fully specified if this API is unavailable

The document mentions: "if not yet live on Bot API 9.3, fall back to edit-last-message approach" but this fallback has significant complexity:
- Message edit rate limits differ from send limits
- Deleted messages break the edit approach
- Forum topics may not have "last message" semantics

**Recommendation**:
- Verify Bot API 9.3 availability before Phase 3 implementation
- Fully design the edit-message fallback with rate limit handling
- Consider a hybrid: use `sendMessageDraft` if available, otherwise batched `sendMessage` with delete+recreate

---

#### 5. Voice Pipeline Latency Budget is Aggressive

**Issue**: Target latency of 500-800ms is ambitious:
```
= Deepgram final-transcript latency (~200ms)
+ LLM first-token latency (~150ms)
+ ElevenLabs first-audio latency (~150ms)
+ transport/network (~50-100ms)
```

Reality check:
- Deepgram "final" transcript requires end-of-utterance detection, which adds 300-500ms of silence wait time
- LLM 150ms first token assumes a local or very low-latency model; Vercel AI SDK to cloud LLMs typically 200-400ms
- ElevenLabs streaming has ~200-300ms time-to-first-audio in practice
- Twilio WebSocket round-trip adds 50-150ms

Realistic baseline: 800ms-1.5s, potentially disappointing for voice UX.

**Recommendation**:
- Lower user expectations in documentation (target 1s, stretch 500ms)
- Optimize each stage with parallel processing where possible (start LLM summarization before full transcript is complete)
- Consider local TTS (e.g., Piper, Coqui) for faster time-to-first-audio
- Add latency metrics to the logger middleware to identify bottlenecks

---

### MEDIUM

#### 6. No Circuit Breaker for External APIs

**Issue**: The system depends on multiple external APIs (Telegram, Twilio, Deepgram, ElevenLabs, LLM provider). If any API:
- Returns rate-limit errors
- Has an outage
- Times out

There's no circuit breaker pattern described. The rate-limit queue handles Telegram rate limits but not external API failures.

**Impact**: A Deepgram outage would cause voice calls to fail silently or repeatedly until manual intervention.

**Recommendation**:
- Add `CircuitBreaker` utility class to `packages/shared`
- Implement exponential backoff with jitter for retries
- Define `isHealthy()` for each AdapterSink to include circuit state
- Emit `SinkError` events with circuit state for monitoring

---

#### 7. State Store Schema Migration Not Specified

**Issue**: The document mentions "validate schemaVersion (migrate if needed)" but doesn't specify:
- How migrations are defined
- What happens if migration fails mid-process
- Whether old schema versions are preserved during migration

**Recommendation**: Add a `migrations/` directory structure:
```
state-store/src/migrations/
  001-to-v2.ts
  002-to-v3.ts
```

With a migration runner:
```typescript
async migrate(state: any, fromVersion: number, toVersion: number): Promise<any> {
  for (let v = fromVersion; v < toVersion; v++) {
    const migration = migrations[v];
    state = await migration(state);
  }
  return state;
}
```

---

#### 8. No Graceful Shutdown for In-Flight Operations

**Issue**: The document mentions "On graceful shutdown: SIGTERM/SIGINT handler calls `store.persist()`" but doesn't address:
- What happens to in-flight voice calls?
- What happens to pending Telegram messages in the rate-limit queue?
- What happens to events currently in the pipeline?

**Recommendation**:
- Implement shutdown coordinator:
```typescript
async shutdown(signal: string) {
  log.info(`Received ${signal}, initiating graceful shutdown`);
  shutdownState.isShuttingDown = true;

  // 1. Stop accepting new events
  tmuxClient.disconnect();

  // 2. Wait for in-flight pipeline events (max 5s)
  await Promise.race([waitForInFlightComplete(), timeout(5000)]);

  // 3. Flush pending Telegram messages
  await telegramAdapter.drainQueue();

  // 4. End active voice calls gracefully
  await voiceServer.hangupAll();

  // 5. Persist state
  await stateStore.persist();

  process.exit(0);
}
```

---

#### 9. Detection Calibration Strategy Missing

**Issue**: The three-signal weighted heuristic has many tunable parameters:
- Per-tool `promptPatternWeight`, `wchanWeight`, `quiescenceWeight`
- Per-tool `quiescenceThresholdMs`
- Per-tool `scoringThreshold`
- Global `checkIntervalMs`

No calibration strategy is described. How will these be tuned? What metrics define "good" detection?

**Recommendation**:
- Add `detection-observer` utility that logs detection decisions with confidence scores
- Build a simple web UI or CLI tool to review detection history: "When did we notify? When did we miss?"
- Define success metrics: false positive rate < 5%, false negative rate < 2%
- Consider A/B testing different thresholds for new tools

---

#### 10. No Strategy for Handling Pane ID Reuse

**Issue**: When a pane exits and a new pane is created with the same ID (e.g., `%3`), the state store may have stale data:
- Old `lastBufferSnapshot` from previous pane
- Old `notificationState`
- Old `telegramTopicId` mapping (may incorrectly reuse topic)

**Recommendation**:
- On `session-closed` or `pane-exited`, add state cleanup:
```typescript
onPaneExited(paneId: string) {
  const state = store.getPane(paneId);
  if (state) {
    // Preserve topic mapping for recovery BUT mark as stale
    state.topicStale = true;
    state.notificationState = 'idle';
    state.status = 'exited';
  }
}

onNewPane(paneId: string) {
  const existing = store.getPane(paneId);
  if (existing && existing.status !== 'exited') {
    // Collision: force new topic, clear stale state
    existing.telegramTopicId = null;
    existing.lastBufferSnapshot = '';
  }
}
```

---

### LOW

#### 11. Logging Without Log Rotation

**Issue**: Structured JSON logs are emitted to stdout, but no log rotation strategy is specified. Over time:
- stdout buffer may grow unbounded
- Disk space for logs may grow without limit

**Recommendation**: Document log rotation setup (e.g., `logrotate` on Linux, or use Bun's `Console` with file rotation).

---

#### 12. No Observability Dashboard for Phase 1-5

**Issue**: Metrics emission is deferred to Phase 6, but operational visibility is needed from Day 1.

**Recommendation**:
- Add simple metrics endpoint in Phase 2 (`GET /metrics` with Prometheus format)
- Track: pipeline latency, detection accuracy, notification success rate, adapter health

---

#### 13. `@xterm/headless` Dependency Risk

**Issue**: The document notes: "If `@xterm/headless` is not Bun-compatible, a `TerminalEmulator` abstraction allows a fallback"

This is a critical dependency for prompt-pattern detection. If the fallback (`strip-ansi`) is used:
- No actual terminal buffer state
- No cursor position tracking
- Weaker detection capability

**Recommendation**: Test `@xterm/headless` with Bun in Phase 1 as planned. If incompatible, prioritize building a minimal headless terminal emulator that maintains buffer state.

---

#### 14. No Documentation for Error Recovery Procedures

**Issue**: The security section is thorough, but operational runbook is deferred to Phase 6.

**Recommendation**: Draft incident response procedures in Phase 2:
- "Notifications stopped": check orchestrator health, bus subscriber errors
- "Voice calls failing": check Twilio credentials, webhook URL reachability
- "State corrupted": restore from `state.json.bak`

---

## Missing Considerations

### 1. Multi-User / Multi-Team Use Cases

The document assumes single-user or small-team ("private supergroup"). No consideration for:
- Multiple operators with different phone numbers for voice
- Role-based permissions (who can send input vs. who can only observe)
- Notification preferences per user

### 2. Cost Management

External API costs are not estimated:
- Twilio: ~$0.013/min for outbound calls
- Deepgram: ~$0.014/hour of audio
- ElevenLabs: ~$0.30-1.00 per 1000 characters (depending on tier)
- LLM: variable

For a heavily-used system (50 calls/day, 1 min each), monthly cost could be $50-200. No budgeting or cost-alerting is described.

### 3. Testing Real AI Agent Behavior

The `fake-agent.sh` is a good start, but real AI agents have complex output patterns:
- Streaming output with variable timing
- Progress bars and spinners
- Multi-line prompts
- Interactive TUIs (e.g., `htop`, `vim`)

The detection heuristics may behave differently with real agents vs. a simple echo script.

### 4. Version Compatibility Matrix

No compatibility matrix is provided:
- tmux versions (2.x vs 3.x may have control-mode differences)
- Bun versions (pre-1.0 vs 1.0+ may have API changes)
- Telegram Bot API versions

---

## Scalability Analysis

### Vertical Scaling (Single Instance)

The single-threaded design is intentional and correct for the use case. Expected capacity:
- ~10-20 concurrent panes (per NFR-PERF-02 load test)
- ~50-100 events/second through pipeline
- Pipeline latency target: ≤50ms

This should be achievable with Bun's event loop and the minimal middleware design.

### Horizontal Scaling (Not Supported)

The architecture explicitly assumes single-host deployment:
- State is in-memory with file persistence
- EventBus is in-process
- tmux socket is local

If horizontal scaling is needed in the future, significant re-architecture would be required:
- Distributed state store (Redis, Neon as noted)
- Message queue (Redis Pub/Sub, NATS) replacing EventBus
- Stateless orchestrator instances

The document appropriately defers this to "when multi-host deployment is required."

---

## Integration Risk Assessment

| Integration | Risk Level | Notes |
|-------------|------------|-------|
| tmux control-mode | LOW | Stable, decades-old protocol |
| Telegram Bot API | MEDIUM | Recent API features (`sendMessageDraft`) |
| Twilio | LOW | Mature, well-documented API |
| LiveKit | MEDIUM | Less battle-tested than Twilio, Node SDK maturity unknown |
| Deepgram | LOW | Standard WebSocket streaming API |
| ElevenLabs | MEDIUM | Streaming TTS API, latency sensitive |
| Vercel AI SDK | LOW | Abstraction layer, multiple provider fallbacks |
| Bun runtime | MEDIUM | Pre-1.0 volatility, but maturing rapidly |

---

## Positive Observations

The following aspects of the architecture are particularly strong:

1. **Clear separation of concerns**: Pipeline for inbound, EventBus for outbound, clean interface boundaries.

2. **Type-driven design**: Extensive use of TypeScript discriminated unions ensures compile-time safety for event handling.

3. **Defensive error handling**: Each middleware defines error behavior; fallback strategies are documented.

4. **Platform abstraction**: `WchanInspector` cleanly abstracts Linux vs. macOS differences.

5. **Extensibility**: Adding a new CLI tool is a matter of adding a `SkillDefinition` file; adding a new adapter is adding a subscriber.

6. **Security-first mindset**: Threat model, secret management, input sanitization are all considered in v1.

7. **Empirical calibration recognition**: The document acknowledges that detection parameters need real-world tuning.

---

## Recommendations Summary

### Before Implementation (Address Before Phase 1)

1. **Circuit breaker design** for external APIs (HIGH #6)
2. **Graceful shutdown procedures** (HIGH #8)
3. **Schema migration framework** (MEDIUM #7)

### Before Phase 2 (Core Intelligence)

4. **Quiescence scheduler state tracking** (HIGH #2)
5. **Detection calibration tooling** (MEDIUM #9)

### Before Phase 3 (Telegram)

6. **Telegram Bot API 9.3 verification** and fallback design (HIGH #4)

### Before Phase 4 (Voice)

7. **Voice latency profiling** with real API calls (HIGH #5)
8. **Circuit breaker implementation** for voice APIs (MEDIUM #6)

### Before Phase 6 (Polish)

9. **Observability baseline**: basic metrics endpoint (LOW #12)
10. **Operational runbook draft** (LOW #14)

---

## Final Verdict: CONDITIONAL APPROVE

The architecture is fundamentally sound and demonstrates sophisticated thinking about distributed systems, event processing, and failure modes. The hybrid Pipeline/EventBus pattern is appropriate and well-justified.

However, implementation should not proceed until the CRITICAL and HIGH items are addressed, particularly:

1. **Orchestrator SPOF mitigation** (health monitoring, restart strategy)
2. **Quiescence scheduler race condition fix**
3. **EventBus async delivery and error handling**
4. **Circuit breaker pattern for external APIs**

Once these are addressed, the system is well-positioned for successful implementation following the phased plan.

---

## Appendix: Suggested Architecture Additions

### A.1 Health Check Endpoint

Add to `apps/orchestrator`:

```typescript
// GET /health
{
  status: 'healthy' | 'degraded' | 'unhealthy',
  uptime: number,
  panes: { total: number, running: number, awaiting: number },
  adapters: {
    telegram: { healthy: boolean, lastEvent: number },
    voice: { healthy: boolean, activeCalls: number }
  },
  circuits: {
    telegram: 'closed' | 'open' | 'half-open',
    twilio: 'closed' | 'open' | 'half-open',
    deepgram: 'closed' | 'open' | 'half-open',
    elevenlabs: 'closed' | 'open' | 'half-open'
  }
}
```

### A.2 Circuit Breaker Interface

```typescript
interface CircuitBreaker {
  state: 'closed' | 'open' | 'half-open';
  execute<T>(fn: () => Promise<T>): Promise<T>;
  recordSuccess(): void;
  recordFailure(): void;
}
```

### A.3 Shutdown Coordinator

```typescript
interface ShutdownCoordinator {
  isShuttingDown: boolean;
  registerCleanup(name: string, fn: () => Promise<void>): void;
  initiate(signal: string): Promise<void>;
  addInFlight(): InFlightToken;  // reference counting
}
```

---

*End of review.*
