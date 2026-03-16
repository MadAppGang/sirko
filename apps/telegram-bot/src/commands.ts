import type { Bot, Context } from 'grammy'
import type { TmuxClient } from '@sirko/tmux-client'
import { validateSessionName } from '@sirko/tmux-client'
import type { StateStore } from '@sirko/state-store'
import { escapeHtml } from './html-utils.js'

function validatePaneIdLocal(id: string): void {
  if (!/^%\d+$/.test(id)) throw new Error(`Invalid pane ID: ${id}`)
}

/**
 * Register bot commands:
 * /start   — welcome message
 * /sessions — list active sessions with status
 * /new <name> — create new tmux session
 * /kill <paneId> — terminate a pane
 */
export function registerCommands(
  bot: Bot,
  store: StateStore,
  tmuxClient: TmuxClient,
): void {
  bot.command('start', async (ctx: Context) => {
    await ctx.reply(
      '<b>Sirko</b> — AI coding assistant monitor\n\n' +
        'Commands:\n' +
        '/sessions — list active sessions\n' +
        '/new &lt;name&gt; — create a new tmux session\n' +
        '/kill &lt;paneId&gt; — terminate a pane',
      { parse_mode: 'HTML' },
    )
  })

  bot.command('sessions', async (ctx: Context) => {
    const sessions = store.allSessions()
    if (sessions.length === 0) {
      await ctx.reply('No active sessions.', { parse_mode: 'HTML' })
      return
    }

    const lines = sessions.map((s) => {
      const panes = store.allPanes().filter((p) => p.sessionId === s.sessionId)
      const paneList = panes.map((p) => `  • pane <code>${escapeHtml(p.paneId)}</code> [${p.status}]`).join('\n')
      return `<b>${escapeHtml(s.name)}</b> (<code>${escapeHtml(s.sessionId)}</code>)\n${paneList}`
    })

    await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' })
  })

  bot.command('new', async (ctx: Context) => {
    const text = ctx.message?.text ?? ''
    const parts = text.split(/\s+/)
    const name = parts[1]

    if (name === undefined || name.length === 0) {
      await ctx.reply('Usage: /new &lt;session-name&gt;', { parse_mode: 'HTML' })
      return
    }

    try {
      validateSessionName(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`Invalid session name: ${escapeHtml(msg)}`, { parse_mode: 'HTML' })
      return
    }

    try {
      const sessionId = await tmuxClient.newSession(name)
      await ctx.reply(
        `Created session <code>${escapeHtml(name)}</code> (id: <code>${escapeHtml(sessionId)}</code>)`,
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`Failed to create session: ${escapeHtml(msg)}`, { parse_mode: 'HTML' })
    }
  })

  bot.command('kill', async (ctx: Context) => {
    const text = ctx.message?.text ?? ''
    const parts = text.split(/\s+/)
    const paneId = parts[1]

    if (paneId === undefined || paneId.length === 0) {
      await ctx.reply('Usage: /kill &lt;paneId&gt;', { parse_mode: 'HTML' })
      return
    }

    try {
      validatePaneIdLocal(paneId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`Invalid pane ID: ${escapeHtml(msg)}`, { parse_mode: 'HTML' })
      return
    }

    try {
      await tmuxClient.sendCommand(`kill-pane -t ${paneId}`)
      await ctx.reply(`Killed pane <code>${escapeHtml(paneId)}</code>`, { parse_mode: 'HTML' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`Failed to kill pane: ${escapeHtml(msg)}`, { parse_mode: 'HTML' })
    }
  })
}
