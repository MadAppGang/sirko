import type { ProcessInfo, ToolName } from '@sirko/shared'
import { claudeCodeSkill } from './plugins/claude-code.js'
import { codexSkill } from './plugins/codex.js'
import { aiderSkill } from './plugins/aider.js'

// Skills in priority order for detection
const orderedSkills = [claudeCodeSkill, codexSkill, aiderSkill]

/**
 * Iterates registered skills in priority order (claude-code, codex, aider).
 * Matches against binaryPattern and processNamePattern on each ProcessInfo.
 * Returns the first match or 'unknown'.
 */
export function detectTool(processes: ProcessInfo[]): ToolName {
  for (const skill of orderedSkills) {
    for (const proc of processes) {
      const binaryMatch = skill.binaryPattern.test(proc.name) ||
        proc.argv.some(arg => skill.binaryPattern.test(arg))
      const nameMatch = skill.processNamePattern.test(proc.name)

      if (binaryMatch || nameMatch) {
        return skill.name
      }
    }
  }
  return 'unknown'
}
