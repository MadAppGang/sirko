import type { EventContext } from './context.js'

export type Middleware = (ctx: EventContext, next: () => Promise<void>) => Promise<void>

export interface Pipeline {
  run(ctx: EventContext): Promise<void>
}

/**
 * Koa-style compose: calls each middleware in order, passing next() to advance.
 * Returns a Pipeline with a run() method.
 * If a middleware does not call next(), remaining middleware do not execute.
 */
export function compose(middlewares: Middleware[]): Pipeline {
  return {
    async run(ctx: EventContext): Promise<void> {
      let index = -1

      async function dispatch(i: number): Promise<void> {
        if (i <= index) {
          throw new Error('next() called multiple times')
        }
        index = i
        const middleware = middlewares[i]
        if (middleware === undefined) {
          // End of chain
          return
        }
        await middleware(ctx, () => dispatch(i + 1))
      }

      await dispatch(0)
    },
  }
}
