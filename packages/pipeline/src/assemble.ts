import type { StateStore } from '@sirko/state-store'
import type { TypedEventBus } from '@sirko/event-bus'
import type { TmuxClient } from '@sirko/tmux-client'
import type { DetectorEngine } from '@sirko/detector'
import { compose, type Pipeline } from './compose.js'
import { createStateManagerMiddleware } from './middleware/state-manager.js'
import { createXtermInterpretMiddleware } from './middleware/xterm-interpret.js'
import { createDetectionMiddleware } from './middleware/detection.js'
import { createDedupMiddleware } from './middleware/dedup.js'
import { createNotificationFanoutMiddleware } from './middleware/notification-fanout.js'
import { createOutputArchiveMiddleware } from './middleware/output-archive.js'
import { createLoggerMiddleware, type LogLevel } from './middleware/logger.js'

export interface AssemblePipelineDeps {
  store: StateStore
  bus: TypedEventBus
  tmuxClient: TmuxClient
  engine: DetectorEngine
  logDir: string
  logLevel?: LogLevel
}

/**
 * Creates the composed middleware chain in the correct order:
 * [state-manager, xterm-interpret, detection, dedup, notification-fanout, output-archive, logger]
 *
 * NOTE: state-manager MUST come before xterm-interpret because xterm-interpret reads
 * ctx.pane.xtermInstance, which state-manager loads from the store in its PRE phase.
 */
export function assemblePipeline(deps: AssemblePipelineDeps): Pipeline {
  const { store, bus, tmuxClient, engine, logDir } = deps

  return compose([
    createStateManagerMiddleware(store, tmuxClient),
    createXtermInterpretMiddleware(tmuxClient),
    createDetectionMiddleware(engine),
    createDedupMiddleware(),
    createNotificationFanoutMiddleware(bus),
    createOutputArchiveMiddleware({ logDir }),
    createLoggerMiddleware({ level: deps.logLevel }),
  ])
}
