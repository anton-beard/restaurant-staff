import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, saveAiResult } from '../db/taskSubmissions.js'
import { createAttempt, createCourseAssignment, createQuizAssignment, finishAttempt } from '../db/learningAssignments.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse, seedQuiz } from '../test/learning.js'
import { periodDaysBack } from './metrics.js'
import { employeeCard } from './employeeCard.js'

const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let seed: ReturnType<typeof seedRestaurant>

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('employeeCard', () => {
  it('returns metrics and history for the employee, null for unknown', () => {
    const ivan = seed.employees.ivan.id
    const t = createTaskTemplate(db, {
      title: 'Кофемашина', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
      assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
    }, null)
    const i = createInstance(db, { template_id: t.id, employee_id: ivan, slot_at: '2026-09-01T10:00:00.000Z', issued_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-01T11:00:00.000Z', status: 'pending' })!
    setInstanceStatus(db, i.id, 'accepted', { completed_at: '2026-09-01T10:30:00.000Z' })
    const s = createSubmission(db, i.id, '2026-09-01T10:20:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    saveAiResult(db, s.id, { score: 91, verdict: 'ok', issues: [] }, 'auto_accepted', '2026-09-01T10:30:00.000Z')
    const { course } = seedCourse(db, [seed.positions.barista.id])
    createCourseAssignment(db, { course_id: course.id, employee_id: ivan, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-08T10:00:00.000Z' })
    const quiz = seedQuiz(db, [seed.positions.barista.id])
    const qa = createQuizAssignment(db, { quiz_id: quiz.id, employee_id: ivan, course_assignment_id: null, slot_at: '2026-09-02T07:00:00.000Z', assigned_at: '2026-09-02T07:00:00.000Z', due_at: '2026-09-02T15:00:00.000Z' })!
    const a = createAttempt(db, qa.id, '2026-09-02T08:00:00.000Z')
    finishAttempt(db, a.id, 100, true, '2026-09-02T08:10:00.000Z')

    const card = employeeCard(db, ivan, periodDaysBack(NOW, 30))!
    expect(card.employee.full_name).toBe('Иван Петров')
    expect(card.position_name).toBe('Бариста')
    expect(card.metrics).toMatchObject({ score: 100, tasks: { onTime: 1 }, quiz: { avgScore: 100 } })
    expect(card.tasks).toEqual([{ id: i.id, title: 'Кофемашина', due_at: '2026-09-01T11:00:00.000Z', status: 'accepted', completed_at: '2026-09-01T10:30:00.000Z', last_score: 91 }])
    expect(card.courses[0]).toMatchObject({ title: 'Эспрессо по стандарту', current_lesson: 1 })
    expect(card.quizzes[0]).toMatchObject({ title: 'Меню недели' })
    expect(card.quizzes[0]!.attempts[0]).toMatchObject({ score: 100, passed: true })
    expect(employeeCard(db, 999, periodDaysBack(NOW, 30))).toBeNull()
  })
})
