import type { SkillDefinition } from '../types.js'

export const unknownSkill: SkillDefinition = {
  name: 'unknown',
  displayName: 'Unknown Tool',
  binaryPattern: /.*/,
  processNamePattern: /.*/,
  promptPatterns: [/^>[\s\u00a0]/m, /^❯[\s\u00a0]/m, /^\?[\s\u00a0]/m, /\(y\/n\)/i],
  promptPatternWeight: 0.50,
  quiescenceThresholdMs: 2000,
  quiescenceWeight: 0.20,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read', 'futex'],
  wchanWeight: 0.30,
  scoringThreshold: 0.60,
}
