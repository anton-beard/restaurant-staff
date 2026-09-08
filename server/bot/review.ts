import type { Bot, Context } from 'grammy'
import { clearState, getState, setState } from '../db/botStates.js'
import { getReviewRow } from '../db/taskSubmissions.js'
import { applyOwnerDecision, type DecisionDeps } from '../tasks/decide.js'
import { CB_RE } from './callbacks.js'
import type { BotDeps } from './deps.js'
import { BTN, cancelKeyboard, ownerMenu } from './keyboards.js'
import { roleOf } from './roles.js'

type RejectState = { kind: 'reject_comment'; submission_id: number }

export function registerReview(bot: Bot, deps: BotDeps): void {
  const { db } = deps
  const isOwner = (ctx: Context) => !!ctx.from && roleOf(db, ctx.from.id).kind === 'owner'
  const rejectState = (telegramId: number): RejectState | null => {
    const s = getState<RejectState>(db, telegramId)
    return s?.kind === 'reject_comment' ? s : null
  }
  const decisionDeps: DecisionDeps = { db, notifier: deps.notifier }

  async function dropButtons(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined })
    } catch {
      /* сообщение могло быть альбомом или уже изменено */
    }
  }

  bot.callbackQuery(CB_RE.accept, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Только для владельца.' })
    const id = Number(ctx.match[1])
    const row = getReviewRow(db, id)
    const r = await applyOwnerDecision(decisionDeps, id, 'accept', null, deps.now())
    if (!r.ok) return ctx.answerCallbackQuery({ text: r.reason === 'not_found' ? 'Сдача не найдена.' : 'Уже решено.' })
    await ctx.answerCallbackQuery({ text: 'Принято' })
    await dropButtons(ctx)
    await ctx.reply(`Принято: ${row?.title ?? ''}`.trim(), { reply_markup: ownerMenu() })
  })

  bot.callbackQuery(CB_RE.reject, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'Только для владельца.' })
    const id = Number(ctx.match[1])
    const row = getReviewRow(db, id)
    if (!row || row.decision !== 'needs_review') return ctx.answerCallbackQuery({ text: 'Уже решено.' })
    setState(db, ctx.from.id, { kind: 'reject_comment', submission_id: id } satisfies RejectState)
    // комментарий придёт отдельным сообщением, поэтому кнопки снимаем сразу: иначе по ним
    // можно нажать ещё раз, пока владелец печатает. При отмене они так и остаются снятыми.
    await dropButtons(ctx)
    await ctx.answerCallbackQuery()
    await ctx.reply('Напишите комментарий для сотрудника.', { reply_markup: cancelKeyboard() })
  })

  bot.hears(BTN.cancel, async (ctx, next) => {
    if (!ctx.from || !rejectState(ctx.from.id)) return next()
    clearState(db, ctx.from.id)
    await ctx.reply('Отменено.', { reply_markup: ownerMenu() })
  })

  bot.on('message:text', async (ctx, next) => {
    const state = rejectState(ctx.from.id)
    if (!state || !isOwner(ctx)) return next()
    const comment = ctx.message.text.trim()
    if (!comment) {
      await ctx.reply('Напишите комментарий для сотрудника.', { reply_markup: cancelKeyboard() })
      return
    }
    const r = await applyOwnerDecision(decisionDeps, state.submission_id, 'reject', comment, deps.now())
    clearState(db, ctx.from.id)
    await ctx.reply(r.ok ? 'Отклонено, сотруднику отправлено.' : 'Уже решено.', { reply_markup: ownerMenu() })
  })
}
