import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { openDb } from './db/connect.js'
import { createOwnerAuth } from './auth/ownerAuth.js'
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

describe('admin static', () => {
  it('serves index.html for SPA routes and 404 JSON for unknown api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'admin-'))
    try {
      writeFileSync(join(dir, 'index.html'), '<h1>admin</h1>')
      const db = openDb(':memory:')
      const app = buildApp({
        config: loadConfig({ BOT_TOKEN: 't', OWNER_PHONE: '+79990000000', SESSION_SECRET: 'sixteen-characters!' }),
        db,
        auth: createOwnerAuth(db),
        sendToOwner: async () => true,
        adminDistDir: dir,
      })
      const root = await app.inject({ method: 'GET', url: '/' })
      expect(root.statusCode).toBe(200)
      expect(root.body).toContain('admin')
      const deep = await app.inject({ method: 'GET', url: '/employees' })
      expect(deep.statusCode).toBe(200)
      expect(deep.body).toContain('admin')
      const api = await app.inject({ method: 'GET', url: '/api/nope' })
      expect(api.statusCode).toBe(404)
      await app.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
