export interface WchanInspector {
  readWchan(pid: number): Promise<string | null>
}

/**
 * Linux: reads /proc/<pid>/wchan
 */
export class LinuxWchan implements WchanInspector {
  async readWchan(pid: number): Promise<string | null> {
    try {
      const file = Bun.file(`/proc/${pid}/wchan`)
      const exists = await file.exists()
      if (!exists) return null
      const text = await file.text()
      return text.trim() || null
    } catch {
      return null
    }
  }
}

interface CacheEntry {
  value: string | null
  expiresAt: number
}

/**
 * macOS: runs `ps -o wchan= -p <pid>`, caches result for cacheMs milliseconds
 */
const STALE_EVICTION_MS = 30_000

export class MacosWchan implements WchanInspector {
  private readonly cacheMs: number
  private readonly cache: Map<number, CacheEntry> = new Map()

  constructor(cacheMs = 500) {
    this.cacheMs = cacheMs
  }

  /** Remove cache entries that expired more than STALE_EVICTION_MS ago. */
  private evictStale(now: number): void {
    const cutoff = now - STALE_EVICTION_MS
    for (const [pid, entry] of this.cache) {
      if (entry.expiresAt < cutoff) {
        this.cache.delete(pid)
      }
    }
  }

  async readWchan(pid: number): Promise<string | null> {
    const now = Date.now()
    this.evictStale(now)
    const cached = this.cache.get(pid)
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.value
    }

    try {
      const proc = Bun.spawn(['ps', '-o', 'wchan=', '-p', String(pid)], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        this.cache.set(pid, { value: null, expiresAt: now + this.cacheMs })
        return null
      }
      const value = output.trim() || null
      this.cache.set(pid, { value, expiresAt: now + this.cacheMs })
      return value
    } catch {
      this.cache.set(pid, { value: null, expiresAt: now + this.cacheMs })
      return null
    }
  }
}

/**
 * Factory: returns correct inspector for current platform.
 */
export function createWchanInspector(): WchanInspector {
  if (process.platform === 'linux') {
    return new LinuxWchan()
  }
  return new MacosWchan()
}
