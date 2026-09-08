import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { createInstance } from '../db/taskInstances.js'
import { createSubmission, saveAiResult } from '../db/taskSubmissions.js'

async function setup() {
  const t = await buildTestApp()
  const seed = seedRestaurant(t.db)
  const cookie = await t.loginAsOwner()
  return { ...t, seed, h: { cookie } }
}

const weeklyBody = (seed: ReturnType<typeof seedRestaurant>) => ({
  title: 'Помыть кофемашину',
  description: 'Группы, холдеры, поддон',
  requires_photo: true,
  photo_criteria: 'Группы чистые, поддон пустой',
  auto_accept_threshold: 80,
  assignee_mode: 'by_position',
  distribution: 'each',
  position_ids: [seed.positions.barista.id],
  employee_ids: [],
  schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['22:00'] },
  deadline_minutes: 60,
})

describe('task templates api', () => {
  it('creates a weekly template with next_run_at and lists it', async () => {
    const { app, seed, h } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: weeklyBody(seed) })
    expect(res.statusCode).toBe(201)
    const { template, issued } = res.json()
    expect(template).toMatchObject({ id: 1, active: true, position_ids: [seed.positions.barista.id] })
    expect(template.next_run_at).toMatch(/T19:00:00\.000Z$/)
    expect(issued).toBeNull()
    const list = await app.inject({ method: 'GET', url: '/api/tasks/templates', headers: h })
    expect(list.json()).toHaveLength(1)
  })

  it('validates criteria, assignees and schedule', async () => {
    const { app, seed, h } = await setup()
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload })
    expect((await post({ ...weeklyBody(seed), photo_criteria: '' })).statusCode).toBe(400)
    expect((await post({ ...weeklyBody(seed), position_ids: [] })).statusCode).toBe(400)
    expect((await post({ ...weeklyBody(seed), schedule: { kind: 'weekly', days: [], times: ['10:00'] } })).statusCode).toBe(400)
    expect((await post({ ...weeklyBody(seed), deadline_minutes: 1 })).statusCode).toBe(400)
    const ok = await post({ ...weeklyBody(seed), requires_photo: false, photo_criteria: null })
    expect(ok.statusCode).toBe(201)
  })

  it('a one-off template is issued immediately and shows up in the journal', async () => {
    const { app, seed, h, notifications } = await setup()
    const res = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: { ...weeklyBody(seed), schedule: null } })
    expect(res.statusCode).toBe(201)
    expect(res.json().issued).toEqual({ created: 2, notified: 2 })
    expect(res.json().template.next_run_at).toBeNull()
    expect(notifications.filter((n) => typeof n.to === 'number')).toHaveLength(2)

    const list = await app.inject({ method: 'GET', url: '/api/tasks/instances?status=pending', headers: h })
    expect(list.json()).toHaveLength(2)
    expect(list.json()[0]).toMatchObject({ title: 'Помыть кофемашину', status: 'pending' })
    const one = await app.inject({ method: 'GET', url: `/api/tasks/instances/${list.json()[0].id}`, headers: h })
    expect(one.json()).toMatchObject({ instance: { status: 'pending' }, submissions: [] })
    const byEmployee = await app.inject({ method: 'GET', url: `/api/tasks/instances?employee_id=${seed.employees.petr.id}`, headers: h })
    expect(byEmployee.json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/api/tasks/instances/999', headers: h })).statusCode).toBe(404)
  })

  it('updates, deactivates and reactivates', async () => {
    const { app, seed, h } = await setup()
    await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: weeklyBody(seed) })
    const upd = await app.inject({ method: 'PATCH', url: '/api/tasks/templates/1', headers: h, payload: { ...weeklyBody(seed), title: 'Кофемашина', distribution: 'shared' } })
    expect(upd.json()).toMatchObject({ title: 'Кофемашина', distribution: 'shared' })
    const off = await app.inject({ method: 'POST', url: '/api/tasks/templates/1/deactivate', headers: h })
    expect(off.json()).toMatchObject({ active: false, next_run_at: null })
    expect((await app.inject({ method: 'GET', url: '/api/tasks/templates', headers: h })).json()).toEqual([])
    const on = await app.inject({ method: 'POST', url: '/api/tasks/templates/1/activate', headers: h })
    expect(on.json().active).toBe(true)
    expect(on.json().next_run_at).toMatch(/Z$/)
    expect((await app.inject({ method: 'PATCH', url: '/api/tasks/templates/9', headers: h, payload: weeklyBody(seed) })).statusCode).toBe(404)
  })

  it('requires a session', async () => {
    const { app } = await setup()
    expect((await app.inject({ method: 'GET', url: '/api/tasks/templates' })).statusCode).toBe(401)
  })
})

describe('review queue api', () => {
  it('lists the queue and applies decisions once', async () => {
    const { app, seed, h, db, notifications } = await setup()
    const create = await app.inject({ method: 'POST', url: '/api/tasks/templates', headers: h, payload: weeklyBody(seed) })
    const templateId = create.json().template.id
    const inst = createInstance(db, { template_id: templateId, employee_id: seed.employees.ivan.id, slot_at: '2026-09-07T19:00:00.000Z', issued_at: '2026-09-07T19:00:00.000Z', due_at: '2026-09-07T20:00:00.000Z', status: 'review' })!
    const sub = createSubmission(db, inst.id, '2026-09-07T19:10:00.000Z', [{ path: '1/a.jpg', fileUniqueId: 'u1' }])
    saveAiResult(db, sub.id, { score: 45, verdict: 'Грязно', issues: ['поддон'] }, 'needs_review', '2026-09-07T19:11:00.000Z')

    const queue = await app.inject({ method: 'GET', url: '/api/tasks/review-queue', headers: h })
    expect(queue.json()).toHaveLength(1)
    expect(queue.json()[0]).toMatchObject({ id: sub.id, title: 'Помыть кофемашину', employee_name: 'Иван Петров', ai_score: 45 })
    expect(queue.json()[0].photos[0].path).toBe('1/a.jpg')

    const bad = await app.inject({ method: 'POST', url: `/api/tasks/submissions/${sub.id}/decide`, headers: h, payload: { decision: 'reject' } })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({ method: 'POST', url: `/api/tasks/submissions/${sub.id}/decide`, headers: h, payload: { decision: 'reject', comment: 'Поддон' } })
    expect(ok.statusCode).toBe(200)
    expect(notifications.some((n) => n.to === 500 && n.text.includes('Поддон'))).toBe(true)
    const again = await app.inject({ method: 'POST', url: `/api/tasks/submissions/${sub.id}/decide`, headers: h, payload: { decision: 'accept' } })
    expect(again.statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/tasks/submissions/999/decide', headers: h, payload: { decision: 'accept' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/tasks/review-queue', headers: h })).json()).toEqual([])
  })
})

describe('uploads', () => {
  it('serves files only with a session', async () => {
    const { app, h, uploadsDir } = await setup()
    mkdirSync(join(uploadsDir, '7'), { recursive: true })
    writeFileSync(join(uploadsDir, '7', 'a.jpg'), 'jpegdata')
    const ok = await app.inject({ method: 'GET', url: '/api/uploads/7/a.jpg', headers: h })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toBe('jpegdata')
    expect((await app.inject({ method: 'GET', url: '/api/uploads/7/a.jpg' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/uploads/7/missing.jpg', headers: h })).statusCode).toBe(404)
  })
})
