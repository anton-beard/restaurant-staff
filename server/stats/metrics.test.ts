import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createAttempt, createQuizAssignment, finishAttempt, abandonAttempt } from '../db/learningAssignments.js'
import { archiveEmployee } from '../db/employees.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedQuiz } from '../test/learning.js'
import { computeScore, employeeMetrics, periodDaysBack, quizMetrics, rating, taskMetrics } from './metrics.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
const P = periodDaysBack(NOW, 30)
let db: Db
let seed: ReturnType<typeof seedRestaurant>
let templateId: number

function instance(employeeId: number, due: string, status: 'accepted' | 'overdue' | 'pending', completed?: string) {
  const i = createInstance(db, { template_id: templateId, employee_id: employeeId, slot_at: due, issued_at: due, due_at: due, status: 'pending' })!
  if (status !== 'pending') setInstanceStatus(db, i.id, status, { completed_at: completed ?? null })
  return i
}

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
  templateId = createTaskTemplate(db, {
    title: 'Убрать стулья', description: '', requires_photo: false, photo_criteria: null, auto_accept_threshold: 80,
    assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
  }, null).id
})

describe('periodDaysBack', () => {
  it('spans exactly N days ending now', () => {
    expect(periodDaysBack(NOW, 7)).toEqual({ from: '2026-08-31T10:00:00.000Z', to: NOW.toISOString() })
  })
})

describe('taskMetrics', () => {
  it('counts on time, late and overdue by due_at within the period, ignoring unresolved', () => {
    const ivan = seed.employees.ivan.id
    instance(ivan, '2026-09-01T12:00:00.000Z', 'accepted', '2026-09-01T11:00:00.000Z')
    instance(ivan, '2026-09-02T12:00:00.000Z', 'accepted', '2026-09-02T13:00:00.000Z')
    instance(ivan, '2026-09-03T12:00:00.000Z', 'overdue')
    instance(ivan, '2026-09-04T12:00:00.000Z', 'pending')
    instance(ivan, '2026-07-01T12:00:00.000Z', 'accepted', '2026-07-01T11:00:00.000Z')
    instance(seed.employees.anna.id, '2026-09-05T12:00:00.000Z', 'accepted', '2026-09-05T11:00:00.000Z')
    expect(taskMetrics(db, ivan, P)).toEqual({ total: 3, onTime: 1, late: 1, overdue: 1, onTimeShare: 1 / 3 })
    expect(taskMetrics(db, null, P)).toMatchObject({ total: 4, onTime: 2 })
    expect(taskMetrics(db, seed.employees.petr.id, P)).toEqual({ total: 0, onTime: 0, late: 0, overdue: 0, onTimeShare: null })
  })
})

describe('quizMetrics', () => {
  it('uses the last finished attempt per assignment and ignores abandoned ones', () => {
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const ivan = seed.employees.ivan.id
    const a1 = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: ivan, course_assignment_id: null, slot_at: '2026-09-01T07:00:00.000Z', assigned_at: '2026-09-01T07:00:00.000Z', due_at: '2026-09-01T15:00:00.000Z' })!
    const t1 = createAttempt(db, a1.id, '2026-09-01T08:00:00.000Z')
    finishAttempt(db, t1.id, 50, false, '2026-09-01T08:10:00.000Z')
    const t2 = createAttempt(db, a1.id, '2026-09-01T09:00:00.000Z')
    finishAttempt(db, t2.id, 100, true, '2026-09-01T09:10:00.000Z')
    const a2 = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: ivan, course_assignment_id: null, slot_at: '2026-09-02T07:00:00.000Z', assigned_at: '2026-09-02T07:00:00.000Z', due_at: '2026-09-02T15:00:00.000Z' })!
    const t3 = createAttempt(db, a2.id, '2026-09-02T08:00:00.000Z')
    finishAttempt(db, t3.id, 60, false, '2026-09-02T08:10:00.000Z')
    const t4 = createAttempt(db, a2.id, '2026-09-02T09:00:00.000Z')
    abandonAttempt(db, t4.id, '2026-09-02T09:05:00.000Z')
    expect(quizMetrics(db, ivan, P)).toEqual({ attempts: 2, avgScore: 80, passed: 1, failed: 1 })
    expect(quizMetrics(db, seed.employees.anna.id, P)).toEqual({ attempts: 0, avgScore: null, passed: 0, failed: 0 })
    expect(quizMetrics(db, null, P).attempts).toBe(2)
  })
})

describe('computeScore', () => {
  it('weights 60/40, falls back to one component, null without data', () => {
    expect(computeScore(0.5, 90)).toBe(66)
    expect(computeScore(1, null)).toBe(100)
    expect(computeScore(null, 70)).toBe(70)
    expect(computeScore(null, null)).toBeNull()
  })
})

describe('rating', () => {
  it('ranks active employees, shares places on ties, puts no-data last', () => {
    const { ivan, anna, petr, olga } = seed.employees
    instance(ivan.id, '2026-09-01T12:00:00.000Z', 'accepted', '2026-09-01T11:00:00.000Z')
    instance(anna.id, '2026-09-01T12:00:00.000Z', 'accepted', '2026-09-01T11:00:00.000Z')
    instance(petr.id, '2026-09-01T12:00:00.000Z', 'overdue')
    archiveEmployee(db, olga.id)
    const rows = rating(db, P)
    expect(rows.map((r) => [r.full_name, r.score, r.place])).toEqual([
      ['Анна Смирнова', 100, 1],
      ['Иван Петров', 100, 1],
      ['Пётр Кузнецов', 0, 3],
    ])
    expect(rows[0]).toMatchObject({ position_name: 'Бариста', tasks: { total: 1, onTime: 1 } })
    const m = employeeMetrics(db, petr.id, P)
    expect(m).toMatchObject({ score: 0, tasks: { overdue: 1 }, quiz: { attempts: 0 } })
  })

  it('lists employees without data at the end without a place', () => {
    const rows = rating(db, P)
    expect(rows.every((r) => r.score === null && r.place === null)).toBe(true)
    expect(rows.map((r) => r.full_name)).toEqual(['Анна Смирнова', 'Иван Петров', 'Пётр Кузнецов'])
  })
})
