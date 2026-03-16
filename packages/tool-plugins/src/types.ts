import type { ToolName } from '@sirko/shared'

export type { ToolName }

export interface SkillDefinition {
  name: ToolName
  displayName: string

  // Process identification
  binaryPattern: RegExp
  processNamePattern: RegExp

  // Prompt pattern signal
  promptPatterns: RegExp[]
  promptPatternWeight: number        // 0.0-1.0

  // Quiescence signal
  quiescenceThresholdMs: number
  quiescenceWeight: number           // 0.0-1.0

  // Wait-channel signal
  wchanWaitValues: string[]
  wchanWeight: number                // 0.0-1.0

  // Aggregation
  scoringThreshold: number           // weighted score threshold (0.0-1.0)

  // Behavior hooks
  preInputDelayMs?: number           // ms to wait before routing input
  inputSuffix?: string               // appended to input (e.g., '\n')
  outputStreamingDelayMs?: number    // ms debounce for output burst
}
