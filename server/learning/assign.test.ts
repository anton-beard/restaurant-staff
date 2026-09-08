import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { linkTelegram, updateEmployee } from '../db/employees.js'
import { publishCourse } from '../db/courses.js'
import { listCourseAssignments, listQuizAssignments } from '../db/learningAssignments.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { assignCourse, courseDueAt, eligibleForCourse, issueQuiz } from './assign.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
const deps = () => ({ db, notifier: fakeNotifier(log), tz: 'Europe/Moscow' })

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  log = []
})

describe('assignCourse', () => {
  it('assigns to all active employees of the positions when onlyNew is false', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const published = publishCourse(db, course.id, true, NOW.toISOString())!
    expect(await assignCourse(deps(), published, NOW, false)).toBe(2)
    expect(listCourseAssignments(db, {}).map((a) => a.employee_name).sort()).toEqual(['Анна Смирнова', 'Иван Петров'])
    expect(listCourseAssignments(db, {})[0]?.due_at).toBe(courseDueAt(NOW, 7))
    expect(log.map((n) => n.to).sort()).toEqual([500, 501])
    expect(log[0]!.text).toContain('Новый курс')
    expect(await assignCourse(deps(), published, NOW, false)).toBe(0)
  })

  it('onlyNew skips employees linked before publication and picks up newcomers and position changes', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    // Иван и Анна привязались до публикации (linked_at = now в фикстуре, публикация позже)
    const published = publishCourse(db, course.id, false, new Date(Date.now() + 60_000).toISOString())!
    expect(eligibleForCourse(db, published, true)).toEqual([])
    // Пётр переводится в бариста после публикации
    db.prepare("update employees set position_changed_at = '2099-01-01T00:00:00.000Z' where id = ?").run(seed.employees.petr.id)
    updateEmployee(db, seed.employees.petr.id, { position_id: seed.positions.barista.id })
    db.prepare("update employees set position_changed_at = '2099-01-01T00:00:00.000Z' where id = ?").run(seed.employees.petr.id)
    // Ольга становится бариста и привязывается позже публикации
    updateEmployee(db, seed.employees.olga.id, { position_id: seed.positions.barista.id })
    linkTelegram(db, seed.employees.olga.id, 503)
    db.prepare("update employees set linked_at = '2099-01-01T00:00:00.000Z' where id = ?").run(seed.employees.olga.id)
    expect(eligibleForCourse(db, published, true).map((e) => e.full_name).sort()).toEqual(['Ольга Новикова', 'Пётр Кузнецов'])
    expect(await assignCourse(deps(), published, NOW, true)).toBe(2)
  })
})

describe('issueQuiz', () => {
  it('creates one assignment per employee of the quiz positions with the deadline', async () => {
    const quiz = seedQuiz(db, [seed.positions.cook.id])
    const slot = new Date('2026-09-07T07:00:00.000Z')
    expect(await issueQuiz(deps(), quiz, slot, NOW)).toBe(1)
    const rows = listQuizAssignments(db, {})
    expect(rows[0]).toMatchObject({ employee_name: 'Пётр Кузнецов', slot_at: slot.toISOString(), due_at: '2026-09-07T15:00:00.000Z', status: 'pending' })
    expect(log[0]).toMatchObject({ to: 502, text: expect.stringContaining('Новый тест') })
    expect(await issueQuiz(deps(), quiz, slot, NOW)).toBe(0)
  })
})
