import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'

describe('auth api', () => {
  it('refuses to send a code when the owner is not linked', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'owner_not_linked' })
  })

  it('sends a code to the owner and logs in with it', async () => {
    const { app, db, sent } = await buildTestApp()
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    const req = await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    expect(req.statusCode).toBe(204)
    expect(sent).toHaveLength(1)
    const code = sent[0]!.match(/\d{6}/)![0]

    const bad = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: '000000' } })
    expect(bad.statusCode).toBe(401)

    const ok = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code } })
    expect(ok.statusCode).toBe(204)
    const cookie = ok.cookies[0]!
    expect(cookie.name).toBe('session')
    expect(cookie.httpOnly).toBe(true)

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    expect(me.statusCode).toBe(200)

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    expect(out.statusCode).toBe(204)
    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    })
    expect(after.statusCode).toBe(401)
  })

  it('returns 429 while locked', async () => {
    const { app, db } = await buildTestApp()
    setSetting(db, OWNER_TELEGRAM_ID, '42')
    await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: '000000' } })
    }
    const locked = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: '000000' } })
    expect(locked.statusCode).toBe(429)
    const req = await app.inject({ method: 'POST', url: '/api/auth/request-code' })
    expect(req.statusCode).toBe(429)
  })

  it('validates the body', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { code: 12 } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('validation')
  })

  it('protects api routes', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/positions' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects logout without a session', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' })
    expect(res.statusCode).toBe(401)
  })
})
