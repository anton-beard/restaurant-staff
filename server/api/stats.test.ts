import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'

async function setup() {
  const t = await buildTestApp()
  const seed = seedRestaurant(t.db)
  const cookie = await t.loginAsOwner()
  const tpl = createTaskTemplate(t.db, {
    title: 'Кофемашина', description: '', requires_photo: false, photo_criteria: null, auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null)
  const due = new Date(Date.now() - 60 * 60_000).toISOString()
  const i = createInstance(t.db, { template_id: tpl.id, employee_id: seed.employees.ivan.id, slot_at: due, issued_at: due, due_at: due, status: 'pending' })!
  setInstanceStatus(t.db, i.id, 'accepted', { completed_at: due })
  return { ...t, seed, h: { cookie } }
}

describe('stats api', () => {
  it('serves summary, rating and the employee card', async () => {
    const { app, seed, h } = await setup()
    const s = await app.inject({ method: 'GET', url: '/api/stats/summary', headers: h })
    expect(s.statusCode).toBe(200)
    expect(s.json().week).toMatchObject({ issued: 1, onTime: 1 })
    expect(s.json().queue).toEqual({ awaitingAi: 0, awaitingOwner: 0 })

    const r = await app.inject({ method: 'GET', url: '/api/stats/rating?days=7', headers: h })
    expect(r.json()[0]).toMatchObject({ full_name: 'Иван Петров', score: 100, place: 1 })
    expect((await app.inject({ method: 'GET', url: '/api/stats/rating?days=5', headers: h })).statusCode).toBe(400)

    const c = await app.inject({ method: 'GET', url: `/api/stats/employees/${seed.employees.ivan.id}?days=30`, headers: h })
    expect(c.json()).toMatchObject({ position_name: 'Бариста', metrics: { score: 100 } })
    expect(c.json().tasks).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: '/api/stats/employees/999', headers: h })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/stats/summary' })).statusCode).toBe(401)
  })

  it('reads and writes the digest time', async () => {
    const { app, h } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/settings/digest', headers: h })).json()).toEqual({ time: '09:00' })
    const put = await app.inject({ method: 'PUT', url: '/api/settings/digest', headers: h, payload: { time: '08:30' } })
    expect(put.json()).toEqual({ time: '08:30' })
    expect((await app.inject({ method: 'GET', url: '/api/settings/digest', headers: h })).json()).toEqual({ time: '08:30' })
    expect((await app.inject({ method: 'PUT', url: '/api/settings/digest', headers: h, payload: { time: '25:00' } })).statusCode).toBe(400)
  })
})
