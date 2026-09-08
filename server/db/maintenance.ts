import type { Db } from './connect.js'

export function purgeAuth(db: Db, nowMs: number): { sessions: number; codes: number } {
  const sessions = db.prepare('delete from owner_sessions where expires_at <= ?').run(nowMs).changes
  const codes = db.prepare('delete from owner_login_codes where used = 1 or expires_at <= ?').run(nowMs).changes
  return { sessions, codes }
}
