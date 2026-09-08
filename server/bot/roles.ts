import type { Db } from '../db/connect.js'
import { findEmployeeByTelegramId, listEmployees, type Employee } from '../db/employees.js'
import { getSetting, OWNER_TELEGRAM_ID } from '../db/settings.js'

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

export function summaryText(db: Db, publicUrl?: string): string {
  const all = listEmployees(db)
  const active = all.filter((e) => e.status === 'active').length
  const invited = all.filter((e) => e.status === 'invited').length
  const lines = [`Активны: ${active}`, `Приглашены: ${invited}`]
  if (publicUrl) lines.push(`Админка: ${publicUrl}`)
  return lines.join('\n')
}
