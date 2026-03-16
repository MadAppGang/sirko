import { describe, it, expect } from 'bun:test'
import { PromptMatcher } from './prompt-matcher.js'
import { claudeCodeSkill } from '@sirko/tool-plugins'
import { aiderSkill } from '@sirko/tool-plugins'
import { codexSkill } from '@sirko/tool-plugins'

describe('PromptMatcher', () => {
  const matcher = new PromptMatcher()

  describe('with claudeCodeSkill', () => {
    it('matches "> " prompt pattern', () => {
      const result = matcher.match('> ', claudeCodeSkill)
      expect(result.matched).toBe(true)
      expect(result.pattern).not.toBeNull()
    })

    it('matches buffer ending with "> " on its own line', () => {
      const buffer = 'some output\nmore output\n> '
      const result = matcher.match(buffer, claudeCodeSkill)
      expect(result.matched).toBe(true)
    })

    it('does not match "computing..." text', () => {
      const result = matcher.match('computing...', claudeCodeSkill)
      expect(result.matched).toBe(false)
      expect(result.pattern).toBeNull()
    })

    it('does not match partial prompt mid-line', () => {
      const result = matcher.match('running > step', claudeCodeSkill)
      expect(result.matched).toBe(false)
    })
  })

  describe('with aiderSkill', () => {
    it('matches "(y/n)" confirmation prompt', () => {
      const result = matcher.match('Apply changes? (y/n)', aiderSkill)
      expect(result.matched).toBe(true)
    })

    it('matches "[Yes]" option', () => {
      const result = matcher.match('Choose: [Yes] [No]', aiderSkill)
      expect(result.matched).toBe(true)
    })
  })

  describe('with codexSkill', () => {
    it('matches "? " question prompt', () => {
      const result = matcher.match('? Select option:', codexSkill)
      expect(result.matched).toBe(true)
    })

    it('matches "Continue?" text', () => {
      const result = matcher.match('Continue?', codexSkill)
      expect(result.matched).toBe(true)
    })
  })
})
