import type { Bot, Context, NextFunction } from 'grammy'
import type { Message } from 'grammy/types'
import { getState } from '../db/botStates.js'
import type { Employee } from '../db/employees.js'
import type { BotDeps } from './deps.js'
import { roleOf, type Role } from './roles.js'

export type CollectingState = {
  kind: 'collecting_photos'
  instance_id: number
  photos: { path: string; fileUniqueId: string }[]
}
export type RejectState = { kind: 'reject_comment'; submission_id: number }
export type QuizState = { kind: 'quiz'; attempt_id: number }
export type BotState = CollectingState | RejectState | QuizState
export type StateKind = BotState['kind']

export type BotContext = Context & { role: Role; state: BotState | null }

export type StateHandler<K extends StateKind> = (
  ctx: BotContext & { state: Extract<BotState, { kind: K }>; message: Message },
  next: NextFunction,
) => Promise<void> | void

/** Роль и состояние диалога резолвятся один раз на апдейт. */
export function registerContextMiddleware(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      ctx.role = roleOf(deps.db, ctx.from.id)
      ctx.state = getState<BotState>(deps.db, ctx.from.id)
    } else {
      ctx.role = { kind: 'unknown' }
      ctx.state = null
    }
    await next()
  })
}

/** Обработчик сообщений для одного вида состояния. Callback-запросы и другие состояния идут дальше. */
export function onState<K extends StateKind>(bot: Bot<BotContext>, kind: K, handler: StateHandler<K>): void {
  bot.use(async (ctx, next) => {
    if (!ctx.message || ctx.state?.kind !== kind) return next()
    await handler(ctx as Parameters<StateHandler<K>>[0], next)
  })
}

export function employeeOf(ctx: BotContext): Employee | null {
  return ctx.role.kind === 'employee' ? ctx.role.employee : null
}
