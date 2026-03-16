/**
 * ContextSummarizer — converts raw terminal buffer text into a voice-friendly
 * summary using the Vercel AI SDK.
 *
 * Rules:
 *   - Convert tables to narrative prose
 *   - Spell out abbreviations
 *   - Simplify file paths (show only the last 2 segments)
 *   - Truncate input > 4000 chars: keep head (2000) + tail (2000)
 */

import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { CircuitBreaker } from './circuit-breaker.js'

export interface ContextSummarizerOptions {
  /** OpenAI model to use. Default: gpt-4o-mini */
  model?: string
  /** Max chars of terminal text to send to the LLM. Default: 4000 */
  maxInputChars?: number
}

const SYSTEM_PROMPT = `You are a voice assistant that reads terminal output to a developer over the phone.
Convert the provided terminal text into a concise, voice-friendly summary.

Rules:
- Speak naturally; avoid markdown formatting
- Convert tables to brief narrative sentences
- Spell out common abbreviations (e.g., "src" → "source", "pkg" → "package", "cmd" → "command")
- Simplify file paths: only mention the last two path segments
- Keep the summary under 60 words
- If the terminal is asking for input, clearly state what is needed
- Do not read out ANSI escape codes or control characters`

export class ContextSummarizer {
  private readonly model: string
  private readonly maxInputChars: number
  private readonly breaker: CircuitBreaker

  constructor(options: ContextSummarizerOptions = {}) {
    this.model = options.model ?? 'gpt-4o-mini'
    this.maxInputChars = options.maxInputChars ?? 4000
    this.breaker = new CircuitBreaker({ name: 'context-summarizer', failureThreshold: 3, windowMs: 30_000 })
  }

  /**
   * Truncate input if it exceeds maxInputChars.
   * Keeps the head and tail so the context around the prompt is preserved.
   */
  truncate(text: string): string {
    if (text.length <= this.maxInputChars) {
      return text
    }
    const half = Math.floor(this.maxInputChars / 2)
    const head = text.slice(0, half)
    const tail = text.slice(text.length - half)
    return `${head}\n...[truncated]...\n${tail}`
  }

  /**
   * Summarize terminal context for spoken delivery.
   * Returns the summary string, or a fallback message on error.
   */
  async summarize(rawTerminalText: string): Promise<string> {
    const input = this.truncate(rawTerminalText)

    return this.breaker.execute(async () => {
      const { text } = await generateText({
        model: openai(this.model),
        system: SYSTEM_PROMPT,
        prompt: `Terminal output:\n${input}`,
        maxOutputTokens: 120,
      })
      return text.trim()
    })
  }
}
