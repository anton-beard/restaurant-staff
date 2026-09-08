import type { Db } from '../db/connect.js'
import { findEmployeeByTelegramId, listEmployees, type Employee } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID } from '../db/settings.js'
import { countOverdueSince } from '../db/taskInstances.js'
import { listReviewQueue } from '../db/taskSubmissions.js'

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

export function summaryText(db: Db, publicUrl: string | undefined, now: Date): string {
  const all = listEmployees(db)
  const active = all.filter((e) => e.status === 'active').length
  const invited = all.filter((e) => e.status === 'invited').length
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
  const lines = [
    `Активны: ${active}`,
    `Приглашены: ${invited}`,
    `На проверке: ${listReviewQueue(db).length}`,
    `Просрочено за сутки: ${countOverdueSince(db, dayAgo)}`,
  ]
  if (publicUrl) lines.push(`Админка: ${publicUrl}`)
  return lines.join('\n')
}
