import { Bot } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { normalizePhone } from '../lib/phone.js'
import type { BotDeps } from './deps.js'
import { registerLearning } from './learning.js'
import { registerFallback, registerLinking } from './linking.js'
import { registerReview, registerReviewStates } from './review.js'
import { registerContextMiddleware, type BotContext } from './states.js'
import { registerTaskStates, registerTasks } from './tasks.js'

export type BotOptions = { token: string; botInfo?: UserFromGetMe; deps: BotDeps }

export function createBot(opts: BotOptions): Bot<BotContext> {
  const ownerPhone = normalizePhone(opts.deps.ownerPhone)
  if (!ownerPhone) throw new Error('OWNER_PHONE is not a valid phone number')
  const deps: BotDeps = { ...opts.deps, ownerPhone }

  const bot = new Bot<BotContext>(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined)

  registerContextMiddleware(bot, deps)
  registerTaskStates(bot, deps)
  registerReviewStates(bot, deps)
  registerLinking(bot, deps)
  registerTasks(bot, deps)
  registerReview(bot, deps)
  registerLearning(bot, deps)
  registerFallback(bot, deps)

  bot.catch(async (err) => {
    console.error('bot error', err.error)
    if (!err.ctx.chat) return
    try {
      await err.ctx.reply('Что-то пошло не так, попробуйте ещё раз.')
    } catch (replyErr) {
      console.error('bot error reply failed', replyErr)
    }
  })

  return bot
}
