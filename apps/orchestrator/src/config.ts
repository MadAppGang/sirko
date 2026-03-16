import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OrchestratorConfig {
  /** Data storage directory (from SIRKO_DATA_DIR, default ~/.sirko) */
  dataDir: string
  /** Derived: dataDir/logs */
  logDir: string

  /** tmux socket path (from SIRKO_TMUX_SOCKET, undefined = use tmux default) */
  tmuxSocketPath: string | undefined

  /** Quiescence scheduler check interval in ms (default 500) */
  quiescenceCheckIntervalMs: number

  /** Output coalescing window in ms (default 50) */
  outputCoalesceWindowMs: number

  /** Log level (from SIRKO_LOG_LEVEL, default 'info') */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

function parseLogLevel(raw: string | undefined): 'debug' | 'info' | 'warn' | 'error' {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw
  }
  return 'info'
}

/**
 * Loads configuration from environment variables with sensible defaults.
 * Throws if required variables are missing (none are required currently — all have defaults).
 */
export function loadConfig(): OrchestratorConfig {
  const dataDir = process.env['SIRKO_DATA_DIR']
    ? process.env['SIRKO_DATA_DIR']
    : join(homedir(), '.sirko')

  const logDir = join(dataDir, 'logs')

  const tmuxSocketPath = process.env['SIRKO_TMUX_SOCKET'] || undefined

  const quiescenceCheckIntervalMs = process.env['SIRKO_QUIESCENCE_INTERVAL_MS']
    ? parseInt(process.env['SIRKO_QUIESCENCE_INTERVAL_MS'], 10)
    : 500

  const outputCoalesceWindowMs = process.env['SIRKO_COALESCE_WINDOW_MS']
    ? parseInt(process.env['SIRKO_COALESCE_WINDOW_MS'], 10)
    : 50

  const logLevel = parseLogLevel(process.env['SIRKO_LOG_LEVEL'])

  return {
    dataDir,
    logDir,
    tmuxSocketPath,
    quiescenceCheckIntervalMs,
    outputCoalesceWindowMs,
    logLevel,
  }
}
