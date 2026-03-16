import { describe, it, expect } from 'bun:test'
import { getSkill, getAllSkills } from './registry.js'
import { unknownSkill } from './plugins/unknown.js'
import { claudeCodeSkill } from './plugins/claude-code.js'

describe('getSkill', () => {
  it('returns the claude-code skill for claude-code', () => {
    const skill = getSkill('claude-code')
    expect(skill.name).toBe('claude-code')
    expect(skill.displayName).toBe('Claude Code')
  })

  it('returns the aider skill for aider', () => {
    const skill = getSkill('aider')
    expect(skill.name).toBe('aider')
  })

  it('returns the codex skill for codex', () => {
    const skill = getSkill('codex')
    expect(skill.name).toBe('codex')
  })

  it('returns the unknown skill for unknown', () => {
    const skill = getSkill('unknown')
    expect(skill.name).toBe('unknown')
  })

  it('returns unknownSkill for an unregistered tool name', () => {
    // Cast to ToolName for testing fallback
    const skill = getSkill('nonexistent' as Parameters<typeof getSkill>[0])
    expect(skill).toBe(unknownSkill)
  })
})

describe('getAllSkills', () => {
  it('returns all 4 skills including unknown', () => {
    const skills = getAllSkills()
    expect(skills.length).toBe(4)
  })

  it('includes claude-code skill', () => {
    const skills = getAllSkills()
    expect(skills.some(s => s.name === 'claude-code')).toBe(true)
  })
})

describe('SkillDefinition validation', () => {
  it('each skill has all required fields', () => {
    const skills = getAllSkills()
    for (const skill of skills) {
      expect(typeof skill.name).toBe('string')
      expect(typeof skill.displayName).toBe('string')
      expect(skill.binaryPattern).toBeInstanceOf(RegExp)
      expect(skill.processNamePattern).toBeInstanceOf(RegExp)
      expect(Array.isArray(skill.promptPatterns)).toBe(true)
      expect(skill.promptPatterns.length).toBeGreaterThan(0)
      expect(typeof skill.promptPatternWeight).toBe('number')
      expect(typeof skill.quiescenceThresholdMs).toBe('number')
      expect(typeof skill.quiescenceWeight).toBe('number')
      expect(Array.isArray(skill.wchanWaitValues)).toBe(true)
      expect(typeof skill.wchanWeight).toBe('number')
      expect(typeof skill.scoringThreshold).toBe('number')
    }
  })

  it('each skill has positive weights for all signals', () => {
    const skills = getAllSkills()
    for (const skill of skills) {
      expect(skill.promptPatternWeight).toBeGreaterThan(0)
      expect(skill.quiescenceWeight).toBeGreaterThan(0)
      expect(skill.wchanWeight).toBeGreaterThan(0)
    }
  })

  it('claude-code has correct quiescence threshold', () => {
    expect(claudeCodeSkill.quiescenceThresholdMs).toBe(1800)
  })

  it('claude-code has correct scoring threshold', () => {
    expect(claudeCodeSkill.scoringThreshold).toBe(0.60)
  })
})
