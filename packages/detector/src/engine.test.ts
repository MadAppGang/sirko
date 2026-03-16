import { describe, it, expect } from 'bun:test'
import { DetectorEngine } from './engine.js'
import type { WchanInspector } from './wchan.js'
import { claudeCodeSkill, aiderSkill } from '@sirko/tool-plugins'
import type { PaneState } from '@sirko/shared'
import { QuiescenceTracker } from './quiescence.js'

function makePaneState(overrides?: Partial<PaneState>): PaneState {
  return {
    paneId: 'test-pane',
    sessionId: 'test-session',
    windowId: 'test-window',
    tool: 'claude-code',
    pid: 12345,
    status: 'running',
    exitCode: null,
    notificationState: 'idle',
    lastNotifiedAt: null,
    lastOutputTime: Date.now() - 5000, // 5s ago — well past any threshold
    processingCount: 0,
    xtermInstance: null,
    lastBufferSnapshot: '',
    telegramTopicId: null,
    schemaVersion: 1,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
    ...overrides,
  }
}

// Mock WchanInspector that always returns a waiting value
const waitingWchan: WchanInspector = {
  readWchan: async (_pid: number) => 'pipe_read',
}

// Mock WchanInspector that always returns a non-waiting value
const notWaitingWchan: WchanInspector = {
  readWchan: async (_pid: number) => 'do_select',
}

// Mock WchanInspector that returns null
const nullWchan: WchanInspector = {
  readWchan: async (_pid: number) => null,
}

describe('DetectorEngine', () => {
  describe('computeScore with all 3 signals positive', () => {
    it('returns score equal to sum of all weights', async () => {
      const engine = new DetectorEngine({ wchanInspector: waitingWchan })
      const pane = makePaneState({ lastOutputTime: Date.now() - 10000 })
      // Buffer with prompt pattern matching claude-code
      const buffer = '> '
      const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

      // All signals max → score = promptWeight + wchanWeight + quiescenceWeight
      const expectedMax =
        claudeCodeSkill.promptPatternWeight +
        claudeCodeSkill.wchanWeight +
        claudeCodeSkill.quiescenceWeight

      expect(result.score).toBeCloseTo(expectedMax, 5)
      expect(result.awaiting).toBe(true)
      expect(result.tool).toBe('claude-code')
    })
  })

  describe('computeScore with all signals 0', () => {
    it('returns score of 0 and awaiting=false', async () => {
      const engine = new DetectorEngine({ wchanInspector: notWaitingWchan })
      // lastOutputTime = now (0ms silence → quiescence score = 0)
      const pane = makePaneState({ lastOutputTime: Date.now() })
      const buffer = 'no prompt here, just computing...'
      const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

      expect(result.score).toBeCloseTo(0.0, 1)
      expect(result.awaiting).toBe(false)
    })
  })

  describe('computeScore with only prompt pattern', () => {
    it('uses prompt contribution when wchan and quiescence are 0', async () => {
      const engine = new DetectorEngine({ wchanInspector: notWaitingWchan })
      const pane = makePaneState({ lastOutputTime: Date.now() })
      const buffer = '> '
      const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

      // Only prompt matches
      expect(result.signals.promptPattern.matched).toBe(true)
      expect(result.signals.wchan.isWaiting).toBe(false)
      expect(result.signals.promptPattern.contribution).toBeCloseTo(
        claudeCodeSkill.promptPatternWeight,
        5,
      )
    })
  })

  describe('computeScore with only quiescence', () => {
    it('uses quiescence contribution when prompt and wchan are 0', async () => {
      const engine = new DetectorEngine({ wchanInspector: notWaitingWchan })
      // 10 seconds of silence — past threshold
      const pane = makePaneState({ lastOutputTime: Date.now() - 10000 })
      const buffer = 'no prompt here'
      const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

      // Quiescence contribution should be near maximum (silence >> threshold)
      expect(result.signals.quiescence.contribution).toBeGreaterThan(0)
      expect(result.signals.promptPattern.matched).toBe(false)
      expect(result.signals.wchan.isWaiting).toBe(false)
    })
  })

  describe('tool-specific weight overrides', () => {
    it('uses aider skill weights for aider tool', async () => {
      const engine = new DetectorEngine({ wchanInspector: waitingWchan })
      const pane = makePaneState({ tool: 'aider', lastOutputTime: Date.now() - 10000 })
      const buffer = '> '
      const result = await engine.computeScore(pane, buffer, aiderSkill)

      const expectedMax =
        aiderSkill.promptPatternWeight +
        aiderSkill.wchanWeight +
        aiderSkill.quiescenceWeight

      expect(result.score).toBeCloseTo(expectedMax, 5)
      expect(result.tool).toBe('aider')
    })
  })

  describe('confidence scoring', () => {
    it('confidence equals score', async () => {
      const engine = new DetectorEngine({ wchanInspector: nullWchan })
      const pane = makePaneState({ lastOutputTime: Date.now() - 3000 })
      const buffer = '> '
      const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

      expect(result.confidence).toBe(result.score)
    })
  })

  describe('null pid handling', () => {
    it('treats wchan as non-waiting when pid is null', async () => {
      const engine = new DetectorEngine({ wchanInspector: waitingWchan })
      const pane = makePaneState({ pid: null, lastOutputTime: Date.now() - 10000 })
      const buffer = '> '
      const result = await engine.computeScore(pane, buffer, claudeCodeSkill)

      expect(result.signals.wchan.isWaiting).toBe(false)
      expect(result.signals.wchan.value).toBeNull()
    })
  })
})

describe('QuiescenceTracker', () => {
  const tracker = new QuiescenceTracker()

  it('returns score of 1.0 when silenceMs >= threshold', () => {
    const pane = makePaneState({
      lastOutputTime: Date.now() - claudeCodeSkill.quiescenceThresholdMs,
    })
    const result = tracker.computeScore(pane, claudeCodeSkill)
    expect(result.score).toBeCloseTo(1.0, 1)
  })

  it('returns score of 0.0 when silenceMs = 0', () => {
    const pane = makePaneState({ lastOutputTime: Date.now() })
    const result = tracker.computeScore(pane, claudeCodeSkill)
    expect(result.score).toBeCloseTo(0.0, 1)
  })

  it('returns partial score for half threshold silence', () => {
    const pane = makePaneState({
      lastOutputTime: Date.now() - claudeCodeSkill.quiescenceThresholdMs / 2,
    })
    const result = tracker.computeScore(pane, claudeCodeSkill)
    expect(result.score).toBeCloseTo(0.5, 1)
  })

  it('does not exceed 1.0 for very long silence', () => {
    const pane = makePaneState({ lastOutputTime: Date.now() - 1000000 })
    const result = tracker.computeScore(pane, claudeCodeSkill)
    expect(result.score).toBe(1.0)
  })
})
