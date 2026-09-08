import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'

async function setup() {
  const t = await buildTestApp()
  const seed = seedRestaurant(t.db)
  const cookie = await t.loginAsOwner()
  return { ...t, seed, h: { cookie } }
}

const courseBody = (positionIds: number[]) => ({
  title: 'Эспрессо по стандарту', description: 'Базовый курс', due_days: 7, pass_score: 80, position_ids: positionIds,
  lessons: [
    { title: 'Помол', body: '18 г', media: [] },
    { title: 'Экстракция', body: '25–30 с', media: [{ kind: 'image', path: 'lessons/2026-09/0123456789abcdef.jpg' }, { kind: 'video', url: 'https://youtu.be/x' }] },
  ],
  questions: [{ text: 'Сколько секунд?', options: ['10', '25–30'], correct_index: 1 }],
})

describe('courses api', () => {
  it('creates, reads, updates, publishes and archives a course', async () => {
    const { app, seed, h, notifications } = await setup()
    const created = await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: courseBody([seed.positions.barista.id]) })
    expect(created.statusCode).toBe(201)
    expect(created.json().course).toMatchObject({ status: 'draft', lesson_count: 2 })
    expect(created.json().lessons).toHaveLength(2)
    expect(created.json().quiz).toMatchObject({ course_id: created.json().course.id, question_count: 1 })
    const id = created.json().course.id

    const read = await app.inject({ method: 'GET', url: `/api/learning/courses/${id}`, headers: h })
    expect(read.json().questions[0]).toMatchObject({ text: 'Сколько секунд?', correct_index: 1 })

    const upd = await app.inject({ method: 'PATCH', url: `/api/learning/courses/${id}`, headers: h, payload: { ...courseBody([seed.positions.barista.id]), title: 'Эспрессо', questions: [] } })
    expect(upd.json().course.title).toBe('Эспрессо')
    const incomplete = await app.inject({ method: 'POST', url: `/api/learning/courses/${id}/publish`, headers: h, payload: { assign_existing: true } })
    expect(incomplete.statusCode).toBe(409)
    expect(incomplete.json().issues.join(' ')).toMatch(/вопрос/i)

    await app.inject({ method: 'PATCH', url: `/api/learning/courses/${id}`, headers: h, payload: courseBody([seed.positions.barista.id]) })
    const published = await app.inject({ method: 'POST', url: `/api/learning/courses/${id}/publish`, headers: h, payload: { assign_existing: true } })
    expect(published.statusCode).toBe(200)
    expect(published.json()).toMatchObject({ course: { status: 'published', assign_existing: true }, assigned: 2 })
    expect(notifications.filter((n) => typeof n.to === 'number' && /Новый курс/.test(n.text))).toHaveLength(2)

    const list = await app.inject({ method: 'GET', url: '/api/learning/assignments/courses?status=in_progress', headers: h })
    expect(list.json()).toHaveLength(2)
    const archived = await app.inject({ method: 'POST', url: `/api/learning/courses/${id}/archive`, headers: h })
    expect(archived.json().status).toBe('archived')
    expect((await app.inject({ method: 'GET', url: '/api/learning/courses', headers: h })).json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/api/learning/courses?includeArchived=1', headers: h })).json()).toHaveLength(1)
  })

  it('validates the body', async () => {
    const { app, seed, h } = await setup()
    const bad = { ...courseBody([seed.positions.barista.id]), questions: [{ text: 'x', options: ['a'], correct_index: 0 }] }
    expect((await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: bad })).statusCode).toBe(400)
    const badIndex = { ...courseBody([seed.positions.barista.id]), questions: [{ text: 'x', options: ['a', 'b'], correct_index: 2 }] }
    expect((await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: badIndex })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/learning/courses' })).statusCode).toBe(401)

    const traversal = { ...courseBody([seed.positions.barista.id]), lessons: [{ title: 'x', body: '', media: [{ kind: 'image', path: '../../etc/passwd' }] }] }
    expect((await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: traversal })).statusCode).toBe(400)
    const validPath = { ...courseBody([seed.positions.barista.id]), lessons: [{ title: 'x', body: '', media: [{ kind: 'image', path: 'lessons/2026-09/0123456789abcdef.jpg' }] }] }
    expect((await app.inject({ method: 'POST', url: '/api/learning/courses', headers: h, payload: validPath })).statusCode).toBe(201)
  })
})

describe('quizzes api', () => {
  it('creates a scheduled quiz, publishes it with next_run_at and issues it now', async () => {
    const { app, seed, h, notifications } = await setup()
    const body = {
      title: 'Меню недели', pass_score: 80, position_ids: [seed.positions.barista.id],
      schedule: { kind: 'weekly', days: [1], times: ['10:00'] }, deadline_minutes: 480,
      questions: [{ text: 'Цена капучино?', options: ['250', '300'], correct_index: 1 }],
    }
    const created = await app.inject({ method: 'POST', url: '/api/learning/quizzes', headers: h, payload: body })
    expect(created.statusCode).toBe(201)
    expect(created.json().quiz).toMatchObject({ status: 'draft', next_run_at: null, question_count: 1 })
    const id = created.json().quiz.id
    expect((await app.inject({ method: 'POST', url: `/api/learning/quizzes/${id}/issue`, headers: h })).statusCode).toBe(409)
    const published = await app.inject({ method: 'POST', url: `/api/learning/quizzes/${id}/publish`, headers: h })
    expect(published.json()).toMatchObject({ status: 'published' })
    expect(published.json().next_run_at).toMatch(/T07:00:00\.000Z$/)
    const issued = await app.inject({ method: 'POST', url: `/api/learning/quizzes/${id}/issue`, headers: h })
    expect(issued.json()).toEqual({ assigned: 2 })
    expect(notifications.filter((n) => /Новый тест/.test(n.text))).toHaveLength(2)
    const rows = await app.inject({ method: 'GET', url: `/api/learning/assignments/quizzes?quiz_id=${id}`, headers: h })
    expect(rows.json()).toHaveLength(2)
    const attempts = await app.inject({ method: 'GET', url: `/api/learning/assignments/quizzes/${rows.json()[0].id}/attempts`, headers: h })
    expect(attempts.json()).toEqual([])
    expect((await app.inject({ method: 'GET', url: '/api/learning/quizzes', headers: h })).json()).toHaveLength(1)
    const interval = { ...body, schedule: { kind: 'interval', days: [1], from: '10:00', to: '12:00', every_minutes: 60 } }
    expect((await app.inject({ method: 'POST', url: '/api/learning/quizzes', headers: h, payload: interval })).statusCode).toBe(400)
  })
})

describe('upload', () => {
  it('stores an image and rejects other types', async () => {
    const { app, h, uploadsDir } = await setup()
    const ok = await app.inject({ method: 'POST', url: '/api/learning/upload', headers: h, payload: { filename: 'a.jpg', mime: 'image/jpeg', data: Buffer.from('jpegdata').toString('base64') } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().path).toMatch(/^lessons\/\d{4}-\d{2}\/[a-f0-9]+\.jpg$/)
    expect(existsSync(join(uploadsDir, ok.json().path))).toBe(true)
    const served = await app.inject({ method: 'GET', url: `/api/uploads/${ok.json().path}`, headers: h })
    expect(served.body).toBe('jpegdata')
    const bad = await app.inject({ method: 'POST', url: '/api/learning/upload', headers: h, payload: { filename: 'a.gif', mime: 'image/gif', data: 'AAAA' } })
    expect(bad.statusCode).toBe(400)
  })
})
