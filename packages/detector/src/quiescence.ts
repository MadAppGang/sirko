import type { PaneState } from '@sirko/shared'
import type { SkillDefinition } from '@sirko/tool-plugins'

export interface QuiescenceScore {
  silenceMs: number
  threshold: number
  score: number
}

export class QuiescenceTracker {
  /**
   * Returns quiescence signal score in [0, 1].
   * score = min(silenceMs / skill.quiescenceThresholdMs, 1.0)
   */
  computeScore(pane: PaneState, skill: SkillDefinition): QuiescenceScore {
    const now = Date.now()
    const silenceMs = now - pane.lastOutputTime
    const threshold = skill.quiescenceThresholdMs
    const score = Math.min(silenceMs / threshold, 1.0)
    return { silenceMs, threshold, score }
  }
}
