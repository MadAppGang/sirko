import type { SkillDefinition } from '../types.js'

export const codexSkill: SkillDefinition = {
  name: 'codex',
  displayName: 'Codex CLI',
  binaryPattern: /codex$/i,
  processNamePattern: /codex/i,
  promptPatterns: [/^\? /m, /Continue\?/i, /Proceed\?/i],
  promptPatternWeight: 0.55,
  quiescenceThresholdMs: 1500,
  quiescenceWeight: 0.15,
  wchanWaitValues: ['pipe_read', 'read_events', 'wait_pipe_read'],
  wchanWeight: 0.30,
  scoringThreshold: 0.65,
  inputSuffix: '\n',
}
