import type { Db } from './connect.js'

export const OWNER_TELEGRAM_ID = 'owner_telegram_id'

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('select value from settings where key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
  ).run(key, value)
}
