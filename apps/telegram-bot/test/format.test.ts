import { describe, it, expect } from 'bun:test'
import { formatOutput, escapeHtml, formatAwaitingInput } from '../src/format.js'

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes angle brackets', () => {
    expect(escapeHtml('<b>&"test"</b>')).toBe('&lt;b&gt;&amp;&quot;test&quot;&lt;/b&gt;')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#39;s")
  })

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

describe('formatOutput', () => {
  it('wraps short text in <pre><code>', () => {
    const result = formatOutput('x'.repeat(100))
    expect(result).not.toBeNull()
    expect(result).toContain('<pre>')
    expect(result).toContain('<code>')
  })

  it('uses expandable blockquote for medium-length output', () => {
    const result = formatOutput('x'.repeat(5000))
    expect(result).not.toBeNull()
    expect(result).toContain('<blockquote expandable>')
  })

  it('returns null for very long output', () => {
    const result = formatOutput('x'.repeat(13000))
    expect(result).toBeNull()
  })

  it('escapes HTML in the text', () => {
    const result = formatOutput('<script>alert(1)</script>')
    expect(result).not.toBeNull()
    expect(result).toContain('&lt;script&gt;')
  })

  it('handles text exactly at 4096 chars', () => {
    const result = formatOutput('a'.repeat(4096))
    expect(result).not.toBeNull()
    expect(result).toContain('<pre>')
    expect(result).not.toContain('<blockquote expandable>')
  })

  it('handles text at 4097 chars (splits)', () => {
    const result = formatOutput('a'.repeat(4097))
    expect(result).not.toBeNull()
    expect(result).toContain('<pre>')
    expect(result).toContain('<blockquote expandable>')
  })

  it('handles text exactly at 12000 chars (still formatted)', () => {
    const result = formatOutput('a'.repeat(12000))
    expect(result).not.toBeNull()
    expect(result).toContain('<blockquote expandable>')
  })

  it('handles text at 12001 chars (returns null)', () => {
    const result = formatOutput('a'.repeat(12001))
    expect(result).toBeNull()
  })
})

describe('formatAwaitingInput', () => {
  it('includes tool name', () => {
    const result = formatAwaitingInput('claude-code', 0.9, 'some context')
    expect(result).toContain('claude-code')
  })

  it('includes confidence as percentage', () => {
    const result = formatAwaitingInput('claude-code', 0.85, 'context')
    expect(result).toContain('85%')
  })

  it('includes the context snippet', () => {
    const result = formatAwaitingInput('aider', 0.7, 'Press Enter to continue')
    expect(result).toContain('Press Enter to continue')
  })

  it('escapes HTML in context', () => {
    const result = formatAwaitingInput('unknown', 0.5, '<script>xss</script>')
    expect(result).toContain('&lt;script&gt;')
  })
})
