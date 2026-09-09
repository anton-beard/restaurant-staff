import type { Db } from '../db/connect.js'
import { findEmployeeByTelegramId, listEmployees, type Employee } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID } from '../db/settings.js'
import { countOverdueSince } from '../db/taskInstances.js'
import { periodDaysBack, rating } from '../stats/metrics.js'
import { summary } from '../stats/summary.js'

export type Role =
  | { kind: 'owner' }
  | { kind: 'employee'; employee: Employee }
  | { kind: 'unknown' }

export function roleOf(db: Db, telegramId: number): Role {
  if (getSetting(db, OWNER_TELEGRAM_ID) === String(telegramId)) return { kind: 'owner' }
  const employee = findEmployeeByTelegramId(db, telegramId)
  if (employee && employee.status === 'active') return { kind: 'employee', employee }
  return { kind: 'unknown' }
}

export function summaryText(db: Db, publicUrl: string | undefined, now: Date, tz: string): string {
  const all = listEmployees(db)
  const active = all.filter((e) => e.status === 'active').length
  const invited = all.filter((e) => e.status === 'invited').length
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
  const s = summary(db, now, tz)
  const top = rating(db, periodDaysBack(now, 30)).filter((r) => r.score !== null).slice(0, 3)
  const lines = [
    `Активны: ${active}`,
    `Приглашены: ${invited}`,
    `Сегодня: выдано ${s.today.issued}, в срок ${s.today.onTime}, просрочено ${s.today.overdue}`,
    `На проверке: ${s.queue.awaitingOwner}`,
    `Просрочено за сутки: ${countOverdueSince(db, dayAgo)}`,
    top.length ? `Топ за 30 дней: ${top.map((r, i) => `${i + 1}. ${r.full_name} (${r.score})`).join(', ')}` : 'Рейтинг: пока нет данных',
  ]
  if (publicUrl) lines.push(`Админка: ${publicUrl}`)
  return lines.join('\n')
}
