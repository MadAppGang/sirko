/**
 * waitFor — polls a condition until it returns true or times out.
 *
 * Anti-flakiness: never assert on timing, only on eventual state.
 */

export interface WaitForOptions {
  /** Maximum time to wait in ms. Default: 10000 */
  timeoutMs?: number
  /** Polling interval in ms. Default: 50 */
  pollMs?: number
  /** Description for the error message */
  label?: string
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<void> {
  const { timeoutMs = 10_000, pollMs = 50, label = 'condition' } = options
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const result = await condition()
    if (result) return
    await new Promise((r) => setTimeout(r, pollMs))
  }

  throw new Error(`waitFor("${label}") timed out after ${timeoutMs}ms`)
}

/**
 * waitForValue — polls until a getter returns a non-undefined value, then returns it.
 */
export async function waitForValue<T>(
  getter: () => T | undefined | Promise<T | undefined>,
  options: WaitForOptions = {},
): Promise<T> {
  let lastValue: T | undefined
  await waitFor(async () => {
    lastValue = await getter()
    return lastValue !== undefined
  }, options)
  return lastValue!
}
