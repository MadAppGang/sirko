import type { PaneState, DetectionResult } from '@sirko/shared'
import type { SkillDefinition } from '@sirko/tool-plugins'
import { type WchanInspector, createWchanInspector } from './wchan.js'
import { PromptMatcher } from './prompt-matcher.js'
import { QuiescenceTracker } from './quiescence.js'

export interface DetectorEngineOptions {
  wchanInspector?: WchanInspector   // injectable for testing
}

export class DetectorEngine {
  private readonly wchanInspector: WchanInspector
  private readonly promptMatcher: PromptMatcher
  private readonly quiescenceTracker: QuiescenceTracker

  constructor(options?: DetectorEngineOptions) {
    this.wchanInspector = options?.wchanInspector ?? createWchanInspector()
    this.promptMatcher = new PromptMatcher()
    this.quiescenceTracker = new QuiescenceTracker()
  }

  /**
   * Main method: computes weighted detection score for a pane.
   *
   * Scoring formula:
   *   score = (S_prompt * skill.promptPatternWeight)
   *         + (S_wchan  * skill.wchanWeight)
   *         + (S_quiescence * skill.quiescenceWeight)
   *   awaiting = score >= skill.scoringThreshold
   */
  async computeScore(
    pane: PaneState,
    xtermBuffer: string,
    skill: SkillDefinition,
  ): Promise<DetectionResult> {
    // 1. Prompt pattern signal
    const promptResult = this.promptMatcher.match(xtermBuffer, skill)
    const sPrompt = promptResult.matched ? 1.0 : 0.0
    const promptContribution = sPrompt * skill.promptPatternWeight

    // 2. Wchan signal
    let wchanValue: string | null = null
    let isWaiting = false
    if (pane.pid !== null) {
      wchanValue = await this.wchanInspector.readWchan(pane.pid)
      if (wchanValue !== null) {
        isWaiting = skill.wchanWaitValues.includes(wchanValue)
      }
    }
    const sWchan = isWaiting ? 1.0 : 0.0
    const wchanContribution = sWchan * skill.wchanWeight

    // 3. Quiescence signal
    const quiescenceResult = this.quiescenceTracker.computeScore(pane, skill)
    const quiescenceContribution = quiescenceResult.score * skill.quiescenceWeight

    // 4. Final score
    const score = promptContribution + wchanContribution + quiescenceContribution
    const awaiting = score >= skill.scoringThreshold

    return {
      score,
      awaiting,
      tool: skill.name,
      confidence: score,
      signals: {
        promptPattern: {
          matched: promptResult.matched,
          pattern: promptResult.pattern,
          weight: skill.promptPatternWeight,
          contribution: promptContribution,
        },
        wchan: {
          value: wchanValue,
          isWaiting,
          weight: skill.wchanWeight,
          contribution: wchanContribution,
        },
        quiescence: {
          silenceMs: quiescenceResult.silenceMs,
          threshold: quiescenceResult.threshold,
          weight: skill.quiescenceWeight,
          contribution: quiescenceContribution,
        },
      },
    }
  }
}

export function createDetectorEngine(options?: DetectorEngineOptions): DetectorEngine {
  return new DetectorEngine(options)
}
