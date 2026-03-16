import type { Bot } from 'grammy'
import type { StateStore } from '@sirko/state-store'
import type { ToolName } from '@sirko/shared'

/**
 * Manages Telegram forum topic creation and the pane↔topic mapping.
 * Topics are created per-pane. Mappings are persisted via StateStore.
 */
export class TopicManager {
  private readonly bot: Bot
  private readonly store: StateStore
  private readonly groupId: number

  constructor(bot: Bot, store: StateStore, groupId: number) {
    this.bot = bot
    this.store = store
    this.groupId = groupId
  }

  /**
   * Returns the existing topicId for a pane, or creates a new forum topic.
   * Persists the mapping in StateStore.
   */
  async ensureTopic(
    paneId: string,
    tool: ToolName,
    sessionName: string,
  ): Promise<number> {
    const existing = this.store.getTopicId(paneId)
    if (existing !== undefined) return existing

    const topicName = `${sessionName} [${tool}]`
    const result = await this.bot.api.createForumTopic(this.groupId, topicName)
    const topicId = result.message_thread_id

    this.store.setTopicId(paneId, topicId)
    await this.store.persist()

    return topicId
  }

  /**
   * Closes (archives) the forum topic for a pane.
   */
  async closeTopic(paneId: string): Promise<void> {
    const topicId = this.store.getTopicId(paneId)
    if (topicId === undefined) return

    try {
      await this.bot.api.closeForumTopic(this.groupId, topicId)
    } catch {
      // Best-effort; topic may already be closed or not exist
    }
  }

  /**
   * Get the topicId for a pane (if it exists).
   */
  getTopicForPane(paneId: string): number | undefined {
    return this.store.getTopicId(paneId)
  }

  /**
   * Get the paneId for a topic (reverse lookup).
   */
  getPaneForTopic(topicId: number): string | undefined {
    return this.store.getPaneByTopicId(topicId)
  }

  /**
   * Restore topic↔pane mappings from StateStore on startup.
   * (StateStore already loads them from state.json — this is a no-op verification.)
   */
  restoreMappings(): void {
    const panes = this.store.allPanes()
    for (const pane of panes) {
      if (pane.telegramTopicId !== null) {
        // StateStore.load() already populates topicMap from persisted panes.
        // No further action needed here; this method exists for callers to call
        // as a lifecycle hook after store.load().
      }
    }
  }
}
