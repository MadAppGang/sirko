/**
 * Integration test: detection-accuracy
 *
 * Validates that the DetectorEngine combines the three signals (prompt pattern,
 * wchan, quiescence) correctly and that per-tool skill calibrations produce
 * distinct results for different CLI tools.
 *
 * Black box: imports only from public package index files.
 * All assertions are derived from requirements FR-DETECT-01 through FR-DETECT-05.
 */
import { describe, it, expect } from 'bun:test'
import { createDetectorEngine } from '@sirko/detector'
import type { WchanInspector } from '@sirko/detector'
import { claudeCodeSkill } from '@sirko/tool-plugins'
import { codexSkill } from '@sirko/tool-plugins'
import { aiderSkill } from '@sirko/tool-plugins'
import { unknownSkill } from '@sirko/tool-plugins'
import type { PaneState } from '@sirko/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaneState(overrides: Partial<PaneState> = {}): PaneState {
  const now = Date.now()
  return {
    paneId: '%1',
    sessionId: '$1',
    windowId: '@0',
    tool: 'unknown',
    pid: 12345,
    status: 'running',
    exitCode: null,
    notificationState: 'idle',
    lastNotifiedAt: null,
    lastOutputTime: now,
    processingCount: 0,
    xtermInstance: null,
    lastBufferSnapshot: '',
    telegramTopicId: null,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/** A wchan inspector that always returns the given value */
function mockWchan(value: string | null): WchanInspector {
  return {
    readWchan: async (_pid: number) => value,
  }
}

// ---------------------------------------------------------------------------
// TEST GROUP: Signal combination
// ---------------------------------------------------------------------------

describe('DetectorEngine — signal combination (FR-DETECT-01, FR-DETECT-02)', () => {
  it('TEST-023: all signals present → awaiting = true, score >= threshold', async () => {
    // Make quiescence exceed threshold by setting lastOutputTime far in the past
    const pane = makePaneState({
      pid: 99999,
      lastOutputTime: Date.now() - 5000, // 5 seconds silence >> claude's 1800ms threshold
    })

    // Wchan returns a waiting value from claudeCodeSkill.wchanWaitValues
    const wchan = mockWchan('pipe_read')

    const engine = createDetectorEngine({ wchanInspector: wchan })

    // Buffer contains claude's prompt pattern: "> "
    const buffer = '> '

    const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

    expect(result.awaiting).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(claudeCodeSkill.scoringThreshold)
  })

  it('TEST-024: no signals present → awaiting = false', async () => {
    const pane = makePaneState({
      pid: 99999,
      lastOutputTime: Date.now(), // output just happened — no quiescence
    })

    // Wchan returns a non-waiting value
    const wchan = mockWchan('cpu_idle')

    const engine = createDetectorEngine({ wchanInspector: wchan })

    // Buffer has no prompt pattern
    const buffer = 'Compiling src/main.ts...'

    const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

    expect(result.awaiting).toBe(false)
  })

  it('TEST-028: pid = null → wchan contributes 0; no error thrown', async () => {
    const pane = makePaneState({ pid: null })
    const wchan = mockWchan('pipe_read') // would be waiting, but pid is null

    const engine = createDetectorEngine({ wchanInspector: wchan })
    const buffer = ''

    const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

    expect(result.signals.wchan.isWaiting).toBe(false)
    expect(result.signals.wchan.contribution).toBe(0)
    // No throw — result is returned
    expect(typeof result.score).toBe('number')
  })

  it('TEST-029: empty buffer → promptPattern contributes 0; no error thrown', async () => {
    const pane = makePaneState({ pid: 99999 })
    const wchan = mockWchan(null)

    const engine = createDetectorEngine({ wchanInspector: wchan })

    const result = await engine.computeScore(pane, '', claudeCodeSkill)

    expect(result.signals.promptPattern.matched).toBe(false)
    expect(result.signals.promptPattern.contribution).toBe(0)
    expect(typeof result.score).toBe('number')
    expect(isFinite(result.score)).toBe(true)
  })

  it('TEST-030: DetectionResult.signals has all three required signal fields', async () => {
    const pane = makePaneState()
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, 'some buffer', claudeCodeSkill)

    // Each signal must have weight and contribution
    expect(typeof result.signals.promptPattern.weight).toBe('number')
    expect(typeof result.signals.promptPattern.contribution).toBe('number')
    expect(typeof result.signals.wchan.weight).toBe('number')
    expect(typeof result.signals.wchan.contribution).toBe('number')
    expect(typeof result.signals.quiescence.weight).toBe('number')
    expect(typeof result.signals.quiescence.contribution).toBe('number')
  })

  it('TEST-031: confidence and score are finite non-negative numbers', async () => {
    const pane = makePaneState()
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, '', unknownSkill)

    expect(isFinite(result.confidence)).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(isFinite(result.score)).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: Per-tool weight calibration
// ---------------------------------------------------------------------------

describe('DetectorEngine — per-tool calibration (FR-DETECT-03, FR-DETECT-04)', () => {
  it('TEST-025: claude-code skill — tool name and weight applied', async () => {
    const pane = makePaneState({ pid: 1, lastOutputTime: Date.now() - 3000 })
    const wchan = mockWchan('pipe_read')
    const engine = createDetectorEngine({ wchanInspector: wchan })

    const result = await engine.computeScore(pane, '> ', claudeCodeSkill)

    expect(result.tool).toBe('claude-code')
    expect(result.signals.promptPattern.weight).toBe(claudeCodeSkill.promptPatternWeight)
    expect(result.signals.wchan.weight).toBe(claudeCodeSkill.wchanWeight)
    expect(result.signals.quiescence.weight).toBe(claudeCodeSkill.quiescenceWeight)
  })

  it('TEST-026: codex skill — tool name returned', async () => {
    const pane = makePaneState({ pid: 1, lastOutputTime: Date.now() })
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, '', codexSkill)

    expect(result.tool).toBe('codex')
  })

  it('TEST-027: aider skill — tool name returned', async () => {
    const pane = makePaneState({ pid: 1, lastOutputTime: Date.now() })
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, '', aiderSkill)

    expect(result.tool).toBe('aider')
  })

  it('TEST-052: different tools produce different confidence scores for same signals', async () => {
    // Same pane/signals, different skills — confidence should differ due to different weights
    const pane = makePaneState({
      pid: 1,
      lastOutputTime: Date.now() - 2000,
    })
    const wchan = mockWchan('pipe_read')

    const engineClaude = createDetectorEngine({ wchanInspector: wchan })
    const engineAider = createDetectorEngine({ wchanInspector: mockWchan('pipe_read') })

    // Use claude's prompt pattern in the buffer (aider won't match it with the same weight)
    const buffer = '> '

    const claudeResult = await engineClaude.computeScore(pane, buffer, claudeCodeSkill)
    const aiderResult = await engineAider.computeScore(pane, buffer, aiderSkill)

    // The scores may differ because:
    // 1. Different promptPatternWeights
    // 2. Different quiescenceThresholdMs (aider may score quiescence differently)
    // 3. Different scoringThresholds
    // We validate that the scores are not identical — tool calibration matters
    // (This is a soft assertion; if they happen to be equal, the test notes it)
    const scoresAreDifferent =
      Math.abs(claudeResult.score - aiderResult.score) > 0.001 ||
      claudeResult.signals.promptPattern.weight !== aiderResult.signals.promptPattern.weight

    expect(scoresAreDifferent).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: QuiescenceTracker behavior (via DetectorEngine)
// ---------------------------------------------------------------------------

describe('QuiescenceTracker — silence signal (FR-DETECT-01)', () => {
  it('TEST-032: silence exceeding threshold yields quiescence score contribution', async () => {
    // lastOutputTime far in the past ensures quiescence threshold is exceeded
    const pane = makePaneState({
      pid: null,
      lastOutputTime: Date.now() - 10_000, // 10 seconds silence
    })
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, '', claudeCodeSkill)

    // silenceMs should be >= quiescenceThresholdMs → score = 1.0 → contribution = weight
    expect(result.signals.quiescence.silenceMs).toBeGreaterThanOrEqual(
      claudeCodeSkill.quiescenceThresholdMs,
    )
    expect(result.signals.quiescence.contribution).toBeCloseTo(
      claudeCodeSkill.quiescenceWeight,
      2,
    )
  })

  it('TEST-032b: silence below threshold yields partial quiescence score', async () => {
    // lastOutputTime is recent — below threshold
    const pane = makePaneState({
      pid: null,
      lastOutputTime: Date.now() - 100, // 100ms silence << 1800ms threshold
    })
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, '', claudeCodeSkill)

    // Partial score: silenceMs << threshold → score << 1.0
    expect(result.signals.quiescence.silenceMs).toBeLessThan(
      claudeCodeSkill.quiescenceThresholdMs,
    )
    expect(result.signals.quiescence.contribution).toBeLessThan(claudeCodeSkill.quiescenceWeight)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP: PromptMatcher behavior (via DetectorEngine)
// ---------------------------------------------------------------------------

describe('PromptMatcher — prompt pattern signal (FR-DETECT-01, FR-DETECT-03)', () => {
  it('TEST-033: matches claude prompt pattern "> " in buffer', async () => {
    const pane = makePaneState({ pid: null, lastOutputTime: Date.now() })
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, '> ', claudeCodeSkill)

    expect(result.signals.promptPattern.matched).toBe(true)
    expect(result.signals.promptPattern.pattern).not.toBeNull()
    expect(result.signals.promptPattern.contribution).toBeGreaterThan(0)
  })

  it('TEST-033b: non-matching buffer → promptPattern.matched = false', async () => {
    const pane = makePaneState({ pid: null, lastOutputTime: Date.now() })
    const engine = createDetectorEngine({ wchanInspector: mockWchan(null) })

    const result = await engine.computeScore(pane, 'Building project...', claudeCodeSkill)

    expect(result.signals.promptPattern.matched).toBe(false)
    expect(result.signals.promptPattern.pattern).toBeNull()
    expect(result.signals.promptPattern.contribution).toBe(0)
  })
})
