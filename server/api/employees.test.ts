import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'

async function setup() {
  const t = await buildTestApp()
  const cookie = await t.loginAsOwner()
  const h = { cookie }
  await t.app.inject({ method: 'POST', url: '/api/positions', headers: h, payload: { name: 'Официант' } })
  return { ...t, h }
}

describe('employees api', () => {
  it('creates with a normalized phone', async () => {
    const { app, h } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: '8 (999) 000-00-01', position_id: 1 },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: 1, phone: '+79990000001', status: 'invited' })
  })

  it('rejects a bad phone and a duplicate phone', async () => {
    const { app, h } = await setup()
    const bad = await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: 'abc', position_id: 1 },
    })
    expect(bad.statusCode).toBe(400)
    const payload = { full_name: 'Иван', phone: '+79990000001', position_id: 1 }
    await app.inject({ method: 'POST', url: '/api/employees', headers: h, payload })
    const dup = await app.inject({ method: 'POST', url: '/api/employees', headers: h, payload })
    expect(dup.statusCode).toBe(409)
  })

  it('rejects an unknown position', async () => {
    const { app, h } = await setup()
    const res = await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: '+79990000001', position_id: 77 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_reference' })
  })

  it('unarchives an employee back to invited', async () => {
    const { app, h } = await setup()
    await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: '+79990000001', position_id: 1 },
    })
    const active = await app.inject({ method: 'POST', url: '/api/employees/1/unarchive', headers: h })
    expect(active.statusCode).toBe(404)

    await app.inject({ method: 'POST', url: '/api/employees/1/archive', headers: h })
    const back = await app.inject({ method: 'POST', url: '/api/employees/1/unarchive', headers: h })
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ status: 'invited', telegram_id: null })

    const missing = await app.inject({ method: 'POST', url: '/api/employees/9/unarchive', headers: h })
    expect(missing.statusCode).toBe(404)
  })

  it('lists, updates and archives', async () => {
    const { app, h } = await setup()
    await app.inject({
      method: 'POST',
      url: '/api/employees',
      headers: h,
      payload: { full_name: 'Иван', phone: '+79990000001', position_id: 1 },
    })
    const upd = await app.inject({ method: 'PATCH', url: '/api/employees/1', headers: h, payload: { full_name: 'Пётр' } })
    expect(upd.json().full_name).toBe('Пётр')

    const arch = await app.inject({ method: 'POST', url: '/api/employees/1/archive', headers: h })
    expect(arch.json().status).toBe('archived')

    const list = await app.inject({ method: 'GET', url: '/api/employees', headers: h })
    expect(list.json()).toEqual([])
    const all = await app.inject({ method: 'GET', url: '/api/employees?includeArchived=1', headers: h })
    expect(all.json()).toHaveLength(1)

    const missing = await app.inject({ method: 'PATCH', url: '/api/employees/9', headers: h, payload: { full_name: 'X' } })
    expect(missing.statusCode).toBe(404)
  })
})
