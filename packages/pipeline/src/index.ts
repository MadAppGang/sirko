export { buildContext, buildQuiescenceContext } from './context.js'
export type { EventContext, SideEffect } from './context.js'

export { compose } from './compose.js'
export type { Middleware, Pipeline } from './compose.js'

export { assemblePipeline } from './assemble.js'
export type { AssemblePipelineDeps } from './assemble.js'

export { createStateManagerMiddleware } from './middleware/state-manager.js'
export { createXtermInterpretMiddleware } from './middleware/xterm-interpret.js'
export type { XtermInterpretOptions } from './middleware/xterm-interpret.js'
export { createDetectionMiddleware } from './middleware/detection.js'
export { createDedupMiddleware } from './middleware/dedup.js'
export { createNotificationFanoutMiddleware } from './middleware/notification-fanout.js'
export { createOutputArchiveMiddleware } from './middleware/output-archive.js'
export type { OutputArchiveOptions } from './middleware/output-archive.js'
export { createLoggerMiddleware } from './middleware/logger.js'
