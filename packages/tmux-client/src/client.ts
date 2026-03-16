import type { TerminalEmulator } from '@sirko/shared'
import type { TmuxEvent, TmuxClientOptions } from './types.js'
import { parseControlModeLine } from './parser.js'
import { OutputCoalescer } from './coalescer.js'
import { createTerminalEmulator, BufferEmulator } from './xterm-emulator.js'

// ---------------------------------------------------------------------------
// Input validation helpers — guard against command injection via interpolation
// ---------------------------------------------------------------------------

function validatePaneId(id: string): void {
  if (!/^%\d+$/.test(id)) throw new Error(`Invalid pane ID: ${id}`)
}

function validateSessionId(id: string): void {
  if (!/^\$\d+$/.test(id)) throw new Error(`Invalid session ID: ${id}`)
}

function validateWindowId(id: string): void {
  if (!/^@\d+$/.test(id)) throw new Error(`Invalid window ID: ${id}`)
}

export function validateSessionName(name: string): void {
  if (!/^[\w\-\.]+$/.test(name)) throw new Error(`Invalid session name: ${name}`)
}

interface CommandInflight {
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
  lines: string[]
}

export class TmuxClient {
  private readonly options: Required<Omit<TmuxClientOptions, 'socketName'>> & { socketName: string }
  private proc: ReturnType<typeof Bun.spawn> | null = null
  // FIFO queue of in-flight commands — tmux responds in order, one at a time
  private inflightQueue: CommandInflight[] = []
  private insideBlock = false
  private eventListeners: Array<(event: TmuxEvent) => void> = []
  private coalescer: OutputCoalescer
  private lineBuffer: string = ''
  private reconnectMs: number
  private reconnecting = false
  private stopped = false
  // Resolves when the initial tmux startup %begin/%end block has been consumed
  private _startupReady: Promise<void> = Promise.resolve()

  constructor(options: TmuxClientOptions = {}) {
    const socketName = options.socketName ?? options.socketPath ?? 'sirko'
    this.options = {
      socketPath: socketName,
      socketName,
      reconnectInitialMs: options.reconnectInitialMs ?? 1000,
      reconnectMaxMs: options.reconnectMaxMs ?? 30000,
      coalesceWindowMs: options.coalesceWindowMs ?? 50,
    }
    this.reconnectMs = this.options.reconnectInitialMs
    this.coalescer = new OutputCoalescer(
      this.options.coalesceWindowMs,
      (event) => this._dispatchEvent(event),
    )
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.stopped = false
    await this._spawn()
    // Wait for the initial %begin/%end block that tmux emits on startup
    // (the result of the implicit new-session command in the spawn args).
    // This ensures the FIFO queue is drained before callers issue commands.
    await this._startupReady
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    this.coalescer.flush()
    if (this.proc) {
      try {
        const stdin = this.proc.stdin
        if (stdin && typeof stdin === 'object' && 'end' in stdin) {
          stdin.end()
        }
        await this.proc.exited
      } catch {
        // ignore
      }
      this.proc = null
    }
  }

  // -------------------------------------------------------------------------
  // Event streaming
  // -------------------------------------------------------------------------

  async *events(): AsyncGenerator<TmuxEvent> {
    const queue: TmuxEvent[] = []
    let resolve: (() => void) | null = null

    const push = (event: TmuxEvent) => {
      queue.push(event)
      resolve?.()
      resolve = null
    }

    this.eventListeners.push(push)

    try {
      while (!this.stopped) {
        if (queue.length > 0) {
          yield queue.shift()!
        } else {
          await new Promise<void>((r) => { resolve = r })
        }
      }
    } finally {
      this.eventListeners = this.eventListeners.filter((l) => l !== push)
    }
  }

  // -------------------------------------------------------------------------
  // Command helpers
  // -------------------------------------------------------------------------

  async sendCommand(cmd: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      this.inflightQueue.push({ resolve, reject, lines: [] })
      const line = `${cmd}\n`
      const stdin = this.proc?.stdin
      if (stdin && typeof stdin === 'object' && 'write' in stdin) {
        stdin.write(line)
      }
    })
  }

  async sendKeys(paneId: string, text: string, opts: { enter?: boolean } = {}): Promise<void> {
    validatePaneId(paneId)
    await this.sendCommand(`send-keys -t ${paneId} -l ${JSON.stringify(text)}`)
    if (opts.enter) {
      await this.sendCommand(`send-keys -t ${paneId} Enter`)
    }
  }

  async capturePane(paneId: string): Promise<string> {
    validatePaneId(paneId)
    const lines = await this.sendCommand(`capture-pane -t ${paneId} -p`)
    return lines.join('\n')
  }

  async getPanePid(paneId: string): Promise<number | null> {
    validatePaneId(paneId)
    const lines = await this.sendCommand(
      `display-message -t ${paneId} -p "#{pane_pid}"`,
    )
    const pidStr = lines[0]?.trim()
    if (!pidStr) return null
    const pid = parseInt(pidStr, 10)
    return isNaN(pid) ? null : pid
  }

  async newSession(name: string): Promise<string> {
    validateSessionName(name)
    const lines = await this.sendCommand(
      `new-session -d -s ${name} -P -F "#{session_id}"`,
    )
    return lines[0]?.trim() ?? ''
  }

  async newWindow(sessionId: string): Promise<string> {
    validateSessionId(sessionId)
    const lines = await this.sendCommand(
      `new-window -t ${sessionId} -P -F "#{window_id}"`,
    )
    return lines[0]?.trim() ?? ''
  }

  async newPane(windowId: string): Promise<string> {
    validateWindowId(windowId)
    const lines = await this.sendCommand(
      `split-window -t ${windowId} -P -F "#{pane_id}"`,
    )
    return lines[0]?.trim() ?? ''
  }

  async listSessions(): Promise<Array<{ sessionId: string; name: string }>> {
    const lines = await this.sendCommand(
      'list-sessions -F "#{session_id} #{session_name}"',
    )
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const idx = l.indexOf(' ')
        return idx === -1
          ? { sessionId: l, name: '' }
          : { sessionId: l.slice(0, idx), name: l.slice(idx + 1) }
      })
  }

  async listPanes(): Promise<
    Array<{ paneId: string; windowId: string; sessionId: string }>
  > {
    const lines = await this.sendCommand(
      'list-panes -a -F "#{pane_id} #{window_id} #{session_id}"',
    )
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(' ')
        return {
          paneId: parts[0] ?? '',
          windowId: parts[1] ?? '',
          sessionId: parts[2] ?? '',
        }
      })
  }

  createTerminalEmulator(): TerminalEmulator {
    // Synchronously return BufferEmulator; caller can await upgradeTerminalEmulator
    // for the async xterm version.
    return new BufferEmulator()
  }

  /** Async version that attempts to create an XtermEmulator. */
  async upgradeTerminalEmulator(cols?: number, rows?: number): Promise<TerminalEmulator> {
    return createTerminalEmulator(cols, rows)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async _spawn(): Promise<void> {
    const args: string[] = []
    if (this.options.socketName) {
      args.push('-L', this.options.socketName)
    }
    args.push('-C', 'new-session')

    // Push a sentinel inflight entry so the initial %begin/%end block emitted
    // by tmux for the implicit new-session command is properly consumed.
    this._startupReady = new Promise<void>((resolve) => {
      this.inflightQueue.push({ resolve: () => resolve(), reject: () => resolve(), lines: [] })
    })

    this.proc = Bun.spawn(['tmux', ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    })

    this._readLoop(this.proc).catch(() => {
      if (!this.stopped) this._scheduleReconnect()
    })

    this.proc.exited.then(() => {
      if (!this.stopped) this._scheduleReconnect()
    }).catch(() => {
      if (!this.stopped) this._scheduleReconnect()
    })
  }

  private async _readLoop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stdout = proc.stdout
    if (!stdout || typeof stdout !== 'object' || !('getReader' in stdout)) return
    const decoder = new TextDecoder()
    const reader = (stdout as ReadableStream<Uint8Array>).getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        this._processChunk(chunk)
      }
    } finally {
      reader.releaseLock()
    }
  }

  private _processChunk(chunk: string): void {
    this.lineBuffer += chunk
    let nlIdx: number
    while ((nlIdx = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, nlIdx)
      this.lineBuffer = this.lineBuffer.slice(nlIdx + 1)
      this._processLine(line)
    }
  }

  private _processLine(line: string): void {
    // %begin <time> <pid> — start of a command response block
    if (line.startsWith('%begin ')) {
      this.insideBlock = true
      // Ensure there is an inflight entry waiting; if not, create a dummy one
      // so collected lines have somewhere to go (handles unexpected %begin).
      if (this.inflightQueue.length === 0) {
        this.inflightQueue.push({ resolve: () => {}, reject: () => {}, lines: [] })
      }
      return
    }

    // %end <time> <pid> <retcode> — end of a command response block (success)
    if (line.startsWith('%end ')) {
      this.insideBlock = false
      const inflight = this.inflightQueue.shift()
      if (inflight) {
        inflight.resolve(inflight.lines)
      }
      return
    }

    // %error <time> <pid> — end of a command response block (failure)
    if (line.startsWith('%error ')) {
      this.insideBlock = false
      const inflight = this.inflightQueue.shift()
      if (inflight) {
        inflight.reject(new Error(`tmux command error: ${line}`))
      }
      return
    }

    // If we're inside a command response block, collect the line as output
    if (this.insideBlock) {
      const inflight = this.inflightQueue[0]
      if (inflight) {
        inflight.lines.push(line)
      }
      return
    }

    // Otherwise parse as a notification event
    const event = parseControlModeLine(line)
    if (event) {
      if (event.type === 'pane-output') {
        this.coalescer.push(event)
      } else {
        this._dispatchEvent(event)
      }
    }
  }

  protected _dispatchEvent(event: TmuxEvent): void {
    for (const listener of this.eventListeners) {
      listener(event)
    }
  }

  private _scheduleReconnect(): void {
    if (this.reconnecting || this.stopped) return
    this.reconnecting = true
    const delay = this.reconnectMs
    this.reconnectMs = Math.min(this.reconnectMs * 2, this.options.reconnectMaxMs)
    setTimeout(async () => {
      this.reconnecting = false
      if (!this.stopped) {
        try {
          await this._spawn()
          this.reconnectMs = this.options.reconnectInitialMs
        } catch {
          this._scheduleReconnect()
        }
      }
    }, delay)
  }
}

export function createTmuxClient(options?: TmuxClientOptions): TmuxClient {
  return new TmuxClient(options)
}
