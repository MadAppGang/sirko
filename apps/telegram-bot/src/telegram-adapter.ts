import { Bot, InputFile } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import type { StateStore } from '@sirko/state-store'
import type { TmuxClient } from '@sirko/tmux-client'
import type { AdapterSink, SirkoEvent } from '@sirko/shared'
import { TopicManager } from './topic-manager.js'
import { OutputStreamer } from './output-streamer.js'
import { MessageRouter } from './message-router.js'
import { registerCommands } from './commands.js'
import { formatAwaitingInput, escapeHtml } from './format.js'

export interface TelegramAdapterOptions {
  botToken: string
  groupId: number
  /** Streaming mode: 'draft' | 'edit'. Default: 'edit' */
  streamingMode?: 'draft' | 'edit'
  /** Custom API root URL for grammY Bot client (e.g. for test mock servers) */
  apiRoot?: string
}

/**
 * grammY-based Telegram adapter implementing AdapterSink.
 * Streams pane output to Telegram forum topics, handles user replies,
 * and provides bot commands for session management.
 */
export class TelegramAdapter implements AdapterSink {
  readonly name = 'telegram'

  private readonly options: Required<TelegramAdapterOptions>
  private readonly store: StateStore
  private readonly tmuxClient: TmuxClient
  private bot: Bot | null = null
  private topicManager: TopicManager | null = null
  private outputStreamer: OutputStreamer | null = null
  private messageRouter: MessageRouter | null = null
  private running = false

  constructor(
    options: TelegramAdapterOptions,
    store: StateStore,
    tmuxClient: TmuxClient,
  ) {
    this.options = {
      botToken: options.botToken,
      groupId: options.groupId,
      streamingMode: options.streamingMode ?? 'edit',
      apiRoot: options.apiRoot ?? '',
    }
    this.store = store
    this.tmuxClient = tmuxClient
  }

  /**
   * Initialize grammY bot with plugins and start polling.
   */
  async start(): Promise<void> {
    if (this.running) return

    const bot = new Bot(this.options.botToken, {
      ...(this.options.apiRoot !== '' ? { client: { apiRoot: this.options.apiRoot } } : {}),
    })

    // Install API transformer plugins
    bot.api.config.use(autoRetry())

    const topicManager = new TopicManager(bot, this.store, this.options.groupId)
    topicManager.restoreMappings()

    const outputStreamer = new OutputStreamer({
      debounceMs: 100,
      maxBufferChars: 3000,
      onSend: async ({ topicId, text }) => {
        await bot.api.sendMessage(this.options.groupId, text, {
          message_thread_id: topicId,
          parse_mode: 'HTML',
        })
      },
      onSendFile: async ({ topicId, content, filename }) => {
        const encoder = new TextEncoder()
        const bytes = encoder.encode(content)
        await bot.api.sendDocument(
          this.options.groupId,
          new InputFile(bytes, filename),
          { message_thread_id: topicId },
        )
      },
    })

    const messageRouter = new MessageRouter(this.tmuxClient, topicManager)

    // Register commands
    registerCommands(bot, this.store, this.tmuxClient)

    // Route user messages in forum topics to tmux panes
    bot.on('message:text', async (ctx) => {
      await messageRouter.handle(ctx)
    })

    this.bot = bot
    this.topicManager = topicManager
    this.outputStreamer = outputStreamer
    this.messageRouter = messageRouter
    this.running = true

    // Start bot polling (non-blocking)
    bot.start({
      onStart: (info) => {
        console.log('[TelegramAdapter] Bot started:', info.username)
      },
    }).catch((err) => {
      console.error('[TelegramAdapter] Bot polling error:', err)
      this.running = false
    })
  }

  /**
   * Stop bot polling and flush output buffers.
   */
  async stop(): Promise<void> {
    this.outputStreamer?.flushAll()
    if (this.bot !== null) {
      await this.bot.stop()
    }
    this.running = false
  }

  /**
   * Return true if the bot is connected and polling.
   */
  isHealthy(): boolean {
    return this.running && this.bot !== null
  }

  /**
   * Stream pane output text to the mapped Telegram topic.
   */
  async handlePaneOutput(event: Extract<SirkoEvent, { type: 'PaneOutput' }>): Promise<void> {
    if (this.outputStreamer === null || this.topicManager === null) return

    const topicId = this.topicManager.getTopicForPane(event.paneId)
    if (topicId === undefined) return

    this.outputStreamer.push(topicId, event.text)
  }

  /**
   * Send an alert message when a pane is awaiting input.
   */
  async handlePaneAwaitingInput(
    event: Extract<SirkoEvent, { type: 'PaneAwaitingInput' }>,
  ): Promise<void> {
    if (this.bot === null || this.topicManager === null) return

    const topicId = await this.topicManager.ensureTopic(
      event.paneId,
      event.tool,
      event.sessionId,
    )

    // Flush any buffered output before the notification
    this.outputStreamer?.flush(topicId)

    const text = formatAwaitingInput(event.tool, event.confidence, event.context)
    await this.bot.api.sendMessage(this.options.groupId, text, {
      message_thread_id: topicId,
      parse_mode: 'HTML',
    })
  }

  /**
   * Send exit notification and close the topic.
   */
  async handlePaneExited(event: Extract<SirkoEvent, { type: 'PaneExited' }>): Promise<void> {
    if (this.bot === null || this.topicManager === null) return

    const topicId = this.topicManager.getTopicForPane(event.paneId)
    if (topicId === undefined) return

    // Flush buffered output
    this.outputStreamer?.flush(topicId)

    const exitMsg =
      event.exitCode !== null
        ? `Pane <code>${escapeHtml(event.paneId)}</code> exited with code <b>${event.exitCode}</b>`
        : `Pane <code>${escapeHtml(event.paneId)}</code> exited`

    await this.bot.api.sendMessage(this.options.groupId, exitMsg, {
      message_thread_id: topicId,
      parse_mode: 'HTML',
    })

    await this.topicManager.closeTopic(event.paneId)
  }

  /**
   * Acknowledge input delivery (optional confirmation message).
   */
  async handleInputDelivered(
    event: Extract<SirkoEvent, { type: 'InputDelivered' }>,
  ): Promise<void> {
    if (this.bot === null || this.topicManager === null) return

    const topicId = this.topicManager.getTopicForPane(event.paneId)
    if (topicId === undefined) return

    // Send a subtle acknowledgment reaction or message
    const ackText = `Input delivered via <b>${event.source}</b>`
    await this.bot.api.sendMessage(this.options.groupId, ackText, {
      message_thread_id: topicId,
      parse_mode: 'HTML',
    })
  }
}

export function createTelegramAdapter(
  options: TelegramAdapterOptions,
  store: StateStore,
  tmuxClient: TmuxClient,
): TelegramAdapter {
  return new TelegramAdapter(options, store, tmuxClient)
}
