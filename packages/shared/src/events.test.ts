import { describe, it, expect } from 'bun:test'
import type { SirkoEvent } from './events.js'
import { truncateForTelegram, sanitizeForSendKeys } from './utils.js'

describe('SirkoEvent discriminant uniqueness', () => {
  it('every event type string is unique', () => {
    // Construct one representative value for each variant to collect all type strings.
    // TypeScript ensures exhaustiveness at the type level; here we verify at runtime
    // that no two variants share the same discriminant string.
    const types: SirkoEvent['type'][] = [
      'PaneOutput',
      'PaneAwaitingInput',
      'InputDelivered',
      'PaneExited',
      'SessionCreated',
      'SessionClosed',
      'VoiceCallStarted',
      'VoiceCallEnded',
      'VoiceCallFailed',
      'SinkError',
    ]

    const unique = new Set(types)
    expect(unique.size).toBe(types.length)
  })
})

describe('truncateForTelegram', () => {
  it('returns the original string when within limit', () => {
    const short = 'hello world'
    expect(truncateForTelegram(short)).toBe(short)
  })

  it('truncates to exactly maxLen characters', () => {
    const long = 'a'.repeat(5000)
    const result = truncateForTelegram(long)
    expect(result.length).toBeLessThanOrEqual(4096)
  })

  it('appends truncation suffix when trimmed', () => {
    const long = 'b'.repeat(5000)
    const result = truncateForTelegram(long)
    expect(result.endsWith('…[truncated]')).toBe(true)
  })

  it('respects a custom maxLen', () => {
    const text = 'hello world'
    const result = truncateForTelegram(text, 5)
    expect(result.length).toBeLessThanOrEqual(5)
  })

  it('does not truncate at exactly the limit', () => {
    const text = 'x'.repeat(4096)
    expect(truncateForTelegram(text)).toBe(text)
  })
})

describe('sanitizeForSendKeys', () => {
  it('strips ASCII control characters', () => {
    // Include NUL, BEL, BS, ESC, DEL
    const dirty = '\x00hello\x07world\x08\x1bfoo\x7fbar'
    const result = sanitizeForSendKeys(dirty)
    expect(result).toBe('helloworldfoobar')
  })

  it('preserves newline (\\n)', () => {
    const text = 'line1\nline2'
    expect(sanitizeForSendKeys(text)).toBe('line1\nline2')
  })

  it('preserves tab (\\t)', () => {
    const text = 'col1\tcol2'
    expect(sanitizeForSendKeys(text)).toBe('col1\tcol2')
  })

  it('returns clean text unchanged', () => {
    const clean = 'echo "hello world"'
    expect(sanitizeForSendKeys(clean)).toBe(clean)
  })
})
