import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { Db } from '../db/connect.js'

export const CODE_TTL_MS = 5 * 60_000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
const ATTEMPT_WINDOW_MS = 10 * 60_000
const MAX_ATTEMPTS = 5
const LOCK_MS = 15 * 60_000

export type OwnerAuth = {
  createLoginCode(): string | 'locked'
  verifyLoginCode(code: string): { token: string } | { error: 'invalid' | 'locked' }
  hasSession(token: string | undefined): boolean
  deleteSession(token: string): void
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function createOwnerAuth(db: Db, now: () => number = Date.now): OwnerAuth {
  let failures: number[] = []
  let lockedUntil = 0

  function isLocked(): boolean {
    return now() < lockedUntil
  }

  function registerFailure(): void {
    const t = now()
    failures = failures.filter((f) => t - f < ATTEMPT_WINDOW_MS)
    failures.push(t)
    if (failures.length >= MAX_ATTEMPTS) {
      lockedUntil = t + LOCK_MS
      failures = []
    }
  }

  return {
    createLoginCode() {
      if (isLocked()) return 'locked'
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
      db.prepare('delete from owner_login_codes').run()
      db.prepare('insert into owner_login_codes (code_hash, expires_at) values (?, ?)').run(
        sha256(code),
        now() + CODE_TTL_MS,
      )
      return code
    },

    verifyLoginCode(code) {
      if (isLocked()) return { error: 'locked' }
      const row = db
        .prepare('select id from owner_login_codes where code_hash = ? and used = 0 and expires_at > ?')
        .get(sha256(code), now()) as { id: number } | undefined
      if (!row) {
        registerFailure()
        return { error: 'invalid' }
      }
      db.prepare('update owner_login_codes set used = 1 where id = ?').run(row.id)
      failures = []
      const token = randomBytes(32).toString('hex')
      db.prepare('insert into owner_sessions (token_hash, expires_at) values (?, ?)').run(
        sha256(token),
        now() + SESSION_TTL_MS,
      )
      return { token }
    },

    hasSession(token) {
      if (!token) return false
      const row = db
        .prepare('select 1 from owner_sessions where token_hash = ? and expires_at > ?')
        .get(sha256(token), now())
      return row !== undefined
    },

    deleteSession(token) {
      db.prepare('delete from owner_sessions where token_hash = ?').run(sha256(token))
    },
  }
}
