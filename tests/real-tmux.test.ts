import { describe, it, expect, afterAll } from 'bun:test'
import { TmuxClient } from '../packages/tmux-client/src/index'

const SOCKET = 'sirko-realtest-' + Date.now()

describe('TmuxClient against real tmux', () => {
  const client = new TmuxClient({ socketName: SOCKET })

  afterAll(async () => {
    try { await client.sendCommand('kill-server') } catch {}
    client.disconnect()
  })

  it('connects and lists sessions', async () => {
    await client.connect()
    const result = await client.sendCommand('list-sessions -F "#{session_name}"')
    expect(result).toBeDefined()
    expect(result.length).toBeGreaterThan(0)
  })

  it('sends keys and captures output', async () => {
    const panes = await client.sendCommand('list-panes -a -F "#{pane_id}"')
    const paneId = panes[0]?.trim()
    expect(paneId).toMatch(/^%\d+$/)

    await client.sendKeys(paneId!, 'echo SIRKO_LIVE_TEST', { enter: true })
    await new Promise(r => setTimeout(r, 500))

    const captured = await client.sendCommand(`capture-pane -t ${paneId} -p`)
    const output = captured.join('\n')
    expect(output).toContain('SIRKO_LIVE_TEST')
  })
})
