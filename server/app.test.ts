import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig({
  BOT_TOKEN: 't',
  OWNER_PHONE: '+79990000000',
  SESSION_SECRET: 'sixteen-characters!',
})

describe('app', () => {
  it('answers /healthz', async () => {
    const app = buildApp({ config })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
