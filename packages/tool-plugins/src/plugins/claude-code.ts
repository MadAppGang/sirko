import type { SkillDefinition } from '../types.js'

export const claudeCodeSkill: SkillDefinition = {
  name: 'claude-code',
  displayName: 'Claude Code',
  binaryPattern: /claude$/i,
  processNamePattern: /claude/i,
  promptPatterns: [/^>\s*$/m, /^❯[\s\u00a0]*$/m],
  promptPatternWeight: 0.45,
  quiescenceThresholdMs: 1800,
  quiescenceWeight: 0.20,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read', 'futex'],
  wchanWeight: 0.35,
  scoringThreshold: 0.60,
  inputSuffix: '\n',
}
