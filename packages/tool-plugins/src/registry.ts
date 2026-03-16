import type { ToolName } from '@sirko/shared'
import type { SkillDefinition } from './types.js'
import { claudeCodeSkill } from './plugins/claude-code.js'
import { codexSkill } from './plugins/codex.js'
import { aiderSkill } from './plugins/aider.js'
import { unknownSkill } from './plugins/unknown.js'

const registry: Map<ToolName, SkillDefinition> = new Map([
  ['claude-code', claudeCodeSkill],
  ['codex', codexSkill],
  ['aider', aiderSkill],
  ['unknown', unknownSkill],
])

/**
 * Returns the SkillDefinition for the given tool name.
 * Falls back to unknownSkill if not found.
 */
export function getSkill(toolName: ToolName): SkillDefinition {
  return registry.get(toolName) ?? unknownSkill
}

/**
 * Returns all registered skills (excluding 'unknown') in priority order.
 */
export function getAllSkills(): SkillDefinition[] {
  return [claudeCodeSkill, codexSkill, aiderSkill, unknownSkill]
}
