/**
 * Interactive demo of Sirko orchestrator.
 *
 * 1. Boots the orchestrator on an isolated tmux socket
 * 2. Creates a pane running prompt-script.sh (prints "> ", waits for input)
 * 3. Detects the prompt → logs PaneAwaitingInput
 * 4. Sends "hello world" as input
 * 5. Shows the echoed output
 * 6. Shuts down cleanly
 */

import { createOrchestrator } from './apps/orchestrator/src/orchestrator.js'
import { resolve } from 'node:path'

const FIXTURES = resolve(import.meta.dir, 'tests/e2e/fixtures')

async function demo() {
  console.log('\n🔧 Booting Sirko orchestrator...\n')

  const handle = await createOrchestrator({
    dataDir: '/tmp/sirko-demo-' + Date.now(),
    logDir: '/tmp/sirko-demo-logs',
    tmuxSocketPath: 'sirko-demo-' + Date.now(),
    quiescenceCheckIntervalMs: 200,
    outputCoalesceWindowMs: 30,
    logLevel: 'info',
  })
  await handle.start()
  console.log('✅ Orchestrator running.\n')

  // Subscribe to events
  handle.bus.on('PaneOutput', (e) => {
    const text = e.text.replace(/[\x00-\x1f]/g, ' ').trim()
    if (text.length > 0) {
      console.log(`📤 [PaneOutput] %${e.paneId}: ${text.slice(0, 120)}`)
    }
  })

  handle.bus.on('PaneAwaitingInput', (e) => {
    console.log(`\n🔔 [PaneAwaitingInput] %${e.paneId} — score: ${e.score.toFixed(2)}, tool: ${e.tool}`)
    console.log(`   signals: prompt=${e.signals.promptPattern.matched}, quiescence=${e.signals.quiescence.silenceMs}ms, wchan=${e.signals.wchan.value}\n`)
  })

  // --- Step 1: Create a pane with prompt-script.sh ---
  console.log('📋 Creating pane: bash prompt-script.sh (prints "> ", blocks on read)\n')
  const lines = await handle.tmuxClient.sendCommand(
    `new-window -P -F "#{pane_id}" bash ${FIXTURES}/prompt-script.sh`,
  )
  const paneId = lines[0]?.trim() ?? ''
  console.log(`   Pane created: ${paneId}\n`)

  // --- Step 2: Wait for detection ---
  console.log('⏳ Waiting for Sirko to detect the prompt...\n')
  await new Promise<void>((resolve) => {
    const unsub = handle.bus.on('PaneAwaitingInput', (e) => {
      if (e.paneId === paneId) {
        unsub()
        resolve()
      }
    })
  })

  // --- Step 3: Send input ---
  console.log('⌨️  Sending input: "hello world"')
  await handle.tmuxClient.sendKeys(paneId, 'hello world', { enter: true })

  // Wait for output event instead of capturePane (pane may exit after echo)
  await new Promise<void>((resolve) => {
    const unsub = handle.bus.on('PaneOutput', (e) => {
      if (e.paneId === paneId && e.text.includes('Got:')) {
        unsub()
        resolve()
      }
    })
    // Timeout fallback
    setTimeout(() => resolve(), 2000)
  })
  console.log('')

  // --- Step 4: Clean up ---
  console.log('🛑 Shutting down...')
  await handle.stop()
  try {
    await handle.tmuxClient.sendCommand('kill-server')
  } catch {
    // Already disconnected
  }

  console.log('✅ Done.\n')
}

demo().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
