import type { Db } from './connect.js'

export function getState<T = unknown>(db: Db, telegramId: number): T | null {
  const row = db.prepare('select state from bot_states where telegram_id = ?').get(telegramId) as { state: string } | undefined
  return row ? (JSON.parse(row.state) as T) : null
}

export function setState(db: Db, telegramId: number, state: unknown): void {
  db.prepare(
    'insert into bot_states (telegram_id, state) values (?, ?) on conflict(telegram_id) do update set state = excluded.state',
  ).run(telegramId, JSON.stringify(state))
}

export function clearState(db: Db, telegramId: number): void {
  db.prepare('delete from bot_states where telegram_id = ?').run(telegramId)
}
