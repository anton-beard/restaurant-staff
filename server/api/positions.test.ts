import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'

describe('positions api', () => {
  it('crud', async () => {
    const { app, loginAsOwner } = await buildTestApp()
    const cookie = await loginAsOwner()
    const h = { cookie }

    const created = await app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Официант' } })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toEqual({ id: 1, name: 'Официант' })

    const dup = await app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Официант' } })
    expect(dup.statusCode).toBe(409)

    const list = await app.inject({ method: 'GET', url: '/api/positions', headers: h })
    expect(list.json()).toHaveLength(1)

    const renamed = await app.inject({ method: 'PATCH', url: '/api/positions/1', headers: h, payload: { name: 'Бармен' } })
    expect(renamed.json()).toEqual({ id: 1, name: 'Бармен' })

    const missing = await app.inject({ method: 'PATCH', url: '/api/positions/9', headers: h, payload: { name: 'X' } })
    expect(missing.statusCode).toBe(404)

    const del = await app.inject({ method: 'DELETE', url: '/api/positions/1', headers: h })
    expect(del.statusCode).toBe(204)
  })

  it('refuses to delete a position in use', async () => {
    const { app, loginAsOwner } = await buildTestApp()
    const cookie = await loginAsOwner()
    const h = { cookie }
    await app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Повар' } })
    await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'А', phone: '+79990000001', position_id: 1 },
    })
    const del = await app.inject({ method: 'DELETE', url: '/api/positions/1', headers: h })
    expect(del.statusCode).toBe(409)
    expect(del.json()).toEqual({ error: 'in_use' })
  })
})
