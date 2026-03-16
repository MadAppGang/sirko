import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateStore, createStateStore } from './state-store.js'
import { CURRENT_SCHEMA_VERSION, migrate, MigrationError } from './migrations.js'
import type { PaneState, SessionInfo } from '@sirko/shared'

function makePaneState(overrides: Partial<PaneState> = {}): PaneState {
  return {
    paneId: 'pane-1',
    sessionId: 'session-1',
    windowId: 'window-1',
    tool: 'claude-code',
    pid: 1234,
    status: 'running',
    exitCode: null,
    notificationState: 'idle',
    lastNotifiedAt: null,
    lastOutputTime: Date.now(),
    processingCount: 0,
    xtermInstance: null,
    lastBufferSnapshot: '',
    telegramTopicId: null,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'session-1',
    name: 'test-session',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('StateStore', () => {
  let tmpDir: string
  let store: StateStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'state-store-test-'))
    store = createStateStore({ persistPath: tmpDir, persistIntervalMs: 60000 })
  })

  afterEach(async () => {
    store.stopAutoSave()
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('Pane CRUD', () => {
    it('setPane / getPane round-trip', () => {
      const pane = makePaneState()
      store.setPane('pane-1', pane)
      expect(store.getPane('pane-1')).toEqual(pane)
    })

    it('getPane returns undefined for missing pane', () => {
      expect(store.getPane('nonexistent')).toBeUndefined()
    })

    it('deletePane removes the pane', () => {
      store.setPane('pane-1', makePaneState())
      store.deletePane('pane-1')
      expect(store.getPane('pane-1')).toBeUndefined()
    })

    it('allPanes returns all stored panes', () => {
      store.setPane('pane-1', makePaneState({ paneId: 'pane-1' }))
      store.setPane('pane-2', makePaneState({ paneId: 'pane-2' }))
      expect(store.allPanes()).toHaveLength(2)
    })
  })

  describe('Topic map', () => {
    it('setTopicId / getTopicId round-trip', () => {
      store.setTopicId('pane-1', 42)
      expect(store.getTopicId('pane-1')).toBe(42)
    })

    it('getPaneByTopicId reverse lookup', () => {
      store.setTopicId('pane-1', 42)
      expect(store.getPaneByTopicId(42)).toBe('pane-1')
    })

    it('getPaneByTopicId returns undefined for unknown topic', () => {
      expect(store.getPaneByTopicId(999)).toBeUndefined()
    })

    it('setPane with telegramTopicId populates topic maps', () => {
      store.setPane('pane-1', makePaneState({ paneId: 'pane-1', telegramTopicId: 77 }))
      expect(store.getTopicId('pane-1')).toBe(77)
      expect(store.getPaneByTopicId(77)).toBe('pane-1')
    })

    it('deletePane clears topic reverse map', () => {
      store.setPane('pane-1', makePaneState({ paneId: 'pane-1', telegramTopicId: 77 }))
      store.deletePane('pane-1')
      expect(store.getPaneByTopicId(77)).toBeUndefined()
    })
  })

  describe('Session CRUD', () => {
    it('setSession / getSession round-trip', () => {
      const session = makeSession()
      store.setSession('session-1', session)
      expect(store.getSession('session-1')).toEqual(session)
    })

    it('allSessions returns all stored sessions', () => {
      store.setSession('s1', makeSession({ sessionId: 's1' }))
      store.setSession('s2', makeSession({ sessionId: 's2' }))
      expect(store.allSessions()).toHaveLength(2)
    })
  })

  describe('Notification state', () => {
    it('setNotificationState updates notificationState', () => {
      store.setPane('pane-1', makePaneState())
      store.setNotificationState('pane-1', 'notified')
      expect(store.getPane('pane-1')?.notificationState).toBe('notified')
    })

    it('setNotificationState sets lastNotifiedAt when notified', () => {
      const before = Date.now()
      store.setPane('pane-1', makePaneState())
      store.setNotificationState('pane-1', 'notified')
      const lastNotifiedAt = store.getPane('pane-1')?.lastNotifiedAt
      expect(lastNotifiedAt).not.toBeNull()
      expect(lastNotifiedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('Persistence', () => {
    it('persist() + load() round-trip restores panes', async () => {
      const pane = makePaneState({ paneId: 'pane-persist' })
      store.setPane('pane-persist', pane)
      await store.persist()

      const store2 = createStateStore({ persistPath: tmpDir })
      await store2.load()

      const loaded = store2.getPane('pane-persist')
      expect(loaded).toBeDefined()
      expect(loaded?.paneId).toBe('pane-persist')
      expect(loaded?.tool).toBe('claude-code')
      // xtermInstance is always null after load
      expect(loaded?.xtermInstance).toBeNull()
    })

    it('persist() + load() round-trip restores topic map', async () => {
      store.setTopicId('pane-1', 99)
      await store.persist()

      const store2 = createStateStore({ persistPath: tmpDir })
      await store2.load()
      expect(store2.getTopicId('pane-1')).toBe(99)
      expect(store2.getPaneByTopicId(99)).toBe('pane-1')
    })

    it('persist() + load() round-trip restores sessions', async () => {
      store.setSession('session-1', makeSession())
      await store.persist()

      const store2 = createStateStore({ persistPath: tmpDir })
      await store2.load()
      expect(store2.getSession('session-1')?.name).toBe('test-session')
    })

    it('persist() writes correct schemaVersion', async () => {
      await store.persist()
      const raw = JSON.parse(await readFile(join(tmpDir, 'state.json'), 'utf8')) as Record<string, unknown>
      expect(raw['schemaVersion']).toBe(CURRENT_SCHEMA_VERSION)
    })

    it('persist() creates .bak file on subsequent save', async () => {
      store.setPane('pane-1', makePaneState())
      await store.persist()
      // Second persist should create bak
      store.setPane('pane-2', makePaneState({ paneId: 'pane-2' }))
      await store.persist()
      const bakStat = await stat(join(tmpDir, 'state.json.bak'))
      expect(bakStat.isFile()).toBe(true)
    })

    it('persist() uses atomic write-then-rename (no .tmp file left behind)', async () => {
      await store.persist()
      let tmpExists = false
      try {
        await stat(join(tmpDir, 'state.json.tmp'))
        tmpExists = true
      } catch {
        tmpExists = false
      }
      expect(tmpExists).toBe(false)
    })

    it('load() on missing file starts with empty state (no throw)', async () => {
      // No persist() call — state.json does not exist
      const store2 = createStateStore({ persistPath: tmpDir })
      await expect(store2.load()).resolves.toBeUndefined()
      expect(store2.allPanes()).toHaveLength(0)
    })

    it('load() on corrupt JSON starts with empty state (no throw)', async () => {
      await writeFile(join(tmpDir, 'state.json'), '{ invalid json !!!', 'utf8')
      const store2 = createStateStore({ persistPath: tmpDir })
      await expect(store2.load()).resolves.toBeUndefined()
      expect(store2.allPanes()).toHaveLength(0)
    })
  })
})

describe('migrate()', () => {
  it('returns current-schema data unchanged for v1', () => {
    const input = {
      schemaVersion: 1,
      savedAt: 12345,
      panes: [],
      topicMap: {},
      sessions: [],
    }
    const result = migrate(input)
    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(result.savedAt).toBe(12345)
  })

  it('migrates v0 fixture (no schemaVersion) to current schema', () => {
    const v0Fixture = {
      savedAt: 10000,
      panes: [
        {
          paneId: 'p1',
          sessionId: 's1',
          windowId: 'w1',
          tool: 'aider',
          pid: null,
          status: 'idle',
          exitCode: null,
          notificationState: 'idle',
          lastNotifiedAt: null,
          lastOutputTime: 10000,
          processingCount: 0,
          lastBufferSnapshot: '',
          telegramTopicId: null,
          createdAt: 10000,
          updatedAt: 10000,
        },
      ],
      topicMap: { p1: 5 },
      sessions: [{ sessionId: 's1', name: 'main', createdAt: 10000 }],
    }
    const result = migrate(v0Fixture)
    expect(result.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(result.panes).toHaveLength(1)
    expect(result.sessions).toHaveLength(1)
    expect(result.topicMap['p1']).toBe(5)
  })

  it('throws MigrationError for non-object input', () => {
    expect(() => migrate('not an object')).toThrow(MigrationError)
    expect(() => migrate(null)).toThrow(MigrationError)
    expect(() => migrate(42)).toThrow(MigrationError)
  })

  it('throws MigrationError for unknown future schema version', () => {
    expect(() => migrate({ schemaVersion: 9999 })).toThrow(MigrationError)
  })
})
