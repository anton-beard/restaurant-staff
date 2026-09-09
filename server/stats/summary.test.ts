import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/connect.js'
import { createInstance, setInstanceStatus } from '../db/taskInstances.js'
import { createTaskTemplate } from '../db/taskTemplates.js'
import { createSubmission, saveAiResult } from '../db/taskSubmissions.js'
import { createCourseAssignment, setCourseAssignmentStatus } from '../db/learningAssignments.js'
import { seedRestaurant } from '../test/fixtures.js'
import { seedCourse } from '../test/learning.js'
import { summary } from './summary.js'

// понедельник 7 сентября, 13:00 по Москве
const NOW = new Date('2026-09-07T10:00:00.000Z')
let db: Db
let seed: ReturnType<typeof seedRestaurant>

beforeEach(() => {
  db = openDb(':memory:')
  seed = seedRestaurant(db)
})

describe('summary', () => {
  it('splits today (local midnight) from the week and counts queues and learning', () => {
    const t = createTaskTemplate(db, {
      title: 'Кофемашина', description: '', requires_photo: true, photo_criteria: 'Чисто', auto_accept_threshold: 80,
      assignee_mode: 'by_position', distribution: 'each', schedule: null, deadline_minutes: 60, position_ids: [seed.positions.barista.id], employee_ids: [],
    }, null)
    const mk = (employeeId: number, issued: string, due: string) =>
      createInstance(db, { template_id: t.id, employee_id: employeeId, slot_at: issued, issued_at: issued, due_at: due, status: 'pending' })!
    // сегодня по Москве началось в 21:00Z 6 сентября
    const todayOk = mk(seed.employees.ivan.id, '2026-09-06T22:00:00.000Z', '2026-09-07T01:00:00.000Z')
    setInstanceStatus(db, todayOk.id, 'accepted', { completed_at: '2026-09-07T00:30:00.000Z' })
    const yesterdayLate = mk(seed.employees.anna.id, '2026-09-06T10:00:00.000Z', '2026-09-06T12:00:00.000Z')
    setInstanceStatus(db, yesterdayLate.id, 'overdue')
    const waiting = mk(seed.employees.ivan.id, '2026-09-07T08:00:00.000Z', '2026-09-07T12:00:00.000Z')
    setInstanceStatus(db, waiting.id, 'submitted')
    createSubmission(db, waiting.id, '2026-09-07T09:00:00.000Z', [{ path: 'a.jpg', fileUniqueId: 'u1' }])
    const review = mk(seed.employees.petr.id, '2026-09-07T08:00:00.000Z', '2026-09-07T12:00:00.000Z')
    setInstanceStatus(db, review.id, 'review')
    const s = createSubmission(db, review.id, '2026-09-07T09:00:00.000Z', [{ path: 'b.jpg', fileUniqueId: 'u2' }])
    saveAiResult(db, s.id, { score: 40, verdict: 'x', issues: [] }, 'needs_review', '2026-09-07T09:01:00.000Z')
    const { course } = seedCourse(db, [seed.positions.barista.id])
    createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.ivan.id, assigned_at: '2026-09-01T10:00:00.000Z', due_at: '2026-09-10T10:00:00.000Z' })
    const late = createCourseAssignment(db, { course_id: course.id, employee_id: seed.employees.anna.id, assigned_at: '2026-08-20T10:00:00.000Z', due_at: '2026-09-01T10:00:00.000Z' })!
    setCourseAssignmentStatus(db, late.id, 'overdue')

    const r = summary(db, NOW, 'Europe/Moscow')
    expect(r.today).toMatchObject({ issued: 3, onTime: 1, late: 0, overdue: 0 })
    expect(r.week).toMatchObject({ issued: 4, onTime: 1, overdue: 1 })
    expect(r.queue).toEqual({ awaitingAi: 1, awaitingOwner: 1 })
    expect(r.learning).toEqual({ coursesInProgress: 1, coursesOverdue: 1 })
  })
})
