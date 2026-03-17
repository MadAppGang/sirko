import { loadConfig } from './config.js'
import { createOrchestrator } from './orchestrator.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const handle = await createOrchestrator(config)
  await handle.start()

  const shutdown = async (): Promise<void> => {
    await handle.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    shutdown().catch((err: unknown) => {
      console.error('[sirko] shutdown error', err)
      process.exit(1)
    })
  })
  process.on('SIGTERM', () => {
    shutdown().catch((err: unknown) => {
      console.error('[sirko] shutdown error', err)
      process.exit(1)
    })
  })
}

main().catch((err: unknown) => {
  console.error('[sirko] fatal error', err)
  process.exit(1)
})
