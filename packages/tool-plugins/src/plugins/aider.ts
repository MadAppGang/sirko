import type { SkillDefinition } from '../types.js'

export const aiderSkill: SkillDefinition = {
  name: 'aider',
  displayName: 'Aider',
  binaryPattern: /aider$/i,
  processNamePattern: /aider/i,
  promptPatterns: [/^> /m, /\(y\/n\)/i, /\[Yes\]/i, /\[No\]/i],
  promptPatternWeight: 0.50,
  quiescenceThresholdMs: 3000,
  quiescenceWeight: 0.20,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read'],
  wchanWeight: 0.30,
  scoringThreshold: 0.55,
  inputSuffix: '\n',
}
