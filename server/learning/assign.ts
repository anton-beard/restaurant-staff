import type { Db } from '../db/connect.js'
import type { Employee } from '../db/employees.js'
import type { Course } from '../db/courses.js'
import type { Quiz } from '../db/quizzes.js'
import { createCourseAssignment, createQuizAssignment, type CourseAssignment } from '../db/learningAssignments.js'
import { formatLocal } from '../lib/time.js'
import type { Notifier } from '../notify.js'
import { continueCourseKeyboard, startQuizKeyboard } from '../bot/keyboards.js'

export type LearningDeps = { db: Db; notifier: Notifier; tz: string }

const employeeCols = 'e.id, e.full_name, e.phone, e.position_id, e.telegram_id, e.status, e.created_at, e.linked_at, e.position_changed_at'

export function courseDueAt(assignedAt: Date, dueDays: number): string {
  return new Date(assignedAt.getTime() + dueDays * 24 * 60 * 60_000).toISOString()
}

export function eligibleForCourse(db: Db, course: Course, onlyNew: boolean): Employee[] {
  const newcomers = onlyNew
    ? "and max(coalesce(e.linked_at, ''), e.position_changed_at) > ?"
    : ''
  const args: unknown[] = [course.id, course.id]
  if (onlyNew) args.push(course.published_at ?? '')
  return db
    .prepare(
      `select ${employeeCols} from employees e
       join course_positions cp on cp.position_id = e.position_id and cp.course_id = ?
       where e.status = 'active'
         and not exists (select 1 from course_assignments a where a.course_id = ? and a.employee_id = e.id)
         ${newcomers}
       order by e.full_name`,
    )
    .all(...args) as Employee[]
}

export async function assignCourseToEmployee(deps: LearningDeps, course: Course, employee: Employee, now: Date): Promise<CourseAssignment | null> {
  const a = createCourseAssignment(deps.db, {
    course_id: course.id, employee_id: employee.id, assigned_at: now.toISOString(), due_at: courseDueAt(now, course.due_days),
  })
  if (!a) return null
  if (employee.telegram_id !== null) {
    await deps.notifier.toEmployee(
      employee.telegram_id,
      `Новый курс: «${course.title}». Срок: до ${formatLocal(new Date(a.due_at), deps.tz, now)}`,
      { keyboard: continueCourseKeyboard(a.id) },
    )
  }
  return a
}

export async function assignCourse(deps: LearningDeps, course: Course, now: Date, onlyNew: boolean): Promise<number> {
  let count = 0
  for (const e of eligibleForCourse(deps.db, course, onlyNew)) {
    if (await assignCourseToEmployee(deps, course, e, now)) count++
  }
  return count
}

export async function issueQuiz(deps: LearningDeps, quiz: Quiz, slotAt: Date, now: Date): Promise<number> {
  const employees = deps.db
    .prepare(
      `select ${employeeCols} from employees e join quiz_positions qp on qp.position_id = e.position_id and qp.quiz_id = ?
       where e.status = 'active' order by e.full_name`,
    )
    .all(quiz.id) as Employee[]
  const due = new Date(slotAt.getTime() + (quiz.deadline_minutes ?? 480) * 60_000)
  let count = 0
  for (const e of employees) {
    const a = createQuizAssignment(deps.db, {
      quiz_id: quiz.id, employee_id: e.id, course_assignment_id: null,
      slot_at: slotAt.toISOString(), assigned_at: now.toISOString(), due_at: due.toISOString(),
    })
    if (!a) continue
    count++
    if (e.telegram_id !== null) {
      await deps.notifier.toEmployee(e.telegram_id, `Новый тест: «${quiz.title}». Срок: до ${formatLocal(due, deps.tz, now)}`, {
        keyboard: startQuizKeyboard(a.id),
      })
    }
  }
  return count
}
