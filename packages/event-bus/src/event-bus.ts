import type { SirkoEvent } from '@sirko/shared'

export interface TypedEventBusOptions {
  /** Max pending events per subscriber before oldest is dropped. Default: 1000 */
  maxQueueSize?: number
}

type AnyHandler = (event: SirkoEvent) => void | Promise<void>

/** Internal representation — erases generics for storage */
interface RawSubscriber {
  handler: AnyHandler
  queue: SirkoEvent[]
  maxQueueSize: number
}

export class TypedEventBus {
  private readonly maxQueueSize: number
  /** Per-type subscribers */
  private readonly typed: Map<string, Set<RawSubscriber>> = new Map()
  /** Wildcard subscribers */
  private readonly wildcards: Set<RawSubscriber> = new Set()

  constructor(options: TypedEventBusOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 1000
  }

  /**
   * Subscribe to a specific event type.
   * Returns an unsubscribe function.
   */
  on<T extends SirkoEvent['type']>(
    type: T,
    handler: (event: Extract<SirkoEvent, { type: T }>) => void | Promise<void>,
  ): () => void {
    // Safe: this subscriber is only invoked for events of the matching type
    const sub: RawSubscriber = {
      handler: handler as AnyHandler,
      queue: [],
      maxQueueSize: this.maxQueueSize,
    }

    let set = this.typed.get(type)
    if (set === undefined) {
      set = new Set()
      this.typed.set(type, set)
    }
    set.add(sub)

    return () => {
      set?.delete(sub)
    }
  }

  /**
   * Subscribe to all events regardless of type.
   * Returns an unsubscribe function.
   */
  onAny(handler: (event: SirkoEvent) => void | Promise<void>): () => void {
    const sub: RawSubscriber = {
      handler,
      queue: [],
      maxQueueSize: this.maxQueueSize,
    }
    this.wildcards.add(sub)
    return () => {
      this.wildcards.delete(sub)
    }
  }

  /**
   * Emit an event to all matching typed subscribers and all wildcard subscribers.
   * Uses Promise.allSettled so one handler's error does not block others.
   */
  async emit(event: SirkoEvent): Promise<void> {
    const promises: Promise<void>[] = []

    const typedSet = this.typed.get(event.type)
    if (typedSet !== undefined) {
      for (const sub of typedSet) {
        promises.push(this.dispatch(sub, event))
      }
    }

    for (const sub of this.wildcards) {
      promises.push(this.dispatch(sub, event))
    }

    await Promise.allSettled(promises)
  }

  private async dispatch(sub: RawSubscriber, event: SirkoEvent): Promise<void> {
    // Bounded queue: drop oldest if at capacity
    if (sub.queue.length >= sub.maxQueueSize) {
      sub.queue.shift()
    }
    sub.queue.push(event)

    // Dequeue and invoke — errors are caught to provide isolation
    const next = sub.queue.shift()
    if (next === undefined) return

    try {
      await sub.handler(next)
    } catch (err) {
      // Error isolation: log but do not rethrow
      console.error('[EventBus] Handler error (isolated):', err)
    }
  }
}

export function createEventBus(options?: TypedEventBusOptions): TypedEventBus {
  return new TypedEventBus(options)
}
