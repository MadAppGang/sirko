/**
 * MockTelegramServer — Bun HTTP server that mimics the Telegram Bot API.
 *
 * Handles grammY's polling methods (getMe, getUpdates, etc.) and records
 * all API calls for test assertions.
 */

interface ApiCall {
  method: string
  params: Record<string, unknown>
  timestamp: number
}

export class MockTelegramServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private readonly calls: ApiCall[] = []
  private _port = 0

  get port(): number {
    return this._port
  }

  get apiRoot(): string {
    return `http://localhost:${this._port}`
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: 0, // OS-assigned
      fetch: async (req) => {
        return this.handleRequest(req)
      },
    })
    this._port = this.server.port
  }

  async stop(): Promise<void> {
    if (this.server !== null) {
      this.server.stop()
      this.server = null
    }
  }

  /**
   * Get all recorded API calls.
   */
  allCalls(): readonly ApiCall[] {
    return this.calls
  }

  /**
   * Get all calls for a specific Bot API method.
   */
  callsForMethod(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  /**
   * Clear recorded calls.
   */
  clearCalls(): void {
    this.calls.length = 0
  }

  /**
   * Wait until at least `count` calls for a method have been recorded.
   */
  async waitForCalls(method: string, count: number, timeoutMs = 10_000): Promise<ApiCall[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const matching = this.callsForMethod(method)
      if (matching.length >= count) return matching
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(
      `MockTelegramServer: timed out waiting for ${count} "${method}" calls (got ${this.callsForMethod(method).length})`,
    )
  }

  private handleRequest(req: Request): Response {
    const url = new URL(req.url)
    // grammY sends requests to /bot<token>/<method>
    const parts = url.pathname.split('/')
    // Path format: /bot<token>/<method>
    const method = parts[parts.length - 1] ?? ''

    // Parse params from URL search params or JSON body
    // For simplicity we handle GET and POST the same way
    const params: Record<string, unknown> = {}
    for (const [key, value] of url.searchParams) {
      params[key] = value
    }

    this.calls.push({ method, params, timestamp: Date.now() })

    // Return mock responses for known methods
    switch (method) {
      case 'getMe':
        return Response.json({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: 'SirkoTestBot',
            username: 'sirko_test_bot',
            can_join_groups: true,
            can_read_all_group_messages: true,
            supports_inline_queries: false,
          },
        })

      case 'getUpdates':
        // Return empty array — no incoming messages
        return Response.json({
          ok: true,
          result: [],
        })

      case 'deleteWebhook':
        return Response.json({ ok: true, result: true })

      case 'sendMessage':
        return Response.json({
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 100000),
            from: { id: 123456789, is_bot: true, first_name: 'SirkoTestBot' },
            chat: { id: params.chat_id ?? -1, type: 'supergroup' },
            date: Math.floor(Date.now() / 1000),
            text: params.text ?? '',
            message_thread_id: params.message_thread_id,
          },
        })

      case 'createForumTopic':
        return Response.json({
          ok: true,
          result: {
            message_thread_id: Math.floor(Math.random() * 100000),
            name: params.name ?? 'test-topic',
            icon_color: 7322096,
          },
        })

      case 'closeForumTopic':
      case 'editForumTopic':
        return Response.json({ ok: true, result: true })

      case 'sendDocument':
        return Response.json({
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 100000),
            from: { id: 123456789, is_bot: true, first_name: 'SirkoTestBot' },
            chat: { id: params.chat_id ?? -1, type: 'supergroup' },
            date: Math.floor(Date.now() / 1000),
          },
        })

      default:
        // Unknown method — return generic success
        return Response.json({ ok: true, result: true })
    }
  }
}
