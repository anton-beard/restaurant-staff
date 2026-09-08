import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { OWNER_TELEGRAM_ID, setSetting } from '../db/settings.js'
import { publishCourse } from '../db/courses.js'
import { getQuiz, setQuizStatus } from '../db/quizzes.js'
import { createCourseAssignment, createQuizAssignment, getCourseAssignment, getQuizAssignment, listCourseAssignments, listQuizAssignments } from '../db/learningAssignments.js'
import { fakeNotifier, type Notification } from '../test/buildTestApp.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import type { SchedulerDeps } from './tick.js'
import { assignCourses, issueDueQuizzes, learningOverdue, learningReminders } from './learning.js'

const T = (iso: string) => new Date(iso)
let db: Db
let seed: ReturnType<typeof seedRestaurant>
let log: Notification[]
let deps: SchedulerDeps

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  setSetting(db, OWNER_TELEGRAM_ID, '42')
  log = []
  deps = { db, notifier: fakeNotifier(log), tz: 'Europe/Moscow', uploadsDir: '/tmp', reviewQueue: { enqueue: () => true, isActive: () => false } }
})

describe('assignCourses', () => {
  it('assigns published courses to eligible employees, honouring assign_existing', async () => {
    const { course: all } = seedCourse(db, [seed.positions.barista.id])
    const { course: onlyNew } = seedCourse(db, [seed.positions.cook.id], { title: 'Кухня' })
    publishCourse(db, all.id, true, '2026-09-07T09:00:00.000Z')
    publishCourse(db, onlyNew.id, false, '2099-01-01T00:00:00.000Z')
    expect(await assignCourses(deps, T('2026-09-07T10:00:00.000Z'))).toBe(2)
    expect(listCourseAssignments(db, { course_id: all.id })).toHaveLength(2)
    expect(listCourseAssignments(db, { course_id: onlyNew.id })).toHaveLength(0)
    expect(await assignCourses(deps, T('2026-09-07T10:01:00.000Z'))).toBe(0)
  })
})

describe('issueDueQuizzes', () => {
  it('issues a due quiz, advances next_run_at, skips old slots', async () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    setQuizStatus(db, quiz.id, 'published', '2026-09-07T07:00:00.000Z')
    expect(await issueDueQuizzes(deps, T('2026-09-07T07:00:30.000Z'))).toBe(2)
    expect(getQuiz(db, quiz.id)?.next_run_at).toBe('2026-09-14T07:00:00.000Z')
    expect(listQuizAssignments(db, {})[0]?.due_at).toBe('2026-09-07T15:00:00.000Z')
    const late = seedQuiz(db, [seed.positions.cook.id], { title: 'Поздний' })
    setQuizStatus(db, late.id, 'published', '2026-09-07T07:00:00.000Z')
    expect(await issueDueQuizzes(deps, T('2026-09-07T08:30:00.000Z'))).toBe(0)
    expect(getQuiz(db, late.id)?.next_run_at).toBe('2026-09-14T07:00:00.000Z')
  })
})

describe('learningReminders', () => {
  it('reminds about courses 24h before (long) or at half time (short), quizzes at half time, once', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-08T10:00:00.000Z' })
    createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.anna.id, assigned_at: '2026-09-07T00:00:00.000Z', due_at: '2026-09-08T00:00:00.000Z' })
    createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.ivan.id, course_assignment_id: null, slot_at: '2026-09-07T07:00:00.000Z', assigned_at: '2026-09-07T07:00:00.000Z', due_at: '2026-09-07T15:00:00.000Z' })
    expect(await learningReminders(deps, T('2026-09-07T09:00:00.000Z'))).toBe(0)
    expect(await learningReminders(deps, T('2026-09-07T11:30:00.000Z'))).toBe(2) // курс Ивана (24 ч) и тест (половина 8 ч)
    expect(await learningReminders(deps, T('2026-09-07T12:30:00.000Z'))).toBe(1) // курс Анны (половина суток)
    expect(await learningReminders(deps, T('2026-09-07T13:00:00.000Z'))).toBe(0)
    expect(log.filter((n) => /Напоминание/.test(n.text))).toHaveLength(3)
  })
})

describe('learningOverdue', () => {
  it('marks overdue course and quiz assignments and notifies both sides', async () => {
    const { course } = seedCourse(db, [seed.positions.barista.id])
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const ca = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-06T10:00:00.000Z' })!
    const qa = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: seed.employees.anna.id, course_assignment_id: null, slot_at: '2026-09-06T07:00:00.000Z', assigned_at: '2026-09-06T07:00:00.000Z', due_at: '2026-09-06T15:00:00.000Z' })!
    expect(await learningOverdue(deps, T('2026-09-07T10:00:00.000Z'))).toBe(2)
    expect(getCourseAssignment(db, ca.id)?.status).toBe('overdue')
    expect(getQuizAssignment(db, qa.id)?.status).toBe('overdue')
    expect(log.filter((n) => n.to === 'owner')).toHaveLength(2)
    expect(log.filter((n) => n.to === 500 || n.to === 501)).toHaveLength(2)
    expect(await learningOverdue(deps, T('2026-09-07T10:01:00.000Z'))).toBe(0)
  })
})
