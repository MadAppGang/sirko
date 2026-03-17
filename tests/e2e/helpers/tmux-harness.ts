/**
 * TmuxTestHarness — creates an isolated tmux server per test suite.
 *
 * Uses a unique socket name so tests never interfere with each other
 * or the user's real tmux sessions.
 *
 * IMPORTANT: tmux control mode only receives %output events for the
 * attached session's panes. Panes created via external CLI are invisible.
 * Use the orchestrator's TmuxClient (via runScript/sendKeys helpers) to
 * create and interact with panes so the orchestrator can see their output.
 */

import { $ } from 'bun'
import type { TmuxClient } from '@sirko/tmux-client'

export class TmuxTestHarness {
  readonly socketName: string
  private cleanedUp = false
  private _client: TmuxClient | null = null

  constructor() {
    const ts = Date.now()
    const rand = Math.random().toString(36).slice(2, 8)
    this.socketName = `sirko-e2e-${ts}-${rand}`
  }

  /**
   * Bind the harness to an orchestrator's TmuxClient so pane operations
   * go through control mode and the orchestrator sees their events.
   */
  bindClient(client: TmuxClient): void {
    this._client = client
  }

  private get client(): TmuxClient {
    if (this._client === null) {
      throw new Error('TmuxTestHarness: call bindClient(handle.tmuxClient) before creating panes')
    }
    return this._client
  }

  async setup(): Promise<void> {
    // Start a detached tmux server with our isolated socket.
    // The orchestrator's TmuxClient will create its own session on connect.
    await $`tmux -L ${this.socketName} new-session -d -s e2e-bootstrap`.quiet()
    // Register crash-safety cleanup
    process.on('exit', () => this.teardownSync())
  }

  async teardown(): Promise<void> {
    if (this.cleanedUp) return
    this.cleanedUp = true
    this._client = null
    try {
      await $`tmux -L ${this.socketName} kill-server`.quiet()
    } catch {
      // Server may already be dead — that's fine
    }
  }

  /** Synchronous teardown for process.on('exit') handler */
  private teardownSync(): void {
    if (this.cleanedUp) return
    this.cleanedUp = true
    try {
      Bun.spawnSync(['tmux', '-L', this.socketName, 'kill-server'])
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Run a script in a new tmux window (via the orchestrator's control client).
   * Returns the pane ID. The pane is created in the control client's session
   * so the orchestrator receives %output events.
   */
  async runScript(cmd: string): Promise<string> {
    const lines = await this.client.sendCommand(`new-window -P -F "#{pane_id}" ${cmd}`)
    return lines[0]?.trim() ?? ''
  }

  /**
   * Send keys to a pane via the orchestrator's control client.
   */
  async sendKeys(paneId: string, text: string, opts: { enter?: boolean } = {}): Promise<void> {
    await this.client.sendKeys(paneId, text, opts)
  }

  /**
   * Capture pane contents via the orchestrator's control client.
   */
  async capturePane(paneId: string): Promise<string> {
    return this.client.capturePane(paneId)
  }

  /**
   * List all panes via the orchestrator's control client.
   */
  async listPanes(): Promise<Array<{ paneId: string; windowId: string; sessionId: string }>> {
    return this.client.listPanes()
  }

  /**
   * List sessions via the orchestrator's control client.
   */
  async listSessions(): Promise<Array<{ sessionId: string; name: string }>> {
    return this.client.listSessions()
  }
}
