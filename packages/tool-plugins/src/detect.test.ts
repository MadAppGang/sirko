import { describe, it, expect } from 'bun:test'
import { detectTool } from './detect.js'
import type { ProcessInfo } from '@sirko/shared'

function makeProcess(name: string, argv: string[]): ProcessInfo {
  return { pid: 1234, ppid: 1000, name, argv }
}

describe('detectTool', () => {
  it('detects claude-code when process name is "claude"', () => {
    const result = detectTool([makeProcess('claude', ['/usr/local/bin/claude'])])
    expect(result).toBe('claude-code')
  })

  it('detects claude-code when binary path matches /claude$/', () => {
    const result = detectTool([makeProcess('node', ['/home/user/.nvm/bin/claude'])])
    expect(result).toBe('claude-code')
  })

  it('detects aider when process name is "aider"', () => {
    const result = detectTool([makeProcess('aider', ['/usr/bin/aider'])])
    expect(result).toBe('aider')
  })

  it('detects codex when process name is "codex"', () => {
    const result = detectTool([makeProcess('codex', ['/usr/local/bin/codex'])])
    expect(result).toBe('codex')
  })

  it('returns "unknown" for generic bash process', () => {
    const result = detectTool([makeProcess('bash', ['/bin/bash'])])
    expect(result).toBe('unknown')
  })

  it('returns "unknown" for empty processes list', () => {
    const result = detectTool([])
    expect(result).toBe('unknown')
  })

  it('returns first match when multiple processes present', () => {
    const result = detectTool([
      makeProcess('bash', ['/bin/bash']),
      makeProcess('claude', ['/usr/local/bin/claude']),
    ])
    expect(result).toBe('claude-code')
  })

  it('prefers claude-code over aider when both are present', () => {
    const result = detectTool([
      makeProcess('aider', ['/usr/bin/aider']),
      makeProcess('claude', ['/usr/local/bin/claude']),
    ])
    // Claude-code is higher priority in orderedSkills
    expect(result).toBe('claude-code')
  })
})
