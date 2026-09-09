import type { Bot } from 'grammy'
import type { Db } from '../db/connect.js'
import { employeeMetrics, periodDaysBack, rating } from '../stats/metrics.js'
import type { BotDeps } from './deps.js'
import { BTN, employeeMenu } from './keyboards.js'
import { showHome } from './linking.js'
import { employeeOf, type BotContext } from './states.js'

export function ratingText(db: Db, employeeId: number, now: Date): string {
  const period = periodDaysBack(now, 30)
  const m = employeeMetrics(db, employeeId, period)
  const lines = ['За 30 дней']
  lines.push(m.score === null ? 'Пока нет данных для рейтинга.' : `Балл: ${m.score}`)
  lines.push(m.tasks.total === 0 ? 'Заданий пока не было.' : `Заданий в срок: ${m.tasks.onTime} из ${m.tasks.total}`)
  lines.push(m.quiz.attempts === 0 ? 'Тестов пока не было.' : `Тесты: средний балл ${m.quiz.avgScore}`)
  if (m.score !== null) {
    const rows = rating(db, period).filter((r) => r.score !== null)
    const me = rows.find((r) => r.employee_id === employeeId)
    if (me?.place) lines.push(`Место: ${me.place} из ${rows.length}`)
  }
  return lines.join('\n')
}

export function registerRating(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.hears(BTN.rating, async (ctx) => {
    const emp = employeeOf(ctx)
    if (!emp) return showHome(ctx, deps)
    await ctx.reply(ratingText(deps.db, emp.id, deps.now()), { reply_markup: employeeMenu() })
  })
}
