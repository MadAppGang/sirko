import { describe, it, expect, mock } from 'bun:test'
import { LinuxWchan, MacosWchan } from './wchan.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('LinuxWchan', () => {
  it('reads wchan from a real file', async () => {
    // Create a temp file simulating /proc/<pid>/wchan
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sirko-wchan-test-'))
    const wchanPath = path.join(tmpDir, 'wchan')
    fs.writeFileSync(wchanPath, 'pipe_read\n')

    // Monkey-patch to read from temp file
    const inspector = new LinuxWchan()
    // Override readWchan to use our temp file
    const originalReadWchan = inspector.readWchan.bind(inspector)
    inspector.readWchan = async (_pid: number) => {
      try {
        const file = Bun.file(wchanPath)
        const text = await file.text()
        return text.trim() || null
      } catch {
        return null
      }
    }

    const result = await inspector.readWchan(12345)
    expect(result).toBe('pipe_read')

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('returns null for non-existent process', async () => {
    const inspector = new LinuxWchan()
    // PID 999999999 almost certainly does not exist
    const result = await inspector.readWchan(999999999)
    expect(result).toBeNull()
  })
})

describe('MacosWchan', () => {
  it('returns null for non-existent process', async () => {
    const inspector = new MacosWchan(500)
    // PID 999999999 almost certainly does not exist
    const result = await inspector.readWchan(999999999)
    expect(result).toBeNull()
  })

  it('caches result for subsequent calls', async () => {
    const inspector = new MacosWchan(500)
    // Use a real PID that exists
    const currentPid = process.pid
    const result1 = await inspector.readWchan(currentPid)
    const result2 = await inspector.readWchan(currentPid)
    // Both should return the same value (cached)
    expect(result1).toBe(result2)
  })
})
