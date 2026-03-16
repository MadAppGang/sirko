import { mkdir, rename, writeFile, readFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PaneState, SessionInfo } from '@sirko/shared'
import { migrate, CURRENT_SCHEMA_VERSION, type PersistedState } from './migrations.js'

export type { PersistedState }

export interface StateStoreOptions {
  /** Directory path for state.json (e.g., ~/.sirko) */
  persistPath: string
  /** Auto-save interval in milliseconds. Default: 5000 */
  persistIntervalMs?: number
}

export class StateStore {
  private readonly persistPath: string
  private readonly persistIntervalMs: number
  private readonly panes: Map<string, PaneState> = new Map()
  private readonly sessions: Map<string, SessionInfo> = new Map()
  /** paneId -> telegramTopicId */
  private readonly topicMap: Map<string, number> = new Map()
  /** topicId -> paneId (reverse lookup) */
  private readonly topicReverseMap: Map<number, string> = new Map()
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: StateStoreOptions) {
    this.persistPath = options.persistPath
    this.persistIntervalMs = options.persistIntervalMs ?? 5000
  }

  // ---------------------------------------------------------------------------
  // Pane CRUD — synchronous, in-memory
  // ---------------------------------------------------------------------------

  getPane(paneId: string): PaneState | undefined {
    return this.panes.get(paneId)
  }

  setPane(paneId: string, state: PaneState): void {
    this.panes.set(paneId, state)
    // Sync telegramTopicId into topic maps if present
    if (state.telegramTopicId !== null) {
      this.topicMap.set(paneId, state.telegramTopicId)
      this.topicReverseMap.set(state.telegramTopicId, paneId)
    }
  }

  deletePane(paneId: string): void {
    const existing = this.panes.get(paneId)
    if (existing?.telegramTopicId !== undefined && existing.telegramTopicId !== null) {
      this.topicReverseMap.delete(existing.telegramTopicId)
    }
    this.topicMap.delete(paneId)
    this.panes.delete(paneId)
  }

  allPanes(): PaneState[] {
    return Array.from(this.panes.values())
  }

  // ---------------------------------------------------------------------------
  // Topic map — synchronous, in-memory
  // ---------------------------------------------------------------------------

  getTopicId(paneId: string): number | undefined {
    return this.topicMap.get(paneId)
  }

  setTopicId(paneId: string, topicId: number): void {
    this.topicMap.set(paneId, topicId)
    this.topicReverseMap.set(topicId, paneId)
    // Update pane if it exists
    const pane = this.panes.get(paneId)
    if (pane !== undefined) {
      this.panes.set(paneId, { ...pane, telegramTopicId: topicId })
    }
  }

  getPaneByTopicId(topicId: number): string | undefined {
    return this.topicReverseMap.get(topicId)
  }

  // ---------------------------------------------------------------------------
  // Session info — synchronous, in-memory
  // ---------------------------------------------------------------------------

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId)
  }

  setSession(sessionId: string, info: SessionInfo): void {
    this.sessions.set(sessionId, info)
  }

  allSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
  }

  // ---------------------------------------------------------------------------
  // Notification state helper
  // ---------------------------------------------------------------------------

  setNotificationState(paneId: string, state: 'idle' | 'notified'): void {
    const pane = this.panes.get(paneId)
    if (pane !== undefined) {
      this.panes.set(paneId, {
        ...pane,
        notificationState: state,
        lastNotifiedAt: state === 'notified' ? Date.now() : pane.lastNotifiedAt,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence — async
  // ---------------------------------------------------------------------------

  async persist(): Promise<void> {
    const stateFilePath = join(this.persistPath, 'state.json')
    const tmpFilePath = join(this.persistPath, 'state.json.tmp')
    const bakFilePath = join(this.persistPath, 'state.json.bak')

    // Ensure directory exists
    await mkdir(this.persistPath, { recursive: true })
    await mkdir(join(this.persistPath, 'logs'), { recursive: true })

    const serialized: PersistedState = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      savedAt: Date.now(),
      panes: Array.from(this.panes.values()).map((p) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { xtermInstance: _xterm, ...rest } = p
        return rest
      }),
      topicMap: Object.fromEntries(this.topicMap.entries()),
      sessions: Array.from(this.sessions.values()),
    }

    // Write to tmp then atomically rename
    await writeFile(tmpFilePath, JSON.stringify(serialized, null, 2), 'utf8')

    // Backup current state before overwriting
    try {
      await copyFile(stateFilePath, bakFilePath)
    } catch {
      // state.json may not exist yet — that's fine
    }

    await rename(tmpFilePath, stateFilePath)
  }

  async load(): Promise<void> {
    const stateFilePath = join(this.persistPath, 'state.json')

    let raw: unknown
    try {
      const text = await readFile(stateFilePath, 'utf8')
      raw = JSON.parse(text) as unknown
    } catch {
      // Missing file or corrupt JSON — start with empty state
      return
    }

    let parsed: PersistedState
    try {
      parsed = migrate(raw)
    } catch {
      // Migration failed — start with empty state
      return
    }

    // Load panes
    for (const pane of parsed.panes) {
      const full: PaneState = { ...pane, xtermInstance: null }
      this.panes.set(pane.paneId, full)
    }

    // Load topic map
    for (const [paneId, topicId] of Object.entries(parsed.topicMap)) {
      this.topicMap.set(paneId, topicId)
      this.topicReverseMap.set(topicId, paneId)
    }

    // Load sessions
    for (const session of parsed.sessions) {
      this.sessions.set(session.sessionId, session)
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  startAutoSave(): void {
    if (this.autoSaveTimer !== null) return
    this.autoSaveTimer = setInterval(() => {
      void this.persist().catch((err) => {
        console.error('[StateStore] Auto-save failed:', err)
      })
    }, this.persistIntervalMs)
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer !== null) {
      clearInterval(this.autoSaveTimer)
      this.autoSaveTimer = null
    }
  }
}

export function createStateStore(options: StateStoreOptions): StateStore {
  return new StateStore(options)
}
