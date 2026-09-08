import type { Bot } from 'grammy'
import { clearState, setState } from '../db/botStates.js'
import { getReviewRow } from '../db/taskSubmissions.js'
import { applyOwnerDecision, type DecisionDeps } from '../tasks/decide.js'
import { CB_RE } from './callbacks.js'
import type { BotDeps } from './deps.js'
import { BTN, cancelKeyboard, ownerMenu } from './keyboards.js'
import { onState, type BotContext, type RejectState } from './states.js'

async function dropButtons(ctx: BotContext): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined })
  } catch {
    /* сообщение могло быть альбомом или уже изменено */
  }
}

export function registerReviewStates(bot: Bot<BotContext>, deps: BotDeps): void {
  const { db } = deps
  const decisionDeps: DecisionDeps = { db, notifier: deps.notifier }

  onState(bot, 'reject_comment', async (ctx, next) => {
    if (ctx.role.kind !== 'owner') {
      clearState(db, ctx.from!.id)
      return next()
    }
    if (!ctx.message.text) {
      await ctx.reply('Напишите комментарий для сотрудника.', { reply_markup: cancelKeyboard() })
      return
    }
    if (ctx.message.text.trim().toLowerCase() === BTN.cancel.toLowerCase()) {
      clearState(db, ctx.from!.id)
      await ctx.reply('Отменено.', { reply_markup: ownerMenu() })
      return
    }
    const comment = ctx.message.text.trim()
    if (!comment) {
      await ctx.reply('Напишите комментарий для сотрудника.', { reply_markup: cancelKeyboard() })
      return
    }
    const r = await applyOwnerDecision(decisionDeps, ctx.state.submission_id, 'reject', comment, deps.now())
    clearState(db, ctx.from!.id)
    await ctx.reply(r.ok ? 'Отклонено, сотруднику отправлено.' : 'Уже решено.', { reply_markup: ownerMenu() })
  })
}

export function registerReview(bot: Bot<BotContext>, deps: BotDeps): void {
  const { db } = deps
  const decisionDeps: DecisionDeps = { db, notifier: deps.notifier }

  bot.callbackQuery(CB_RE.accept, async (ctx) => {
    const isOwner = ctx.role.kind === 'owner'
    if (!isOwner) return ctx.answerCallbackQuery({ text: 'Только для владельца.' })
    const id = Number(ctx.match[1])
    const row = getReviewRow(db, id)
    const r = await applyOwnerDecision(decisionDeps, id, 'accept', null, deps.now())
    if (!r.ok) return ctx.answerCallbackQuery({ text: r.reason === 'not_found' ? 'Сдача не найдена.' : 'Уже решено.' })
    await ctx.answerCallbackQuery({ text: 'Принято' })
    await dropButtons(ctx)
    await ctx.reply(`Принято: ${row?.title ?? ''}`.trim(), { reply_markup: ownerMenu() })
  })

  bot.callbackQuery(CB_RE.reject, async (ctx) => {
    const isOwner = ctx.role.kind === 'owner'
    if (!isOwner) return ctx.answerCallbackQuery({ text: 'Только для владельца.' })
    const id = Number(ctx.match[1])
    const row = getReviewRow(db, id)
    if (!row || row.decision !== 'needs_review') return ctx.answerCallbackQuery({ text: 'Уже решено.' })
    setState(db, ctx.from!.id, { kind: 'reject_comment', submission_id: id } satisfies RejectState)
    // комментарий придёт отдельным сообщением, поэтому кнопки снимаем сразу: иначе по ним
    // можно нажать ещё раз, пока владелец печатает. При отмене они так и остаются снятыми.
    await dropButtons(ctx)
    await ctx.answerCallbackQuery()
    await ctx.reply('Напишите комментарий для сотрудника.', { reply_markup: cancelKeyboard() })
  })
}
