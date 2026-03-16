import type { PaneState, SessionInfo } from '@sirko/shared'

export const CURRENT_SCHEMA_VERSION = 1

export interface PersistedState {
  schemaVersion: number
  savedAt: number
  panes: Omit<PaneState, 'xtermInstance'>[]
  topicMap: Record<string, number>
  sessions: SessionInfo[]
}

export class MigrationError extends Error {
  readonly rootCause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'MigrationError'
    this.rootCause = cause
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

/**
 * Migrate raw disk data to the current PersistedState schema.
 * Throws MigrationError if data is fundamentally unparseable.
 */
export function migrate(raw: unknown): PersistedState {
  if (!isRecord(raw)) {
    throw new MigrationError('Persisted state is not an object')
  }

  const version = typeof raw['schemaVersion'] === 'number' ? raw['schemaVersion'] : 0

  if (version < 0 || version > CURRENT_SCHEMA_VERSION) {
    throw new MigrationError(`Unknown schema version: ${String(version)}`)
  }

  // v0 -> v1: add schemaVersion field to each pane entry
  let panes: unknown[] = Array.isArray(raw['panes']) ? raw['panes'] : []
  if (version === 0) {
    panes = panes.map((pane) => {
      if (isRecord(pane)) {
        return { ...pane, schemaVersion: CURRENT_SCHEMA_VERSION, xtermInstance: null }
      }
      return pane
    })
  }

  const topicMap: Record<string, number> = {}
  if (isRecord(raw['topicMap'])) {
    for (const [k, v] of Object.entries(raw['topicMap'])) {
      if (typeof v === 'number') {
        topicMap[k] = v
      }
    }
  }

  const sessions: SessionInfo[] = []
  if (Array.isArray(raw['sessions'])) {
    for (const s of raw['sessions']) {
      if (
        isRecord(s) &&
        typeof s['sessionId'] === 'string' &&
        typeof s['name'] === 'string' &&
        typeof s['createdAt'] === 'number'
      ) {
        sessions.push({
          sessionId: s['sessionId'],
          name: s['name'],
          createdAt: s['createdAt'],
        })
      }
    }
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    savedAt: typeof raw['savedAt'] === 'number' ? raw['savedAt'] : Date.now(),
    panes: panes as Omit<PaneState, 'xtermInstance'>[],
    topicMap,
    sessions,
  }
}
