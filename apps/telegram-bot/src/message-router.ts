import type { Context } from 'grammy'
import type { TmuxClient } from '@sirko/tmux-client'
import { sanitizeForSendKeys } from '@sirko/shared'
import type { TopicManager } from './topic-manager.js'

/**
 * Routes incoming Telegram messages to the appropriate tmux pane.
 *
 * When a user sends a message in a forum topic, we look up which pane
 * owns that topic and forward the text via tmuxClient.sendKeys().
 */
export class MessageRouter {
  private readonly tmuxClient: TmuxClient
  private readonly topicManager: TopicManager

  constructor(tmuxClient: TmuxClient, topicManager: TopicManager) {
    this.tmuxClient = tmuxClient
    this.topicManager = topicManager
  }

  /**
   * Handle an incoming grammY context (message in a forum topic).
   * Routes text to the corresponding tmux pane.
   */
  async handle(ctx: Context): Promise<void> {
    const topicId = ctx.message?.message_thread_id
    const text = ctx.message?.text

    if (topicId === undefined || text === undefined) return

    const paneId = this.topicManager.getPaneForTopic(topicId)
    if (paneId === undefined) {
      // No pane mapped to this topic — silently ignore
      return
    }

    try {
      await this.tmuxClient.sendKeys(paneId, sanitizeForSendKeys(text))
      // Send Enter key separately
      await this.tmuxClient.sendKeys(paneId, '')
    } catch (err) {
      console.error('[MessageRouter] Failed to send keys to pane', paneId, err)
    }
  }
}
