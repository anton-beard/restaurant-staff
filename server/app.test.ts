import { describe, expect, it } from 'vitest'
import { buildTestApp } from './test/buildTestApp.js'

describe('app', () => {
  it('answers /healthz', async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
