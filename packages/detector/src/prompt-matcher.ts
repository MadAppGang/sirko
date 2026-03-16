import type { SkillDefinition } from '@sirko/tool-plugins'

export interface PromptMatchResult {
  matched: boolean
  pattern: string | null
}

export class PromptMatcher {
  /**
   * Check whether any of the skill's promptPatterns match the given buffer text.
   * Tests each pattern against buffer. Returns first match or { matched: false, pattern: null }.
   */
  match(buffer: string, skill: SkillDefinition): PromptMatchResult {
    for (const pattern of skill.promptPatterns) {
      if (pattern.test(buffer)) {
        return { matched: true, pattern: pattern.toString() }
      }
    }
    return { matched: false, pattern: null }
  }
}
