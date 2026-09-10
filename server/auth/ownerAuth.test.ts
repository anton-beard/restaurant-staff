import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import {
  CODE_MAX_PER_HOUR,
  CODE_MIN_INTERVAL_MS,
  createOwnerAuth,
  type OwnerAuth,
} from './ownerAuth.js'

const MIN = 60_000
let db: Db
let clock: number
let auth: OwnerAuth

beforeEach(() => {
  db = openDb(':memory:')
  clock = 1_000_000_000_000
  auth = createOwnerAuth(db, () => clock)
})

describe('login code', () => {
  it('issues a 6-digit code that verifies once', () => {
    const code = auth.createLoginCode()
    expect(code).toMatch(/^\d{6}$/)
    const ok = auth.verifyLoginCode(code as string)
    expect(ok).toHaveProperty('token')
    expect(auth.verifyLoginCode(code as string)).toEqual({ error: 'invalid' })
  })

  it('expires after 5 minutes', () => {
    const code = auth.createLoginCode() as string
    clock += 5 * MIN + 1
    expect(auth.verifyLoginCode(code)).toEqual({ error: 'invalid' })
  })

  it('a new code invalidates the previous one', () => {
    const first = auth.createLoginCode() as string
    clock += 61_000
    const second = auth.createLoginCode() as string
    expect(auth.verifyLoginCode(first)).toEqual({ error: 'invalid' })
    expect(auth.verifyLoginCode(second)).toHaveProperty('token')
  })

  it('refuses a second code within 15 seconds', () => {
    expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
    expect(auth.createLoginCode()).toBe('locked')
    clock += CODE_MIN_INTERVAL_MS
    expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
  })

  it('allows 5 codes per hour and refuses the 6th', () => {
    for (let i = 0; i < CODE_MAX_PER_HOUR; i++) {
      expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
      clock += MIN + 1_000
    }
    expect(auth.createLoginCode()).toBe('locked')
    clock += 60 * MIN
    expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
  })

  it('a successful login does not reset the issuance history', () => {
    const code = auth.createLoginCode() as string
    expect(auth.verifyLoginCode(code)).toHaveProperty('token')
    expect(auth.createLoginCode()).toBe('locked')
  })

  it('locks for 15 minutes after 5 wrong attempts in 10 minutes', () => {
    auth.createLoginCode()
    for (let i = 0; i < 5; i++) expect(auth.verifyLoginCode('000000')).toEqual({ error: 'invalid' })
    expect(auth.verifyLoginCode('000000')).toEqual({ error: 'locked' })
    expect(auth.createLoginCode()).toBe('locked')
    clock += 15 * MIN + 1
    expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
  })

  it('wrong attempts older than 10 minutes do not count', () => {
    auth.createLoginCode()
    for (let i = 0; i < 4; i++) auth.verifyLoginCode('000000')
    clock += 10 * MIN + 1
    for (let i = 0; i < 4; i++) auth.verifyLoginCode('000000')
    expect(auth.createLoginCode()).toMatch(/^\d{6}$/)
  })
})

describe('sessions', () => {
  it('recognises a live session and forgets a deleted one', () => {
    const code = auth.createLoginCode() as string
    const { token } = auth.verifyLoginCode(code) as { token: string }
    expect(auth.hasSession(token)).toBe(true)
    expect(auth.hasSession(undefined)).toBe(false)
    expect(auth.hasSession('nope')).toBe(false)
    auth.deleteSession(token)
    expect(auth.hasSession(token)).toBe(false)
  })

  it('expires after 30 days', () => {
    const code = auth.createLoginCode() as string
    const { token } = auth.verifyLoginCode(code) as { token: string }
    clock += 30 * 24 * 60 * MIN + 1
    expect(auth.hasSession(token)).toBe(false)
  })
})
